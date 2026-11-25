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
  MAX_PENDING_WRITES,
  MAX_UPDATE_RETRIES,
  MoonCGError,
  opForWrite,
  type PendingWrite,
  PROTOCOL_VERSION,
  qualifyReplicantName,
  type Recipe,
  type ReplicantHandle,
  type ReplicantMeta,
  type ReplicantOp,
  type RouteAnswer,
  rebaseWrites,
  type Sender,
  type ServerMessage,
  updateWithRetry,
} from '@mooncg/core';
import { createDialogs, type Dialogs } from './dialogs.js';
import { IncomingBodies, OutgoingBodies } from './http-streams.js';

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
  /**
   * What the page does when stylesheets of its bundle changed while the server watches its
   * files (`files` inside the bundle, such as `dashboard/control.css`). By default the
   * stylesheet links of the page that point at them are loaded again in place, and a page
   * that links none of them reloads itself with `reloadPage`.
   */
  restyle?: (files: readonly string[]) => void;
}

/**
 * Maps replicant names to their value types. It is empty here; `mooncg types` generates a
 * `mooncg-env.d.ts` that fills it in for a bundle, so `mc.replicant('score')` is typed.
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled in by declaration merging
export interface ReplicantMap {}

/** How this client keeps its copy of a replicant. */
export interface ClientReplicantOptions {
  /**
   * Shows writes at once instead of after the server confirmed them. Writes wait in order and
   * are sent one at a time; a write the server refuses is taken back, and the writes after it
   * are applied again on top of the server's value. The option holds for the replicant in this
   * client from the first time it is asked for: every handle of the name writes the same way.
   * See docs/bundles.md.
   */
  readonly optimistic?: boolean;
}

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
  replicant<K extends keyof ReplicantMap>(
    name: K,
    options?: ClientReplicantOptions,
  ): ReplicantHandle<ReplicantMap[K]>;
  replicant<T = unknown>(name: string, options?: ClientReplicantOptions): ReplicantHandle<T>;
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
/**
 * Handles a call of an HTTP route. `body` is the request body as a stream, for a route
 * registered with `stream`. An answer with `stream` sends its body piece by piece.
 */
export type RouteHandler = (
  request: HttpRequestData,
  body: ReadableStream<Uint8Array> | undefined,
) => Promise<HttpResponseData | RouteAnswer>;

/** How an HTTP route takes its request body. */
export interface RouteStreaming {
  /** The request body arrives as a stream instead of whole. */
  readonly stream?: boolean;
  /** How many bytes a streamed body may have, `null` for no limit. The server's by default. */
  readonly maxBytes?: number | null;
}

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
    streaming?: RouteStreaming,
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

/** The query parameter that makes the browser load a changed stylesheet again. */
const CSS_PARAMETER = 'mooncg-css';

/**
 * Loads the stylesheets of a bundle again whose files changed, by giving every
 * `<link rel="stylesheet">` that points at one of them a new cache-busting query parameter.
 * Answers `false`, and changes nothing, when one of the files is linked nowhere on the page,
 * or is pulled in with `@import` by a stylesheet of the page that can be read: an imported
 * file keeps its address, so only a reload of the page is sure to show it.
 */
export function swapStylesheets(
  bundle: string,
  files: readonly string[],
  stamp: number = Date.now(),
): boolean {
  if (typeof document === 'undefined') return false;
  const wanted = new Set(files.map((file) => `/b/${bundle}/${file}`));
  /** The path of a same-origin address that is one of the changed files, else `undefined`. */
  const changed = (href: string, base: string) => {
    try {
      const url = new URL(href, base);
      const path = decodeURIComponent(url.pathname);
      return url.origin === location.origin && wanted.has(path) ? { url, path } : undefined;
    } catch {
      return undefined;
    }
  };
  if (importsAny(document.styleSheets, changed)) return false;
  const matches: { link: HTMLLinkElement; url: URL }[] = [];
  const found = new Set<string>();
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')) {
    const match = changed(link.href, document.baseURI);
    if (!match) continue;
    matches.push({ link, url: match.url });
    found.add(match.path);
  }
  if (found.size < wanted.size) return false;
  for (const { link, url } of matches) {
    url.searchParams.set(CSS_PARAMETER, String(stamp));
    link.href = url.href;
  }
  return true;
}

/**
 * Whether one of the stylesheets, or one they import, imports a file `changed` accepts. A
 * stylesheet of another origin cannot be read and is skipped; it would not import one of the
 * bundle's files without that being visible elsewhere either. Imports deeper than a few levels
 * are not followed.
 */
function importsAny(
  sheets: Iterable<CSSStyleSheet>,
  changed: (href: string, base: string) => unknown,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules) as Partial<CSSImportRule>[]) {
      // An `@import` rule, told by its shape: it has an address and the sheet it brings in.
      if (typeof rule.href !== 'string' || !('styleSheet' in rule)) continue;
      if (changed(rule.href, sheet.href ?? document.baseURI)) return true;
      if (rule.styleSheet && importsAny([rule.styleSheet], changed, depth + 1)) return true;
    }
  }
  return false;
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
  /** Asked the server for the replicant and waits for the answer. */
  subscribing: boolean;
  /** Writes are shown before the server confirms them. */
  optimistic: boolean;
  /**
   * Optimistic only: the value the server confirmed, at `rev`. `value` is this value with
   * `writes` applied on top.
   */
  server: Json | undefined;
  /** Optimistic only: the writes the server has not confirmed yet, oldest first. */
  readonly writes: QueuedWrite[];
  /**
   * Optimistic only: the request id of the first write while the server has it and has not
   * answered, `UNCERTAIN` when that answer was lost with the connection, `undefined` when no
   * write is out.
   */
  inFlight: number | undefined;
}

interface QueuedWrite {
  /** Replaced by a later `set` while it waits; see `enqueue`. */
  write: PendingWrite;
  readonly done: Deferred;
  /** How often the server refused it with `conflict` so far. */
  conflicts: number;
}

/** `inFlight` of a write whose answer was lost: it may or may not have taken effect. */
const UNCERTAIN = 0;

const asError = (error: unknown): MoonCGError =>
  error instanceof MoonCGError
    ? error
    : new MoonCGError('bad_request', error instanceof Error ? error.message : String(error));

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
  const restyle =
    options.restyle ??
    ((files: readonly string[]) => {
      if (!swapStylesheets(bundle, files)) reloadPage();
    });
  const report =
    options.onError ??
    ((message: string, error: unknown) => console.error(`MoonCG: ${message}`, error));

  const ready = defer();
  const replicants = new Map<string, ReplicantState>();
  const pendingSubs = new Map<number, ReplicantState>();
  /** Requests waiting for the server's answer, by request id. */
  const pending = new Map<number, Deferred<unknown>>();
  const topics = new Map<string, TopicState>();
  /** Optimistic writes the server has and has not answered, by request id. */
  const writesOut = new Map<number, ReplicantState>();
  const handlers = new Map<string, RequestHandler>();
  const routes = new Map<number, RouteHandler>();
  let socket: SocketLike | undefined;
  let connected = false;
  /** Counts the connections that ended; calls of an earlier one are not answered on a later. */
  let generation = 0;
  const incoming = new IncomingBodies((msg) => send(msg));
  const outgoing = new OutgoingBodies((msg) => send(msg));
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
    for (const state of replicants.values()) {
      state.ready.reject(error);
      failWrites(state, error);
    }
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
    state.subscribing = true;
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

  /**
   * Optimistic: works out what to show, the server's value with the pending writes applied,
   * and tells the subscribers if that is another value than shown. Writes that no longer fit
   * are dropped and rejected; not the one in flight, which the server answers.
   */
  const reproject = (state: ReplicantState) => {
    if (state.server === undefined) return;
    const { value, failed } = rebaseWrites(
      state.server,
      state.writes.map((queued) => queued.write),
    );
    for (const { index, error } of [...failed].reverse()) {
      if (index === 0 && state.inFlight !== undefined) continue;
      const [dropped] = state.writes.splice(index, 1);
      dropped?.done.reject(asError(error));
    }
    show(state, value);
  };

  /** Optimistic: sends the first write, unless one is out or the local copy is not in step. */
  const pump = (state: ReplicantState) => {
    while (
      state.optimistic &&
      connected &&
      state.loaded &&
      state.inFlight === undefined &&
      !state.subscribing &&
      !state.resync &&
      state.error === undefined
    ) {
      const head = state.writes[0];
      if (!head) return;
      let op: ReplicantOp | undefined;
      try {
        // Worked out now, on the server's value: every write before it has been answered.
        op = opForWrite(head.write, state.server as Json, state.rev);
      } catch (error) {
        state.writes.shift();
        head.done.reject(asError(error));
        reproject(state);
        continue;
      }
      if (op === undefined) {
        state.writes.shift();
        head.done.resolve();
        continue;
      }
      const id = nextId++;
      state.inFlight = id;
      writesOut.set(id, state);
      send({ t: 'rep.op', id, name: state.handle.name, ...op });
    }
  };

  /** Optimistic: the server committed the first write as revision `rev`. */
  const confirmWrite = (state: ReplicantState, rev: number) => {
    state.inFlight = undefined;
    state.writes.shift()?.done.resolve();
    if (state.resync) return;
    // The commit itself came as a patch just before; without it the copy is out of step.
    if (state.rev < rev) {
      resync(state.handle.name, state);
      return;
    }
    reproject(state);
    pump(state);
  };

  /** Optimistic: the server refused the first write. A recipe is run again after a conflict. */
  const refuseWrite = (state: ReplicantState, error: MoonCGError) => {
    state.inFlight = undefined;
    const head = state.writes[0];
    if (
      head &&
      error.code === 'conflict' &&
      head.write.kind === 'update' &&
      head.conflicts < MAX_UPDATE_RETRIES
    ) {
      head.conflicts++;
    } else {
      state.writes.shift();
      head?.done.reject(error);
    }
    if (state.resync) return;
    reproject(state);
    pump(state);
  };

  /**
   * Optimistic: the local copy is in step again, so a write whose answer was lost is let go.
   * While the server still has a write it will answer, the new value may or may not hold that
   * write already: like a patch, it is shown together with the answer, never before, so that
   * the write is not applied twice.
   */
  const inStep = (state: ReplicantState) => {
    state.subscribing = false;
    if (state.inFlight === UNCERTAIN) {
      state.inFlight = undefined;
      state.writes.shift();
    }
    if (state.inFlight !== undefined) return;
    reproject(state);
    pump(state);
  };

  /** Rejects every pending write; shown is the server's value again. */
  const failWrites = (state: ReplicantState, error: MoonCGError) => {
    if (state.writes.length === 0) return;
    for (const [id, owner] of writesOut) if (owner === state) writesOut.delete(id);
    state.inFlight = undefined;
    for (const queued of state.writes.splice(0)) queued.done.reject(error);
    reproject(state);
  };

  /**
   * Optimistic: queues a write, shows it at once and sends it when its turn comes. A `set`
   * that follows a `set` still waiting to be sent takes its place: only the last one is sent,
   * and both promises settle with its answer. What is shown is worked out from the value shown
   * so far, without running the waiting writes again.
   */
  const enqueue = (state: ReplicantState, write: PendingWrite): Promise<void> => {
    if (write.kind === 'set') {
      const problem = jsonProblem(write.value);
      if (problem !== null) {
        return Promise.reject(new MoonCGError('bad_request', `Not a JSON value: ${problem}`));
      }
    }
    if (stopError) return Promise.reject(stopError);
    const last = state.writes.at(-1);
    const lastIsOut = state.writes.length === 1 && state.inFlight !== undefined;
    if (write.kind === 'set' && last?.write.kind === 'set' && !lastIsOut) {
      last.write = write;
      show(state, deepFreeze(write.value));
      return last.done.promise;
    }
    if (state.writes.length >= MAX_PENDING_WRITES) {
      return Promise.reject(
        new MoonCGError('unavailable', 'Too many writes are waiting for the server'),
      );
    }
    if (state.server === undefined || !state.loaded) {
      const done = defer();
      state.writes.push({ write, done, conflicts: 0 });
      reproject(state);
      pump(state);
      return done.promise;
    }
    const { value, failed } = rebaseWrites(state.value as Json, [write]);
    // A write that does not fit what is shown is refused at once, as `reproject` would.
    if (failed[0]) return Promise.reject(asError(failed[0].error));
    const done = defer();
    state.writes.push({ write, done, conflicts: 0 });
    show(state, value);
    pump(state);
    return done.promise;
  };

  /** Optimistic: shows a value, and tells the subscribers if it is another one. */
  const show = (state: ReplicantState, value: Json) => {
    if (state.loaded && JSON.stringify(value) === JSON.stringify(state.value)) return;
    state.value = value;
    state.loaded = true;
    notify(state);
  };

  const submit = (name: string, op: ReplicantOp): Promise<void> =>
    ask((id) => ({ t: 'rep.op', id, name, ...op }));

  /**
   * Sends only while the connection a call came on is still the current one. Call ids start
   * over with every connection: an answer that comes late must not answer another call.
   */
  const replyTo = () => {
    const at = generation;
    return {
      send: (msg: ClientMessage) => at === generation && send(msg),
      current: () => at === generation,
    };
  };

  /** Runs an extension's handler for a call from the server and sends back the outcome. */
  const answer = (call: number, what: string, run: (() => unknown) | undefined) => {
    const { send } = replyTo();
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

  /**
   * Runs a route's handler and sends back the answer; a streamed answer's body follows it.
   * Whatever the handler did not read of a streamed request body is not wanted afterwards.
   */
  const answerRoute = (
    call: number,
    run: (() => Promise<HttpResponseData | RouteAnswer>) | undefined,
  ) => {
    const { send, current } = replyTo();
    if (!run) {
      send({ t: 'call.err', call, code: 'not_found', message: 'Nothing handles the route' });
      return;
    }
    Promise.resolve()
      .then(run)
      .then(async (result) => {
        const { status, headers } = result;
        const pieces = 'pieces' in result ? result.pieces : undefined;
        if (pieces !== undefined && !current()) {
          // Nobody waits for it any more.
          await pieces[Symbol.asyncIterator]().return?.();
          return;
        }
        if (pieces === undefined) {
          send({ t: 'call.ok', call, data: { status, headers, body: result.body } });
          return;
        }
        send({ t: 'call.ok', call, data: { status, headers, body: null, stream: true } });
        return outgoing.start(call, pieces, (error) =>
          report('the body of the answer of a route failed', error),
        );
      })
      .catch((error) => {
        if (error instanceof MoonCGError && error.code !== 'disconnected') {
          send({ t: 'call.err', call, code: error.code, message: error.message });
          return;
        }
        report('the handler of the route failed', error);
        send({ t: 'call.err', call, code: 'internal', message: 'The handler of the route failed' });
      })
      .finally(() => {
        if (current()) incoming.drop(call);
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
        if (state.optimistic) {
          state.server = deepFreeze(msg.value);
          state.epoch = msg.epoch;
          state.rev = msg.rev;
          state.resync = false;
          setError(state, undefined);
          inStep(state);
          state.ready.resolve();
          return;
        }
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
        let next: Json;
        try {
          const current = state.optimistic ? state.server : state.value;
          next = deepFreeze(applyPatches(current as Json, msg.patches));
        } catch {
          // The local copy no longer matches the server's: start over from a snapshot.
          resync(msg.name, state);
          return;
        }
        state.rev = msg.rev;
        if (!state.optimistic) {
          state.value = next;
          notify(state);
          return;
        }
        state.server = next;
        // While a write is out this may be that very write, which is shown already: what to
        // show is worked out once the server has answered it.
        if (state.inFlight === undefined) reproject(state);
        return;
      }
      case 'rep.gone': {
        const state = replicants.get(msg.name);
        if (!state) return;
        const error = new MoonCGError('not_found', msg.message);
        setError(state, error);
        state.ready.reject(error);
        failWrites(state, error);
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
      case 'css':
        restyle(msg.files);
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
        const body = handler && msg.request.stream ? incoming.open(msg.call) : undefined;
        answerRoute(msg.call, handler && (() => handler(msg.request, body)));
        return;
      }
      case 'http.data':
        incoming.data(msg.call, msg.data);
        return;
      case 'http.end':
        incoming.end(msg.call);
        return;
      case 'http.abort':
        incoming.abort(msg.call, msg.message);
        return;
      case 'http.pull':
        outgoing.pulled(msg.call);
        return;
      case 'http.cancel':
        outgoing.cancelled(msg.call);
        return;
      case 'ack': {
        const writer = writesOut.get(msg.id);
        if (writer) {
          writesOut.delete(msg.id);
          confirmWrite(writer, msg.rev);
          return;
        }
        // Answers an op, or a subscription that was brought up to date with patches.
        const subscribed = pendingSubs.get(msg.id);
        pendingSubs.delete(msg.id);
        if (subscribed?.optimistic) inStep(subscribed);
        else if (subscribed) subscribed.subscribing = false;
        settle(msg.id, undefined);
        return;
      }
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
        const writer = writesOut.get(msg.id);
        if (writer) {
          writesOut.delete(msg.id);
          refuseWrite(writer, error);
          return;
        }
        const refused = pendingSubs.get(msg.id);
        if (refused) {
          refused.subscribing = false;
          setError(refused, error);
          refused.ready.reject(error);
          pendingSubs.delete(msg.id);
          failWrites(refused, error);
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
      // An optimistic write that is out may or may not have taken effect. Its caller learns
      // that it was cut off; it stays shown until the copy is in step again.
      for (const state of writesOut.values()) {
        state.writes[0]?.done.reject(dropped);
        state.inFlight = UNCERTAIN;
      }
      writesOut.clear();
      for (const state of replicants.values()) state.subscribing = false;
      generation++;
      incoming.closeAll(dropped);
      outgoing.closeAll();
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

  const createState = (name: string, optimistic: boolean): ReplicantState => {
    const state: ReplicantState = {
      subscribing: false,
      optimistic,
      server: undefined,
      writes: [],
      inFlight: undefined,
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
          if (state.optimistic) return enqueue(state, { kind: 'set', value: next as Json });
          await submit(name, { patches: [{ op: 'replace', path: '', value: next as Json }] });
        },
        async update(recipe) {
          await state.ready.promise;
          if (state.error) throw state.error;
          if (state.optimistic) {
            return enqueue(state, { kind: 'update', recipe: recipe as Recipe<unknown> });
          }
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
    replicant(name: string, replicantOptions: ClientReplicantOptions = {}) {
      const qualified = qualifyReplicantName(name, bundle);
      const optimistic = replicantOptions.optimistic === true;
      let state = replicants.get(qualified);
      if (state && optimistic && !state.optimistic) {
        // From now on the copy keeps the server's value apart from what it shows.
        state.optimistic = true;
        state.server = state.loaded ? state.value : undefined;
      }
      if (!state) {
        state = createState(qualified, optimistic);
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
    async route(method, pattern, handler, permission, streaming = {}) {
      await ready.promise;
      let route = 0;
      await ask((id) => {
        route = id;
        return {
          t: 'http.route',
          id,
          method,
          pattern,
          ...(permission === undefined ? {} : { permission }),
          ...(streaming.stream ? { stream: true as const } : {}),
          ...(streaming.stream && streaming.maxBytes !== undefined
            ? { maxBytes: streaming.maxBytes }
            : {}),
        };
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
