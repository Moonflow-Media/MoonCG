import {
  applyPatches,
  BUNDLE_NAME_PATTERN,
  type ClientMessage,
  decodeServerMessage,
  deepFreeze,
  encodeMessage,
  type HttpMethod,
  type HttpRequestData,
  type HttpResponseData,
  type Json,
  jsonProblem,
  MoonCGError,
  PROTOCOL_VERSION,
  qualifyReplicantName,
  type ReplicantHandle,
  type ReplicantMeta,
  type ReplicantOp,
  type Sender,
  type ServerMessage,
  updateWithRetry,
} from '@mooncg/core';

/** The part of the WebSocket API the client uses. Browser and Node 22 `WebSocket` both fit. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export interface ClientOptions {
  /** The bundle this client belongs to. Defaults to the `/b/<bundle>/…` part of the page URL. */
  bundle?: string;
  /** The server's WebSocket URL. Defaults to `/ws` on the page's host. */
  url?: string;
  /** Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => SocketLike;
  /** How long to wait before reconnecting after the socket drops. Defaults to 1000. */
  reconnectDelayMs?: number;
}

/**
 * Maps replicant names to their value types. It is empty here; `mooncg types` generates a
 * `mooncg-env.d.ts` that fills it in for a bundle, so `mc.replicant('score')` is typed.
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled in by declaration merging
export interface ReplicantMap {}

/** What a message listener or request handler is told besides the data. */
export interface MessageMeta {
  readonly sender: Sender;
}

export type MessageListener = (data: Json, meta: MessageMeta) => void;

export interface RequestOptions {
  /** Milliseconds to wait for the answer. The server default is 5000. */
  readonly timeout?: number;
}

/** What pages and extensions share: replicants and messages. Names may be `other-bundle:name`. */
export interface Messaging {
  /**
   * `name` is a replicant of this client's bundle, or `other-bundle:name`. A name listed in
   * `ReplicantMap` gets its type from there; any other name takes the type as `T`.
   */
  replicant<K extends keyof ReplicantMap>(name: K): ReplicantHandle<ReplicantMap[K]>;
  replicant<T = unknown>(name: string): ReplicantHandle<T>;
  /** Sends a message to everyone listening to it. Resolves when the server took it. */
  send(name: string, data?: Json): Promise<void>;
  /** Listens to a message. Resolves, once the server agreed, with the function that stops it. */
  on(name: string, listener: MessageListener): Promise<() => void>;
  /**
   * Asks the one handler of a message and resolves with its answer. Rejects with `not_found`
   * if nobody handles it, `timeout` if no answer comes in time, `unavailable` if the handler
   * goes away first, or the error the handler raised.
   */
  request(name: string, data?: Json, options?: RequestOptions): Promise<Json>;
}

export interface MoonCGClient extends Messaging {
  readonly bundle: string;
  /** Resolves after the first successful handshake. Rejects on a protocol mismatch. */
  readonly ready: Promise<void>;
  /** Closes the socket for good. */
  close(): void;
}

export type RequestHandler = (data: Json, meta: MessageMeta) => Json | Promise<Json>;
export type RouteHandler = (request: HttpRequestData) => Promise<HttpResponseData>;

/**
 * A client with the parts only a bundle's extension may use. The server refuses them to
 * anyone else, so pages get the plain `MoonCGClient` from `createClient`.
 */
export interface Connection extends MoonCGClient {
  /** Becomes the handler of a message of the own bundle. Resolves with the function to stop. */
  handle(name: string, handler: RequestHandler): Promise<() => void>;
  /** Registers an HTTP route. `permission` is a permission name from the bundle manifest. */
  route(
    method: HttpMethod,
    pattern: string,
    handler: RouteHandler,
    permission?: string,
  ): Promise<void>;
  /**
   * Asks the server whether a principal holds a permission of the own bundle, named as in
   * the bundle manifest.
   */
  checkPermission(principal: string, permission: string): Promise<boolean>;
}

export interface ConnectionOptions extends ClientOptions {
  /** Receives what a handler threw. Defaults to `console.error`. */
  onError?: (message: string, error: unknown) => void;
}

/** Extracts the bundle name from the path of a page served under `/b/<bundle>/…`. */
export function bundleFromPath(pathname: string): string | undefined {
  const name = /^\/b\/([^/]+)\//.exec(pathname)?.[1];
  return name !== undefined && BUNDLE_NAME_PATTERN.test(name) ? name : undefined;
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: MoonCGError): void;
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: MoonCGError) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody has to await `ready`; a rejection must not surface as an unhandled one.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface ReplicantState {
  readonly handle: ReplicantHandle<unknown>;
  readonly ready: Deferred;
  readonly listeners: Set<(value: unknown, meta: ReplicantMeta) => void>;
  loaded: boolean;
  value: Json | undefined;
  rev: number;
  /** The replicant instance `rev` belongs to. */
  epoch: string | undefined;
  error: MoonCGError | undefined;
  readonly errorListeners: Set<() => void>;
  /** The local copy cannot be trusted; only a full snapshot puts it right. */
  resync: boolean;
}

interface TopicState {
  readonly listeners: Set<MessageListener>;
  /** Settles when the server has answered the subscription. */
  subscribed: Promise<unknown>;
}

/** Connects a page to the server. */
export function createClient(options: ClientOptions = {}): MoonCGClient {
  const { bundle, ready, replicant, send, on, request, close } = createConnection(options);
  return { bundle, ready, replicant, send, on, request, close };
}

export function createConnection(options: ConnectionOptions = {}): Connection {
  const page = typeof location === 'undefined' ? undefined : location;
  const bundle = options.bundle ?? (page && bundleFromPath(page.pathname));
  if (!bundle) {
    throw new Error('MoonCG: unknown bundle. Pass { bundle } or load the page from /b/<bundle>/.');
  }
  const url =
    options.url ?? (page && `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}/ws`);
  if (!url) throw new Error('MoonCG: unknown server. Pass { url } when not running in a page.');
  const createSocket = options.createSocket ?? ((target) => new WebSocket(target));
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const report =
    options.onError ??
    ((message: string, error: unknown) => console.error(`MoonCG: ${message}`, error));

  const ready = defer();
  const replicants = new Map<string, ReplicantState>();
  const pendingSubs = new Map<number, ReplicantState>();
  /** Requests waiting for the server's answer, by request id. */
  const pending = new Map<number, Deferred<unknown>>();
  const topics = new Map<string, TopicState>();
  const handlers = new Map<string, RequestHandler>();
  const routes = new Map<number, RouteHandler>();
  let socket: SocketLike | undefined;
  let connected = false;
  /** Set once the client is down for good: closed by the caller or refused by the server. */
  let stopError: MoonCGError | undefined;
  let nextId = 1;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: ClientMessage) => socket?.send(encodeMessage(msg));

  /** Ends the client. Everything still waiting for the server is rejected with `error`. */
  const stop = (error: MoonCGError) => {
    if (stopError) return;
    stopError = error;
    connected = false;
    clearTimeout(reconnectTimer);
    ready.reject(error);
    for (const state of replicants.values()) state.ready.reject(error);
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    pendingSubs.clear();
    socket?.close();
  };

  /** Sends a request and settles with the server's answer to it. */
  const ask = <T = void>(build: (id: number) => ClientMessage): Promise<T> => {
    if (!connected) {
      return Promise.reject(
        stopError ?? new MoonCGError('disconnected', 'Not connected to the server'),
      );
    }
    const id = nextId++;
    const waiting = defer<unknown>();
    pending.set(id, waiting);
    send(build(id));
    return waiting.promise as Promise<T>;
  };

  const settle = (id: number, value: unknown) => {
    pending.get(id)?.resolve(value);
    pending.delete(id);
  };

  const subscribe = (name: string, state: ReplicantState) => {
    const id = nextId++;
    pendingSubs.set(id, state);
    // Telling the server what is already here lets it send only the missed patches. Not when
    // the local copy is in doubt: a replay would only repeat what went wrong.
    const known =
      state.loaded && state.epoch !== undefined && state.error === undefined && !state.resync;
    send(
      known
        ? { t: 'rep.sub', id, name, since: { epoch: state.epoch as string, rev: state.rev } }
        : { t: 'rep.sub', id, name },
    );
  };

  /** Drops the local copy's claim to be in step and asks the server for the whole value. */
  const resync = (name: string, state: ReplicantState) => {
    state.resync = true;
    subscribe(name, state);
  };

  const setError = (state: ReplicantState, error: MoonCGError | undefined) => {
    if (state.error === error) return;
    state.error = error;
    for (const listener of [...state.errorListeners]) {
      try {
        listener();
      } catch (failure) {
        report(`an error listener of "${state.handle.name}" failed`, failure);
      }
    }
  };

  /** One failing subscriber must not keep the others, or the socket handler, from running. */
  const notify = (state: ReplicantState) => {
    for (const listener of [...state.listeners]) {
      try {
        listener(state.value, { rev: state.rev });
      } catch (error) {
        report(`a subscriber of "${state.handle.name}" failed`, error);
      }
    }
  };

  const submit = (name: string, op: ReplicantOp): Promise<void> =>
    ask((id) => ({ t: 'rep.op', id, name, ...op }));

  /** Runs an extension's handler for a call from the server and sends back the outcome. */
  const answer = (call: number, what: string, run: (() => unknown) | undefined) => {
    if (!run) {
      send({ t: 'call.err', call, code: 'not_found', message: `Nothing handles ${what}` });
      return;
    }
    Promise.resolve()
      .then(run)
      .then((result) => {
        // A handler that returns nothing answers null: `undefined` cannot travel as JSON.
        const data = result === undefined ? null : result;
        const problem = jsonProblem(data);
        if (problem !== null)
          throw new Error(`The handler returned something unusable: ${problem}`);
        send({ t: 'call.ok', call, data: data as Json });
      })
      .catch((error) => {
        if (error instanceof MoonCGError && error.code !== 'disconnected') {
          send({ t: 'call.err', call, code: error.code, message: error.message });
          return;
        }
        report(`the handler of ${what} failed`, error);
        send({ t: 'call.err', call, code: 'internal', message: `The handler of ${what} failed` });
      });
  };

  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'welcome':
        if (msg.v !== PROTOCOL_VERSION) {
          stop(
            new MoonCGError(
              'bad_request',
              `Server speaks protocol ${msg.v}, this client ${PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        connected = true;
        ready.resolve();
        for (const [name, state] of replicants) subscribe(name, state);
        for (const [name, topic] of topics) {
          topic.subscribed = ask((id) => ({ t: 'msg.sub', id, name })).catch((error) => {
            topics.delete(name);
            report(`could not listen to "${name}" again`, error);
          });
        }
        return;
      case 'rep.snap': {
        const state = replicants.get(msg.name);
        if (!state) return;
        pendingSubs.delete(msg.id);
        // A snapshot with the value already held (after a server restart, say) keeps the
        // object and tells nobody, so nothing re-renders for a change that is none.
        const sameValue = state.loaded && JSON.stringify(state.value) === JSON.stringify(msg.value);
        state.epoch = msg.epoch;
        state.rev = msg.rev;
        state.resync = false;
        setError(state, undefined);
        if (sameValue) return;
        state.value = deepFreeze(msg.value);
        state.loaded = true;
        state.ready.resolve();
        notify(state);
        return;
      }
      case 'rep.patch': {
        const state = replicants.get(msg.name);
        if (!state?.loaded || state.resync || msg.rev <= state.rev) return;
        if (msg.rev !== state.rev + 1) {
          resync(msg.name, state);
          return;
        }
        try {
          state.value = deepFreeze(applyPatches(state.value as Json, msg.patches));
        } catch {
          // The local copy no longer matches the server's: start over from a snapshot.
          resync(msg.name, state);
          return;
        }
        state.rev = msg.rev;
        notify(state);
        return;
      }
      case 'rep.gone': {
        const state = replicants.get(msg.name);
        if (!state) return;
        const error = new MoonCGError('not_found', msg.message);
        setError(state, error);
        state.ready.reject(error);
        return;
      }
      case 'msg':
        for (const listener of [...(topics.get(msg.name)?.listeners ?? [])]) {
          try {
            listener(msg.data, { sender: msg.sender });
          } catch (error) {
            report(`a listener of "${msg.name}" failed`, error);
          }
        }
        return;
      case 'msg.gone':
        // The server ended the subscription; a reconnect must not ask for it again.
        topics.delete(msg.name);
        console.warn(`MoonCG: ${msg.message}`);
        return;
      case 'msg.call': {
        const handler = handlers.get(msg.name);
        answer(
          msg.call,
          `"${msg.name}"`,
          handler && (() => handler(msg.data, { sender: msg.sender })),
        );
        return;
      }
      case 'http.call': {
        const handler = routes.get(msg.route);
        answer(msg.call, 'the route', handler && (() => handler(msg.request)));
        return;
      }
      case 'ack':
        // Answers an op, or a subscription that was brought up to date with patches.
        pendingSubs.delete(msg.id);
        settle(msg.id, undefined);
        return;
      case 'ok':
        settle(msg.id, undefined);
        return;
      case 'msg.res':
        settle(msg.id, msg.data);
        return;
      case 'perm.res':
        settle(msg.id, msg.allowed);
        return;
      case 'err': {
        const error = new MoonCGError(msg.code, msg.message);
        if (msg.id === undefined) {
          // Before the handshake completes, an error without a request id refuses the hello.
          if (!connected) stop(error);
          return;
        }
        const refused = pendingSubs.get(msg.id);
        if (refused) {
          setError(refused, error);
          refused.ready.reject(error);
          pendingSubs.delete(msg.id);
        }
        pending.get(msg.id)?.reject(error);
        pending.delete(msg.id);
      }
    }
  };

  const connect = () => {
    const current = createSocket(url);
    socket = current;
    current.addEventListener('open', () => {
      send({ t: 'hello', v: PROTOCOL_VERSION, bundle });
    });
    current.addEventListener('message', (event) => {
      const decoded = decodeServerMessage(String(event.data));
      if (decoded.ok) onMessage(decoded.msg);
      else console.warn(`MoonCG: ignoring a malformed server message (${decoded.error.message})`);
    });
    current.addEventListener('close', () => {
      connected = false;
      pendingSubs.clear();
      const dropped = new MoonCGError('disconnected', 'The connection to the server was lost');
      for (const waiting of pending.values()) waiting.reject(dropped);
      pending.clear();
      if (!stopError) reconnectTimer = setTimeout(connect, reconnectDelayMs);
    });
  };

  const createState = (name: string): ReplicantState => {
    const state: ReplicantState = {
      ready: defer(),
      listeners: new Set(),
      loaded: false,
      value: undefined,
      rev: 0,
      epoch: undefined,
      error: undefined,
      errorListeners: new Set(),
      resync: false,
      handle: {
        name,
        get ready() {
          return state.ready.promise;
        },
        get value() {
          return state.value;
        },
        get error() {
          return state.error;
        },
        onErrorChange(listener) {
          state.errorListeners.add(listener);
          return () => {
            state.errorListeners.delete(listener);
          };
        },
        subscribe(listener) {
          state.listeners.add(listener);
          if (state.loaded) listener(state.value, { rev: state.rev });
          return () => {
            state.listeners.delete(listener);
          };
        },
        async set(next) {
          await state.ready.promise;
          if (state.error) throw state.error;
          await submit(name, { patches: [{ op: 'replace', path: '', value: next as Json }] });
        },
        async update(recipe) {
          await state.ready.promise;
          if (state.error) throw state.error;
          await updateWithRetry(
            () => ({ value: state.value, rev: state.rev }),
            (op) => submit(name, op),
            recipe,
          );
        },
      },
    };
    return state;
  };

  connect();

  return {
    bundle,
    ready: ready.promise,
    replicant(name: string) {
      const qualified = qualifyReplicantName(name, bundle);
      let state = replicants.get(qualified);
      if (!state) {
        state = createState(qualified);
        replicants.set(qualified, state);
        if (stopError) state.ready.reject(stopError);
        else if (connected) subscribe(qualified, state);
      }
      return state.handle as ReplicantHandle<never>;
    },
    async send(name, data = null) {
      await ready.promise;
      await ask((id) => ({ t: 'msg.send', id, name: qualifyReplicantName(name, bundle), data }));
    },
    async on(name, listener) {
      await ready.promise;
      const qualified = qualifyReplicantName(name, bundle);
      let topic = topics.get(qualified);
      if (!topic) {
        topic = {
          listeners: new Set(),
          subscribed: ask((id) => ({ t: 'msg.sub', id, name: qualified })),
        };
        topics.set(qualified, topic);
      }
      const current = topic;
      current.listeners.add(listener);
      const forget = () => {
        current.listeners.delete(listener);
        if (current.listeners.size > 0 || topics.get(qualified) !== current) return false;
        topics.delete(qualified);
        return true;
      };
      try {
        await current.subscribed;
      } catch (error) {
        forget();
        throw error;
      }
      return () => {
        // Telling the server is best effort: a dropped connection has ended it anyway.
        if (forget()) ask((id) => ({ t: 'msg.unsub', id, name: qualified })).catch(() => {});
      };
    },
    async request(name, data = null, requestOptions = {}) {
      await ready.promise;
      const qualified = qualifyReplicantName(name, bundle);
      const { timeout } = requestOptions;
      return ask<Json>((id) =>
        timeout === undefined
          ? { t: 'msg.req', id, name: qualified, data }
          : { t: 'msg.req', id, name: qualified, data, timeout },
      );
    },
    async handle(name, handler) {
      await ready.promise;
      const qualified = qualifyReplicantName(name, bundle);
      await ask((id) => ({ t: 'msg.handle', id, name: qualified }));
      handlers.set(qualified, handler);
      return () => {
        if (handlers.get(qualified) !== handler) return;
        handlers.delete(qualified);
        ask((id) => ({ t: 'msg.unhandle', id, name: qualified })).catch(() => {});
      };
    },
    async route(method, pattern, handler, permission) {
      await ready.promise;
      let route = 0;
      await ask((id) => {
        route = id;
        return permission === undefined
          ? { t: 'http.route', id, method, pattern }
          : { t: 'http.route', id, method, pattern, permission };
      });
      routes.set(route, handler);
    },
    async checkPermission(principal, permission) {
      await ready.promise;
      return ask<boolean>((id) => ({ t: 'perm.check', id, principal, permission }));
    },
    close: () => stop(new MoonCGError('disconnected', 'The client was closed')),
  };
}
