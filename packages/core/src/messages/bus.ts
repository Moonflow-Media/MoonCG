import { MoonCGError, type Timers } from '../errors.js';
import { type Json, jsonProblem } from '../json.js';
import { NAMESPACE_SEPARATOR } from '../names.js';
import { bundlePermission, type PrincipalKind } from '../permissions/authorize.js';
import { qualifyReplicantName } from '../replicant/registry.js';

/** How long `request` waits for an answer unless the caller says otherwise. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
/** The longest a caller may ask `request` to wait. */
export const MAX_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Who sent a message: the principal's id (`user:<id>`, `token:<id>`, `extension:<bundle>`),
 * what kind of principal that is, and the bundle its connection belongs to.
 */
export type Sender = {
  readonly principal: string;
  readonly kind: PrincipalKind;
  readonly bundle: string;
};

export interface Topic {
  readonly bundle: string;
  readonly sendPermission: string;
  readonly listenPermission: string;
}

export type MessageListener = (data: Json, sender: Sender) => void;
/**
 * Answers a request. `onAbandon` registers what to do if the bus stops waiting for the answer
 * (timeout, or the handler was removed), so the handler can drop what it holds for it.
 */
export type RequestHandler = (
  data: Json,
  sender: Sender,
  onAbandon: (listener: () => void) => void,
) => Promise<Json>;

export interface MessageBusOptions {
  readonly timers: Timers;
  /** Receives what a listener threw. */
  readonly onError?: (error: unknown) => void;
}

interface TopicState extends Topic {
  readonly listeners: Map<MessageListener, (() => void) | undefined>;
  handler: RequestHandler | undefined;
  /** Rejects the requests the current handler has not answered yet. */
  readonly open: Set<(error: MoonCGError) => void>;
}

/**
 * Messages between everything connected to the server. A topic is declared by a bundle's
 * manifest and named `bundle:name`. `publish` reaches every subscriber of that one topic;
 * `request` asks its single handler and waits for the answer. The bus does not check
 * permissions: whoever calls it does, with the permissions the topic carries.
 */
export class MessageBus {
  readonly #topics = new Map<string, TopicState>();
  readonly #options: MessageBusOptions;

  constructor(options: MessageBusOptions) {
    this.#options = options;
  }

  /** `send` and `listen` are permission names from the bundle manifest. */
  declare(
    bundle: string,
    name: string,
    permissions: { readonly send?: string | undefined; readonly listen?: string | undefined },
  ): Topic {
    const key = qualifyReplicantName(name, bundle);
    if (this.#topics.has(key)) throw new Error(`Message "${key}" is already declared`);
    const topic: TopicState = {
      bundle,
      sendPermission: bundlePermission(bundle, permissions.send),
      listenPermission: bundlePermission(bundle, permissions.listen),
      listeners: new Map(),
      handler: undefined,
      open: new Set(),
    };
    this.#topics.set(key, topic);
    return topic;
  }

  get(qualifiedName: string): Topic | undefined {
    return this.#topics.get(qualifiedName);
  }

  /** Removes a bundle's topics. Subscribers are told, and open requests fail as unavailable. */
  undeclare(bundle: string): void {
    const prefix = `${bundle}${NAMESPACE_SEPARATOR}`;
    for (const [key, topic] of [...this.#topics]) {
      if (!key.startsWith(prefix)) continue;
      this.#topics.delete(key);
      this.#failOpen(topic, key);
      for (const onRemoved of topic.listeners.values()) this.#guard(() => onRemoved?.());
    }
  }

  /** `onRemoved` runs if the topic is removed while the subscription lasts. */
  subscribe(qualifiedName: string, listener: MessageListener, onRemoved?: () => void): () => void {
    const topic = this.#topic(qualifiedName);
    topic.listeners.set(listener, onRemoved);
    return () => {
      topic.listeners.delete(listener);
    };
  }

  /** Delivers `data` to every subscriber of the topic. */
  publish(qualifiedName: string, data: Json, sender: Sender): void {
    const topic = this.#topic(qualifiedName);
    assertJson(data);
    for (const listener of [...topic.listeners.keys()]) this.#guard(() => listener(data, sender));
  }

  /** Makes `handler` the one that answers requests on the topic, until the returned call. */
  handle(qualifiedName: string, handler: RequestHandler): () => void {
    const topic = this.#topic(qualifiedName);
    if (topic.handler) {
      throw new MoonCGError('conflict', `Message "${qualifiedName}" already has a handler`);
    }
    topic.handler = handler;
    return () => {
      if (topic.handler !== handler) return;
      topic.handler = undefined;
      this.#failOpen(topic, qualifiedName);
    };
  }

  /**
   * Asks the topic's handler. Rejects with `not_found` without a handler, `timeout` when no
   * answer comes in time, `unavailable` when the handler goes away first, the handler's own
   * `MoonCGError`, or `internal` for anything else it throws.
   */
  async request(
    qualifiedName: string,
    data: Json,
    sender: Sender,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Json> {
    const topic = this.#topic(qualifiedName);
    assertJson(data);
    const { handler } = topic;
    if (!handler) {
      throw new MoonCGError('not_found', `Nobody handles requests for "${qualifiedName}"`);
    }
    const { timers } = this.#options;
    return new Promise<Json>((resolve, reject) => {
      const abandoned: (() => void)[] = [];
      let answered = false;
      const settle = (finish: () => void) => {
        if (!topic.open.delete(fail)) return;
        timers.clearTimeout(timer);
        if (!answered) for (const listener of abandoned) this.#guard(listener);
        finish();
      };
      const fail = (error: MoonCGError) => settle(() => reject(error));
      const timer = timers.setTimeout(
        () => fail(new MoonCGError('timeout', `No answer to "${qualifiedName}" in time`)),
        Math.min(Math.max(timeoutMs, 0), MAX_REQUEST_TIMEOUT_MS),
      );
      topic.open.add(fail);
      // The handler runs after the request is registered, so even a synchronous throw is caught.
      Promise.resolve()
        .then(() => handler(data, sender, (listener) => abandoned.push(listener)))
        .then(
          (answer) => {
            answered = true;
            const problem = jsonProblem(answer);
            if (problem === null) settle(() => resolve(answer));
            else fail(new MoonCGError('internal', `The handler's answer is not JSON: ${problem}`));
          },
          (error) => {
            answered = true;
            fail(
              error instanceof MoonCGError
                ? error
                : new MoonCGError('internal', `The handler of "${qualifiedName}" failed`),
            );
          },
        );
    });
  }

  /** How much is registered on the bus right now. */
  stats(): { topics: number; listeners: number; handlers: number; requests: number } {
    const topics = [...this.#topics.values()];
    return {
      topics: topics.length,
      listeners: topics.reduce((sum, topic) => sum + topic.listeners.size, 0),
      handlers: topics.filter((topic) => topic.handler).length,
      requests: topics.reduce((sum, topic) => sum + topic.open.size, 0),
    };
  }

  #topic(qualifiedName: string): TopicState {
    const topic = this.#topics.get(qualifiedName);
    if (!topic) throw new MoonCGError('not_found', `Message "${qualifiedName}" is not declared`);
    return topic;
  }

  #failOpen(topic: TopicState, name: string): void {
    const gone = new MoonCGError('unavailable', `The handler of "${name}" went away`);
    for (const fail of [...topic.open]) fail(gone);
  }

  #guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      try {
        this.#options.onError?.(error);
      } catch {
        // An error reporter that throws has nowhere left to report to.
      }
    }
  }
}

function assertJson(data: unknown): void {
  const problem = jsonProblem(data);
  if (problem !== null) throw new MoonCGError('bad_request', `Invalid message data: ${problem}`);
}
