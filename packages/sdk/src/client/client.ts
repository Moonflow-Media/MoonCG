import {
  applyPatches,
  BUNDLE_NAME_PATTERN,
  type ClientMessage,
  decodeServerMessage,
  deepFreeze,
  encodeMessage,
  type GraphicEndReason,
  type HttpMethod,
  type HttpRequestData,
  type HttpResponseData,
  isSafeRelativePath,
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
import { createDialogs, type Dialogs } from './dialogs.js';

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
  /**
   * The graphic this page is, as its file inside the bundle (`graphics/overlay.html`).
   * Defaults to the `/b/<bundle>/graphics/…` part of the page URL, so a graphic need not say
   * it. The server lists the page as a connected instance of that graphic.
   */
  graphic?: string | undefined;
  /**
   * Called with `true` when the server refuses this page because its graphic takes a single
   * instance and is open somewhere else, and with `false` once the page got the place after
   * all. Until then nothing loads. By default the page shows a notice instead.
   */
  onDuplicate?: (duplicate: boolean) => void;
  /**
   * Called when the server ends this page as the instance of its graphic: `replaced` when
   * the same account opened the graphic again somewhere, `disconnected` when an operator
   * took the place away. The client is closed then and does not connect again; reload the
   * page to ask for the place anew. By default the page shows a notice.
   */
  onEnded?: (reason: GraphicEndReason) => void;
  /** How long a refused duplicate waits before it asks again. Defaults to 3000. */
  duplicateRetryMs?: number;
  /**
   * What happens when the server says that the bundle is not running. By default the client
   * waits for it and keeps asking, ever more slowly up to every 15 seconds: a bundle that is
   * reloaded is back within moments, and its pages go on by themselves. With `false` the
   * client gives up at once and `ready` rejects with `not_found`.
   */
  waitForBundle?: boolean;
  /**
   * What the page does when the server asks it to reload: a graphic an operator reloads, or
   * any page of a bundle whose files changed while the server watches them. Defaults to
   * reloading the page.
   */
  reloadPage?: () => void;
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

/**
 * Where the connection to the server stands: `live` once the handshake is done,
 * `reconnecting` while there is no connection but the client keeps trying (also before the
 * first one, and for a graphic that waits for its place), `offline` once the client is down
 * for good: closed, refused by the server, or ended as the instance of its graphic.
 */
export type ConnectionStatus = 'live' | 'reconnecting' | 'offline';

export interface MoonCGClient extends Messaging {
  readonly bundle: string;
  /** Resolves after the first successful handshake. Rejects on a protocol mismatch. */
  readonly ready: Promise<void>;
  /** Where the connection stands right now. */
  readonly status: ConnectionStatus;
  /**
   * Calls `listener` whenever `status` changes, with the new one. It is not called for the
   * status at the time of asking; read `status` for that. Returns the function that stops it.
   */
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
  /**
   * Dialogs of this page's bundle, shown over the dashboard. They need no connection to the
   * server, only the dashboard around the page.
   */
  readonly dialogs: Dialogs;
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

/**
 * The file of the graphic a page served under `/b/<bundle>/graphics/…` is, as a manifest
 * names it. `undefined` for every other page.
 */
export function graphicFromPath(pathname: string): string | undefined {
  const rest = /^\/b\/[^/]+\/(graphics\/.+)$/.exec(pathname)?.[1];
  if (rest === undefined) return undefined;
  try {
    const file = rest.split('/').map(decodeURIComponent).join('/');
    return isSafeRelativePath(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

const DUPLICATE_NOTICE_ID = 'mooncg-duplicate';

/** The longest a page waits before it asks again for a bundle that is not running. */
export const ABSENT_RETRY_MAX_MS = 15_000;

const ENDED_NOTICE_ID = 'mooncg-ended';
const ENDED_TEXT: Readonly<Record<GraphicEndReason, string>> = {
  replaced:
    'This graphic was opened again somewhere else by the same account, and takes one ' +
    'instance. Reload this page to bring it back here.',
  disconnected: 'This graphic was disconnected by an operator. Reload this page to connect again.',
};

/** Covers the page with a notice that this graphic is open elsewhere, or takes it away. */
function showDuplicateNotice(duplicate: boolean): void {
  showNotice(
    DUPLICATE_NOTICE_ID,
    duplicate
      ? 'This graphic is already open somewhere else and takes one instance. ' +
          'This page shows it as soon as the other one is closed.'
      : undefined,
  );
}

/** Covers the page with a notice, or takes the one with that id away. */
function showNotice(id: string, text: string | undefined): void {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.remove();
  if (text === undefined) return;
  const notice = document.createElement('div');
  notice.id = id;
  notice.setAttribute('role', 'alert');
  notice.textContent = text;
  // Set as properties, which a page's Content-Security-Policy does not count as inline style.
  Object.assign(notice.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '32px',
    background: '#101218',
    color: '#fff',
    font: '24px system-ui, sans-serif',
    textAlign: 'center',
  });
  (document.body ?? document.documentElement).append(notice);
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  /** Whether the promise was rejected. One that was can never be resolved after all. */
  readonly rejected: boolean;
  resolve(value: T): void;
  reject(error: MoonCGError): void;
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: MoonCGError) => void;
  let settled = false;
  let rejected = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody has to await `ready`; a rejection must not surface as an unhandled one.
  promise.catch(() => {});
  return {
    promise,
    get rejected() {
      return rejected;
    },
    resolve(value) {
      settled = true;
      resolve(value);
    },
    reject(error) {
      if (!settled) rejected = true;
      settled = true;
      reject(error);
    },
  };
}

interface ReplicantState {
  readonly handle: ReplicantHandle<unknown>;
  /** Replaced by a fresh one when a replicant that was refused is asked for again. */
  ready: Deferred;
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
  const connection = createConnection(options);
  const { bundle, ready, dialogs, replicant, send, on, request, onStatusChange, close } =
    connection;
  return {
    bundle,
    ready,
    dialogs,
    replicant,
    send,
    on,
    request,
    get status() {
      return connection.status;
    },
    onStatusChange,
    close,
  };
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
  const duplicateRetryMs = options.duplicateRetryMs ?? 3000;
  const waitForBundle = options.waitForBundle ?? true;
  const graphic =
    'graphic' in options
      ? options.graphic
      : page && bundleFromPath(page.pathname) === bundle
        ? graphicFromPath(page.pathname)
        : undefined;
  const onDuplicate = options.onDuplicate ?? showDuplicateNotice;
  const onEnded =
    options.onEnded ??
    ((reason: GraphicEndReason) => showNotice(ENDED_NOTICE_ID, ENDED_TEXT[reason]));
  const reloadPage = options.reloadPage ?? (() => page?.reload());
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
  /** The server refused this page as a second instance of its graphic; it keeps asking. */
  let duplicate = false;
  /**
   * How often in a row the server said that the bundle is not running. The page keeps
   * asking, ever more slowly: a bundle that is reloaded is back within moments.
   */
  let absent = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let status: ConnectionStatus = 'reconnecting';
  const statusListeners = new Set<(status: ConnectionStatus) => void>();

  /** Tells the listeners, when the status is another one than before. */
  const setStatus = (next: ConnectionStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of [...statusListeners]) {
      try {
        listener(next);
      } catch (failure) {
        report('a status listener failed', failure);
      }
    }
  };

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
    setStatus('offline');
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
    // A `ready` that was rejected cannot resolve; whoever asks from now on gets one that can.
    if (state.ready.rejected) state.ready = defer();
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
        absent = 0;
        if (duplicate) {
          duplicate = false;
          onDuplicate(false);
        }
        ready.resolve();
        setStatus('live');
        for (const [name, state] of replicants) subscribe(name, state);
        for (const [name, topic] of topics) listenAgain(name, topic);
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
        if (sameValue) {
          state.ready.resolve();
          return;
        }
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
      case 'rep.back': {
        // Declared again, as after its bundle was restarted: asked for like the first time.
        const state = replicants.get(msg.name);
        if (state && connected) subscribe(msg.name, state);
        return;
      }
      case 'msg.back': {
        const topic = topics.get(msg.name);
        if (topic && connected) listenAgain(msg.name, topic);
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
      case 'reload':
        reloadPage();
        return;
      case 'graphic.end': {
        // Not asked for again: two pages of one account would take the place from each
        // other for ever, and a page an operator disconnected would be back at once.
        const error = new MoonCGError('conflict', ENDED_TEXT[msg.reason]);
        for (const state of replicants.values()) setError(state, error);
        stop(error);
        onEnded(msg.reason);
        return;
      }
      case 'msg.gone':
        // The server ended the subscription. The listeners stay: the server says when the
        // topic is back, and it is asked for again then, or at the next reconnect.
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
          if (connected) return;
          if (msg.code === 'conflict' && graphic !== undefined) {
            // Refused as a duplicate, which ends when the other instance does: ask again.
            if (!duplicate) onDuplicate(true);
            duplicate = true;
            socket?.close();
          } else if (msg.code === 'not_found' && waitForBundle) {
            // The bundle is not running, which a reload of it ends by itself: ask again.
            if (absent === 0) console.warn(`MoonCG: ${msg.message}. Waiting for it.`);
            absent++;
            socket?.close();
          } else stop(error);
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
      send(
        graphic === undefined
          ? { t: 'hello', v: PROTOCOL_VERSION, bundle }
          : { t: 'hello', v: PROTOCOL_VERSION, bundle, graphic },
      );
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
      if (stopError) return;
      setStatus('reconnecting');
      const delay = duplicate
        ? duplicateRetryMs
        : absent > 0
          ? Math.min(reconnectDelayMs * 2 ** Math.min(absent - 1, 10), ABSENT_RETRY_MAX_MS)
          : reconnectDelayMs;
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  /**
   * Asks the server for a topic the page listened to before. A topic that is not declared
   * right now is kept: the server says when it is back. One the server refuses is given up.
   */
  const listenAgain = (name: string, topic: TopicState) => {
    topic.subscribed = ask((id) => ({ t: 'msg.sub', id, name })).catch((error) => {
      const code = error instanceof MoonCGError ? error.code : undefined;
      if (code === 'not_found' || code === 'disconnected') return;
      if (topics.get(name) === topic) topics.delete(name);
      report(`could not listen to "${name}" again`, error);
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
    get status() {
      return status;
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    dialogs: createDialogs(),
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
