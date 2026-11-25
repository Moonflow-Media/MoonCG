import { type ErrorCode, MoonCGError, type Timers } from '../errors.js';
import type {
  HttpRequestData,
  HttpResponseData,
  RouteAnswer,
  RouteCall,
  RouteTable,
} from '../http/routes.js';
import type { Json } from '../json.js';
import { MAX_REQUEST_TIMEOUT_MS, type MessageBus, type Sender } from '../messages/bus.js';
import { NAMESPACE_SEPARATOR } from '../names.js';
import {
  authorize,
  bundlePermission,
  type Policy,
  type Principal,
  SYSTEM_BUNDLE,
} from '../permissions/authorize.js';
import {
  type BundleAccess,
  bundleCapability,
  HTTP_ROUTES_CAPABILITY,
  hasCapability,
} from '../permissions/capabilities.js';
import {
  type ClientMessage,
  decodeClientMessage,
  type GraphicEndReason,
  isHttpResponse,
  PROTOCOL_VERSION,
  type ServerMessage,
  type StreamMessage,
} from '../protocol/protocol.js';
import {
  qualifyReplicantName,
  type ReplicantEntry,
  type ReplicantRegistry,
} from '../replicant/registry.js';
import { HttpExchange } from './http-exchange.js';

/** How long a bundle's HTTP route handler may take to answer. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * How many calls to one connection may wait for its answer at a time. Further calls fail as
 * `unavailable`, so a connection that stopped answering cannot pile up work on the server.
 */
export const MAX_PENDING_CALLS = 100;

/**
 * How many HTTP calls to one connection may stream a body at a time, an upload or an answer.
 * Further ones fail as `unavailable`. A streamed upload lasts as long as its client takes to
 * send it, so these calls do not take places of `MAX_PENDING_CALLS`: slow uploads cannot
 * keep the connection from answering anything else.
 */
export const MAX_STREAMED_BODIES = 16;

/**
 * How many names one connection may wait for at a time: replicants and topics it asked for
 * while they were not declared, or lost with their bundle. Further ones are not remembered,
 * so a client cannot make the server keep a list without end.
 */
export const MAX_AWAITED_NAMES = 500;

/** One connected page of a bundle, as its session describes it. */
export interface ConnectedPage {
  /** Whether the page said in `hello` that it is a graphic. Any other is a panel or dialog. */
  readonly graphic: boolean;
  /** Tells the page to load itself again. */
  reload(): void;
  /**
   * Tells the page that these stylesheets of its bundle changed. Only the ones its principal
   * may fetch are named to it; when that is none of them, it is told nothing.
   */
  restyle(styles: readonly Stylesheet[]): void;
}

/** A file of a bundle that a page may load as a stylesheet, and what it takes to fetch it. */
export interface Stylesheet {
  /** The file inside the bundle, such as `dashboard/control.css`. */
  readonly file: string;
  /** The permission the server checks before it sends the file. */
  readonly permission: string;
}

/** Where the connected pages of each bundle are listed, so that they can be told to reload. */
export interface BundlePages {
  /** Lists a page under its bundle and returns the function that takes it off again. */
  join(bundle: string, page: ConnectedPage): () => void;
}

/** What makes a session the connection of a bundle's extension, not of a page. */
export interface ExtensionAccess {
  /** The bundle manifest's `capabilities`. They limit what the extension reaches. */
  readonly capabilities: readonly string[];
  /** The permission names the bundle manifest declares, for per-route permissions. */
  readonly permissions: readonly string[];
  readonly httpTimeoutMs?: number;
}

/**
 * The graphics of the running bundles and the pages that show them right now. The server
 * keeps it; a session asks it when a page says in `hello` which graphic it is.
 */
export interface GraphicPages {
  /** The graphic whose page a file of a bundle is, with the permission it takes to open it. */
  find(bundle: string, file: string): { readonly permission: string } | undefined;
  /**
   * Registers a connected instance of that graphic and returns the function that removes it
   * again. Returns `undefined` when the graphic takes a single instance and another
   * principal has it; an instance of the same principal is ended and replaced.
   */
  enter(bundle: string, file: string, instance: GraphicInstance): (() => void) | undefined;
}

/** One page that shows a graphic, as its session describes it. */
export interface GraphicInstance {
  readonly principal: Principal;
  /** Tells the page to load itself again. */
  reload(): void;
  /** Tells the page that it is no longer the instance. It is taken off the list already. */
  end(reason: GraphicEndReason): void;
}

export interface SessionOptions {
  /** Who the connection acts as, resolved by the transport before the session starts. */
  readonly principal: Principal;
  readonly policy: Policy;
  readonly registry: ReplicantRegistry;
  /** Whether a bundle of that name is running. `hello` for any other bundle is refused. */
  readonly bundleExists: (bundle: string) => boolean;
  /** Delivers one message to this connection. */
  readonly send: (msg: ServerMessage) => void;
  /** Receives an unexpected failure while handling a message, for logging. */
  readonly onError?: (error: unknown) => void;
  /** Without a bus the session serves replicants only. */
  readonly bus?: MessageBus | undefined;
  /** Where an extension's HTTP routes are registered. Needs `timers`. */
  readonly routes?: RouteTable | undefined;
  readonly timers?: Timers | undefined;
  /** Present when the connection is a bundle's extension. */
  readonly extension?: ExtensionAccess | undefined;
  /**
   * Whether the principal with that id holds the permission right now. It answers an
   * extension's `perm.check`; without it every check is answered with no.
   */
  readonly checkPermission?: ((principal: string, permission: string) => boolean) | undefined;
  /** Where graphic pages are registered. Without it no page counts as an instance. */
  readonly graphics?: GraphicPages | undefined;
  /** Where every page is listed under its bundle. Without it no page is told to reload. */
  readonly pages?: BundlePages | undefined;
}

/** What a connection currently holds on the server. All of it is released by `close()`. */
export interface SessionStats {
  readonly replicants: number;
  readonly listeners: number;
  readonly handlers: number;
  readonly routes: number;
  /** Calls to the connection that it has not answered yet. */
  readonly calls: number;
  /**
   * HTTP calls to the connection whose request or answer streams, until both bodies are
   * over. At most `MAX_STREAMED_BODIES`.
   */
  readonly streams: number;
}

export interface Session {
  /**
   * Handles one raw text frame from the client. Never throws: malformed input and unexpected
   * failures are both answered with a `bad_request` error.
   */
  receive(text: string): void;
  /**
   * Releases everything the connection registered: subscriptions, message listeners and
   * handlers, HTTP routes. Calls it has not answered fail as unavailable.
   */
  close(): void;
  stats(): SessionStats;
}

type Request = Extract<ClientMessage, { id: number }>;
type Named = Extract<ClientMessage, { name: string }>;

interface PendingCall {
  /** Checks and passes on the answer; rejects if it is not what the caller needs. */
  resolve(data: Json): void;
  reject(error: MoonCGError): void;
}

const STREAM_TYPES: readonly string[] = [
  'http.data',
  'http.end',
  'http.pull',
  'http.cancel',
  'http.abort',
];
const isStreamMessage = (msg: ClientMessage): msg is StreamMessage => STREAM_TYPES.includes(msg.t);

/**
 * The server side of one connection, independent of the transport: a page's socket or a
 * bundle's extension. It learns its bundle from `hello`, checks `authorize()` on everything
 * the client asks for, and is the ledger of what the client registered.
 */
export function createSession(options: SessionOptions): Session {
  const { principal, policy, registry, send, bus, routes, timers, extension } = options;
  const replicants = new Map<string, () => void>();
  const listeners = new Map<string, () => void>();
  const handlers = new Map<string, () => void>();
  const registered: (() => void)[] = [];
  const calls = new Map<number, PendingCall>();
  /** The calls of `calls` that do not count against `MAX_PENDING_CALLS`: streamed uploads. */
  const uncounted = new Set<number>();
  /** HTTP calls, by call id, until they are answered and both bodies are over. */
  const exchanges = new Map<number, HttpExchange>();
  const streaming = () => {
    let count = 0;
    for (const exchange of exchanges.values()) if (exchange.streamed) count++;
    return count;
  };
  let nextCall = 1;
  let bundle: string | undefined;
  /** Takes this connection out of the instances of its graphic, if it is one. */
  let leaveGraphic: (() => void) | undefined;
  /** Takes this connection off the pages of its bundle. */
  let leavePages: (() => void) | undefined;
  let closed = false;
  /**
   * The replicants and topics this connection waits for: it is told when one is declared.
   * Each kind has one listener for declarations, added when the first name is awaited.
   */
  const awaitedReplicants = new Set<string>();
  const awaitedTopics = new Set<string>();
  let stopAwaitingReplicants: (() => void) | undefined;
  let stopAwaitingTopics: (() => void) | undefined;
  const mayAwait = () => !closed && awaitedReplicants.size + awaitedTopics.size < MAX_AWAITED_NAMES;

  const awaitReplicant = (name: string) => {
    if (!mayAwait()) return;
    awaitedReplicants.add(name);
    stopAwaitingReplicants ??= registry.onDeclare((declared) => {
      if (awaitedReplicants.delete(declared)) send({ t: 'rep.back', name: declared });
    });
  };
  const awaitTopic = (name: string, messageBus: MessageBus) => {
    if (!mayAwait()) return;
    awaitedTopics.add(name);
    stopAwaitingTopics ??= messageBus.onDeclare((declared) => {
      if (awaitedTopics.delete(declared)) send({ t: 'msg.back', name: declared });
    });
  };

  const fail = (code: ErrorCode, message: string, id?: number) =>
    send(id === undefined ? { t: 'err', code, message } : { t: 'err', id, code, message });

  /** Answers the request with the error, however it was raised. */
  const failWith = (error: unknown, id: number) => {
    if (error instanceof MoonCGError && error.code !== 'disconnected') {
      fail(error.code, error.message, id);
    } else {
      options.onError?.(error);
      fail('internal', 'The request could not be completed', id);
    }
  };

  /**
   * Whether the principal holds anything of the bundle a name (`bundle` or `bundle:name`)
   * belongs to. What belongs to a bundle the principal holds nothing of is answered exactly
   * like something that does not exist, so nothing tells which bundles are installed. The
   * server's own namespace is guarded by system permissions instead.
   */
  const sees = (name: string) => {
    const at = name.indexOf(NAMESPACE_SEPARATOR);
    const target = at < 0 ? name : name.slice(0, at);
    return (
      target === SYSTEM_BUNDLE || authorize(principal, bundlePermission(target, undefined), policy)
    );
  };

  /** An extension reaches other bundles only with the capability its manifest asked for. */
  const reaches = (name: string, access: BundleAccess, ownBundle: string, id: number) => {
    const target = name.slice(0, name.indexOf(NAMESPACE_SEPARATOR));
    if (!extension || target === ownBundle) return true;
    const capability = bundleCapability(target, access);
    if (hasCapability(extension.capabilities, capability)) return true;
    fail('forbidden', `Bundle "${ownBundle}" lacks the capability "${capability}"`, id);
    return false;
  };

  const permits = (permission: string, id: number) => {
    if (authorize(principal, permission, policy)) return true;
    fail('forbidden', `Missing permission "${permission}"`, id);
    return false;
  };

  /** Looks up the replicant a request names and checks what the request needs. */
  const replicantFor = (
    request: Request & Named,
    ownBundle: string,
    access: BundleAccess,
  ): { name: string; entry: ReplicantEntry } | undefined => {
    const name = qualifyReplicantName(request.name, ownBundle);
    const entry = registry.get(name);
    if (!entry || !sees(name)) {
      // Whoever may see the bundle and asked to follow is told when the replicant is there.
      if (request.t === 'rep.sub' && sees(name)) awaitReplicant(name);
      fail('not_found', `Replicant "${name}" is not declared`, request.id);
      return undefined;
    }
    if (!reaches(name, access, ownBundle, request.id)) return undefined;
    if (access === 'write' && entry.readOnly) {
      fail('forbidden', `Replicant "${name}" is read-only`, request.id);
      return undefined;
    }
    const permission = access === 'read' ? entry.readPermission : entry.writePermission;
    return permits(permission, request.id) ? { name, entry } : undefined;
  };

  const subscribe = (request: Extract<ClientMessage, { t: 'rep.sub' }>, ownBundle: string) => {
    const target = replicantFor(request, ownBundle, 'read');
    if (!target) return;
    const { name, entry } = target;
    awaitedReplicants.delete(name);
    if (!replicants.has(name)) {
      const stopPatches = entry.replicant.onCommit(({ rev, patches }) =>
        send({ t: 'rep.patch', name, rev, patches }),
      );
      const stopClose = entry.replicant.onClose(() => {
        replicants.delete(name);
        send({ t: 'rep.gone', name, message: `Replicant "${name}" was removed` });
        awaitReplicant(name);
      });
      replicants.set(name, () => {
        stopPatches();
        stopClose();
      });
    }
    const { rev, value, epoch } = entry.replicant;
    // A revision from another epoch says nothing about what this client has.
    const missed =
      request.since?.epoch === epoch ? entry.replicant.patchesSince(request.since.rev) : undefined;
    if (missed === undefined) {
      send({ t: 'rep.snap', id: request.id, name, rev, value, epoch });
      return;
    }
    for (const commit of missed) send({ t: 'rep.patch', name, ...commit });
    send({ t: 'ack', id: request.id, rev });
  };

  const applyOp = (request: Extract<ClientMessage, { t: 'rep.op' }>, ownBundle: string) => {
    const target = replicantFor(request, ownBundle, 'write');
    if (!target) return;
    const result = target.entry.replicant.applyOp(request);
    if (result.ok) send({ t: 'ack', id: request.id, rev: result.rev });
    else fail(result.code, result.message, request.id);
  };

  /**
   * Sends a call to the client and settles when it answers, fails, times out or closes.
   * `onAbandon` lets the caller say that it no longer waits, which forgets the call at once.
   * `onSent` learns the call's id once it is sent, with `touch`, which starts the timeout
   * anew, and `abandon`, which fails the call with an error. A call that is not `counted`
   * takes none of the `MAX_PENDING_CALLS` places; its caller limits such calls itself.
   */
  const call = <T>(
    message: (call: number) => ServerMessage,
    timeoutMs: number,
    accept: (data: Json) => T | undefined,
    onAbandon?: (listener: () => void) => void,
    onSent?: (id: number, touch: () => void, abandon: (error: MoonCGError) => void) => void,
    counted = true,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed || (counted && calls.size - uncounted.size >= MAX_PENDING_CALLS)) {
        reject(new MoonCGError('unavailable', 'The extension has too many unanswered calls'));
        return;
      }
      const id = nextCall++;
      if (!counted) uncounted.add(id);
      const settle = (finish: () => void) => {
        if (!calls.delete(id)) return;
        uncounted.delete(id);
        timers?.clearTimeout(timer);
        finish();
      };
      onAbandon?.(() => settle(() => {}));
      const rejectWith = (error: MoonCGError) => settle(() => reject(error));
      const expire = () =>
        rejectWith(new MoonCGError('timeout', 'The extension did not answer in time'));
      let timer = timers?.setTimeout(expire, timeoutMs);
      calls.set(id, {
        reject: rejectWith,
        resolve(data) {
          const accepted = accept(data);
          if (accepted === undefined) {
            rejectWith(new MoonCGError('internal', 'The extension answered with unusable data'));
          } else settle(() => resolve(accepted));
        },
      });
      send(message(id));
      onSent?.(
        id,
        () => {
          if (!calls.has(id)) return;
          timers?.clearTimeout(timer);
          timer = timers?.setTimeout(expire, timeoutMs);
        },
        rejectWith,
      );
    });

  /**
   * Calls an extension's route. A streamed request body is sent as the extension takes it,
   * and the timeout counts from the last piece it took; a streamed answer is handed on as
   * `stream`. When the client goes away (`signal`) the extension is told to stop.
   */
  const invokeRoute = (
    routeId: number,
    httpRequest: HttpRequestData,
    timeoutMs: number,
    routeCall: RouteCall = {},
  ): Promise<RouteAnswer> => {
    const { body, signal } = routeCall;
    if (signal?.aborted) {
      return Promise.reject(new MoonCGError('unavailable', 'The client went away'));
    }
    const tooMany = () =>
      new MoonCGError('unavailable', 'The extension has too many streamed bodies under way');
    if (body && streaming() >= MAX_STREAMED_BODIES) return Promise.reject(tooMany());
    let exchange: HttpExchange | undefined;
    let leave: (() => void) | undefined;
    /** Set when the answer would stream but there is no place for another stream. */
    let refused: MoonCGError | undefined;
    const answer = call<HttpResponseData>(
      (callId) => ({
        t: 'http.call',
        call: callId,
        route: routeId,
        request: body ? { ...httpRequest, body: null, stream: true } : httpRequest,
      }),
      timeoutMs,
      (data) => {
        if (!isHttpResponse(data)) return undefined;
        if (data.stream === true && exchange && !exchange.streamed) {
          if (streaming() >= MAX_STREAMED_BODIES) {
            // None of its pieces are wanted, nor anything else of the call.
            refused = tooMany();
            send({ t: 'http.cancel', call: exchange.call });
            exchange.close(refused);
            return data;
          }
          exchange.streamed = true;
        }
        // Said at once: the first pieces of the answer may come before anyone reads it.
        exchange?.settled(data.stream === true);
        return data;
      },
      undefined,
      (callId, touch, abandon) => {
        const opened = new HttpExchange(callId, send, () => {
          exchanges.delete(callId);
          leave?.();
        });
        opened.streamed = body !== undefined;
        exchange = opened;
        exchanges.set(callId, opened);
        if (signal) {
          const onAbort = () => {
            const gone = new MoonCGError('unavailable', 'The client went away');
            abandon(gone);
            opened.close(gone);
          };
          signal.addEventListener('abort', onAbort);
          leave = () => signal.removeEventListener('abort', onAbort);
        }
        if (body) {
          opened.sendBody(body, touch).catch((error: unknown) => {
            const broken =
              error instanceof MoonCGError
                ? error
                : new MoonCGError('unavailable', 'The request body broke off');
            abandon(broken);
            opened.close(broken, false);
          });
        }
      },
      body === undefined,
    );
    return answer.then(
      (data) => {
        if (refused) throw refused;
        const settled = exchange;
        if (!settled) return { status: data.status, headers: data.headers, body: data.body };
        if (data.stream !== true) {
          settled.settled(false);
          return { status: data.status, headers: data.headers, body: data.body };
        }
        return {
          status: data.status,
          headers: data.headers,
          body: null,
          pieces: settled.response(),
        };
      },
      (error: unknown) => {
        exchange?.close(
          error instanceof MoonCGError ? error : new MoonCGError('internal', String(error)),
        );
        throw error;
      },
    );
  };

  /** A message about a streamed body from the extension. */
  const streamMessage = (msg: StreamMessage) => {
    if (!extension) {
      fail('forbidden', 'Only a bundle extension streams HTTP bodies');
      return;
    }
    const exchange = exchanges.get(msg.call);
    if (!exchange) {
      // Over already, as after the client went away: whoever still sends is told to stop.
      if (msg.t === 'http.data') send({ t: 'http.cancel', call: msg.call });
      return;
    }
    switch (msg.t) {
      case 'http.pull':
        exchange.pulled();
        return;
      case 'http.cancel':
        exchange.cancelled();
        return;
      case 'http.data':
        exchange.data(msg.data);
        return;
      case 'http.end':
        exchange.end();
        return;
      case 'http.abort':
        exchange.aborted(msg.message);
    }
  };

  const messages = (
    request: Extract<ClientMessage, { t: `msg.${string}` }>,
    ownBundle: string,
    messageBus: MessageBus,
  ) => {
    const { id } = request;
    const name = qualifyReplicantName(request.name, ownBundle);
    const topic = messageBus.get(name);
    if (request.t === 'msg.unsub') awaitedTopics.delete(name);
    if (!topic || !sees(name)) {
      if (request.t === 'msg.sub' && sees(name)) awaitTopic(name, messageBus);
      fail('not_found', `Message "${name}" is not declared`, id);
      return;
    }
    const sender: Sender = {
      principal: principal.id,
      kind: principal.kind ?? 'user',
      bundle: ownBundle,
    };
    switch (request.t) {
      case 'msg.sub':
        if (!reaches(name, 'read', ownBundle, id) || !permits(topic.listenPermission, id)) return;
        awaitedTopics.delete(name);
        if (!listeners.has(name)) {
          listeners.set(
            name,
            messageBus.subscribe(
              name,
              (data, from) => send({ t: 'msg', name, data, sender: from }),
              () => {
                listeners.delete(name);
                send({ t: 'msg.gone', name, message: `Message "${name}" was removed` });
                awaitTopic(name, messageBus);
              },
            ),
          );
        }
        send({ t: 'ok', id });
        return;
      case 'msg.unsub':
        listeners.get(name)?.();
        listeners.delete(name);
        send({ t: 'ok', id });
        return;
      case 'msg.send':
        if (!reaches(name, 'write', ownBundle, id) || !permits(topic.sendPermission, id)) return;
        messageBus.publish(name, request.data, sender);
        send({ t: 'ok', id });
        return;
      case 'msg.req':
        if (!reaches(name, 'write', ownBundle, id) || !permits(topic.sendPermission, id)) return;
        messageBus.request(name, request.data, sender, request.timeout).then(
          (data) => send({ t: 'msg.res', id, data }),
          (error) => failWith(error, id),
        );
        return;
      case 'msg.handle':
        if (!extension || topic.bundle !== ownBundle) {
          fail('forbidden', 'Only a bundle extension can handle requests, and only its own', id);
          return;
        }
        handlers.set(
          name,
          messageBus.handle(name, (data, from, onAbandon) =>
            // The bus decides when a request has waited long enough, and says so.
            call(
              (callId) => ({ t: 'msg.call', call: callId, name, data, sender: from }),
              MAX_REQUEST_TIMEOUT_MS,
              (answer) => answer,
              onAbandon,
            ),
          ),
        );
        send({ t: 'ok', id });
        return;
      case 'msg.unhandle':
        handlers.get(name)?.();
        handlers.delete(name);
        send({ t: 'ok', id });
    }
  };

  const route = (request: Extract<ClientMessage, { t: 'http.route' }>, ownBundle: string) => {
    const { id, method, pattern, permission, stream, maxBytes } = request;
    if (!extension || !routes || !hasCapability(extension.capabilities, HTTP_ROUTES_CAPABILITY)) {
      fail(
        'forbidden',
        `Registering routes needs a bundle extension with the "${HTTP_ROUTES_CAPABILITY}" capability`,
        id,
      );
      return;
    }
    if (permission !== undefined && !extension.permissions.includes(permission)) {
      fail('bad_request', `Permission "${permission}" is not declared by the bundle`, id);
      return;
    }
    registered.push(
      routes.add({
        bundle: ownBundle,
        method,
        pattern,
        permission: bundlePermission(ownBundle, permission),
        stream: stream === true,
        maxBodyBytes: maxBytes,
        invoke: (httpRequest, routeCall) =>
          invokeRoute(
            id,
            httpRequest,
            extension.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
            stream === true ? routeCall : { signal: routeCall?.signal },
          ),
      }),
    );
    send({ t: 'ok', id });
  };

  const check = (request: Extract<ClientMessage, { t: 'perm.check' }>, ownBundle: string) => {
    const { id, permission } = request;
    if (!extension) {
      fail('forbidden', 'Only a bundle extension can check permissions', id);
    } else if (!extension.permissions.includes(permission)) {
      fail('bad_request', `Permission "${permission}" is not declared by the bundle`, id);
    } else {
      const wanted = bundlePermission(ownBundle, permission);
      const allowed = options.checkPermission?.(request.principal, wanted) ?? false;
      send({ t: 'perm.res', id, allowed });
    }
  };

  const answer = (msg: Extract<ClientMessage, { t: 'call.ok' | 'call.err' }>) => {
    if (!extension) {
      fail('forbidden', 'Only a bundle extension answers calls');
      return;
    }
    const pending = calls.get(msg.call);
    if (!pending && msg.t === 'call.ok' && isHttpResponse(msg.data) && msg.data.stream === true) {
      // Nobody waits for this answer any more; its body is not wanted.
      send({ t: 'http.cancel', call: msg.call });
      return;
    }
    if (msg.t === 'call.ok') pending?.resolve(msg.data);
    else pending?.reject(new MoonCGError(msg.code, msg.message));
  };

  /**
   * Registers the page as an instance of the graphic it says it is. Answers no, after having
   * said why, when the principal may not open that graphic or it is open already and takes
   * one instance. A file that is no graphic of the bundle makes the page one like any other.
   */
  const enterGraphic = (ownBundle: string, file: string | undefined): boolean => {
    const graphic = file === undefined ? undefined : options.graphics?.find(ownBundle, file);
    if (file === undefined || !graphic) return true;
    if (!authorize(principal, graphic.permission, policy)) {
      fail('forbidden', `Missing permission "${graphic.permission}"`);
      return false;
    }
    leaveGraphic = options.graphics?.enter(ownBundle, file, {
      principal,
      reload: () => {
        if (!closed) send({ t: 'reload' });
      },
      end: (reason) => {
        if (!closed) send({ t: 'graphic.end', reason });
      },
    });
    if (leaveGraphic) return true;
    fail('conflict', 'This graphic is already open somewhere else and takes one instance');
    return false;
  };

  const handle = (msg: ClientMessage) => {
    if (msg.t === 'hello') {
      if (bundle !== undefined) fail('bad_request', 'hello was already sent');
      else if (msg.v !== PROTOCOL_VERSION) {
        fail('bad_request', `Unsupported protocol version ${msg.v}, expected ${PROTOCOL_VERSION}`);
      } else if (!options.bundleExists(msg.bundle) || !sees(msg.bundle)) {
        fail('not_found', `Bundle "${msg.bundle}" is not running`);
      } else if (enterGraphic(msg.bundle, msg.graphic)) {
        bundle = msg.bundle;
        // An extension is no page: nothing ever tells it to load itself again.
        if (!extension) {
          leavePages = options.pages?.join(msg.bundle, {
            graphic: msg.graphic !== undefined,
            reload: () => {
              if (!closed) send({ t: 'reload' });
            },
            restyle: (styles) => {
              const files = styles
                .filter((style) => authorize(principal, style.permission, policy))
                .map((style) => style.file);
              if (!closed && files.length > 0) send({ t: 'css', files });
            },
          });
        }
        send({ t: 'welcome', v: PROTOCOL_VERSION });
      }
      return;
    }
    if (bundle === undefined) {
      fail('bad_request', 'Expected hello first', 'id' in msg ? msg.id : undefined);
    } else if (msg.t === 'rep.sub') subscribe(msg, bundle);
    else if (msg.t === 'rep.op') applyOp(msg, bundle);
    else if (msg.t === 'call.ok' || msg.t === 'call.err') answer(msg);
    else if (isStreamMessage(msg)) streamMessage(msg);
    else if (msg.t === 'http.route') route(msg, bundle);
    else if (msg.t === 'perm.check') check(msg, bundle);
    else if (bus) messages(msg, bundle, bus);
    else fail('bad_request', 'This server has no messages', msg.id);
  };

  return {
    receive(text) {
      // A frame that arrives after the connection ended must not register anything.
      if (closed) return;
      const decoded = decodeClientMessage(text);
      if (!decoded.ok) {
        send(decoded.error);
        return;
      }
      const { msg } = decoded;
      const id = 'id' in msg ? msg.id : undefined;
      try {
        handle(msg);
      } catch (error) {
        if (error instanceof MoonCGError && id !== undefined) failWith(error, id);
        else {
          options.onError?.(error);
          fail('bad_request', 'The message could not be processed', id);
        }
      }
    },
    close() {
      closed = true;
      leaveGraphic?.();
      leaveGraphic = undefined;
      leavePages?.();
      leavePages = undefined;
      stopAwaitingReplicants?.();
      stopAwaitingTopics?.();
      awaitedReplicants.clear();
      awaitedTopics.clear();
      for (const release of [
        ...replicants.values(),
        ...listeners.values(),
        ...handlers.values(),
        ...registered,
      ]) {
        release();
      }
      replicants.clear();
      listeners.clear();
      handlers.clear();
      registered.length = 0;
      const gone = new MoonCGError('unavailable', 'The extension went away');
      for (const pending of [...calls.values()]) pending.reject(gone);
      for (const exchange of [...exchanges.values()]) exchange.close(gone, false);
    },
    stats: () => ({
      replicants: replicants.size,
      listeners: listeners.size,
      handlers: handlers.size,
      routes: registered.length,
      calls: calls.size,
      streams: streaming(),
    }),
  };
}
