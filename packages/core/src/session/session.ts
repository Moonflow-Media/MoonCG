import { type ErrorCode, MoonCGError, type Timers } from '../errors.js';
import type { HttpRequestData, HttpResponseData, RouteTable } from '../http/routes.js';
import type { Json } from '../json.js';
import { MAX_REQUEST_TIMEOUT_MS, type MessageBus, type Sender } from '../messages/bus.js';
import { NAMESPACE_SEPARATOR } from '../names.js';
import {
  authorize,
  bundlePermission,
  type Policy,
  type Principal,
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
  isHttpResponse,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../protocol/protocol.js';
import {
  qualifyReplicantName,
  type ReplicantEntry,
  type ReplicantRegistry,
} from '../replicant/registry.js';

/** How long a bundle's HTTP route handler may take to answer. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * How many calls to one connection may wait for its answer at a time. Further calls fail as
 * `unavailable`, so a connection that stopped answering cannot pile up work on the server.
 */
export const MAX_PENDING_CALLS = 100;

/** What makes a session the connection of a bundle's extension, not of a page. */
export interface ExtensionAccess {
  /** The bundle manifest's `capabilities`. They limit what the extension reaches. */
  readonly capabilities: readonly string[];
  /** The permission names the bundle manifest declares, for per-route permissions. */
  readonly permissions: readonly string[];
  readonly httpTimeoutMs?: number;
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
}

/** What a connection currently holds on the server. All of it is released by `close()`. */
export interface SessionStats {
  readonly replicants: number;
  readonly listeners: number;
  readonly handlers: number;
  readonly routes: number;
  /** Calls to the connection that it has not answered yet. */
  readonly calls: number;
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
  let nextCall = 1;
  let bundle: string | undefined;
  let closed = false;

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
    if (!entry) {
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
    if (!replicants.has(name)) {
      const stopPatches = entry.replicant.onCommit(({ rev, patches }) =>
        send({ t: 'rep.patch', name, rev, patches }),
      );
      const stopClose = entry.replicant.onClose(() => {
        replicants.delete(name);
        send({ t: 'rep.gone', name, message: `Replicant "${name}" was removed` });
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
   */
  const call = <T>(
    message: (call: number) => ServerMessage,
    timeoutMs: number,
    accept: (data: Json) => T | undefined,
    onAbandon?: (listener: () => void) => void,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed || calls.size >= MAX_PENDING_CALLS) {
        reject(new MoonCGError('unavailable', 'The extension has too many unanswered calls'));
        return;
      }
      const id = nextCall++;
      const settle = (finish: () => void) => {
        if (!calls.delete(id)) return;
        timers?.clearTimeout(timer);
        finish();
      };
      onAbandon?.(() => settle(() => {}));
      const rejectWith = (error: MoonCGError) => settle(() => reject(error));
      const timer = timers?.setTimeout(
        () => rejectWith(new MoonCGError('timeout', 'The extension did not answer in time')),
        timeoutMs,
      );
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
    });

  const messages = (
    request: Extract<ClientMessage, { t: `msg.${string}` }>,
    ownBundle: string,
    messageBus: MessageBus,
  ) => {
    const { id } = request;
    const name = qualifyReplicantName(request.name, ownBundle);
    const topic = messageBus.get(name);
    if (!topic) {
      fail('not_found', `Message "${name}" is not declared`, id);
      return;
    }
    const sender: Sender = { principal: principal.id, bundle: ownBundle };
    switch (request.t) {
      case 'msg.sub':
        if (!reaches(name, 'read', ownBundle, id) || !permits(topic.listenPermission, id)) return;
        if (!listeners.has(name)) {
          listeners.set(
            name,
            messageBus.subscribe(
              name,
              (data, from) => send({ t: 'msg', name, data, sender: from }),
              () => {
                listeners.delete(name);
                send({ t: 'msg.gone', name, message: `Message "${name}" was removed` });
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
    const { id, method, pattern, permission } = request;
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
        invoke: (httpRequest: HttpRequestData) =>
          call<HttpResponseData>(
            (callId) => ({ t: 'http.call', call: callId, route: id, request: httpRequest }),
            extension.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
            (answer) => (isHttpResponse(answer) ? answer : undefined),
          ),
      }),
    );
    send({ t: 'ok', id });
  };

  const answer = (msg: Extract<ClientMessage, { call: number }>) => {
    if (!extension) {
      fail('forbidden', 'Only a bundle extension answers calls');
      return;
    }
    const pending = calls.get(msg.call);
    if (msg.t === 'call.ok') pending?.resolve(msg.data);
    else pending?.reject(new MoonCGError(msg.code, msg.message));
  };

  const handle = (msg: ClientMessage) => {
    if (msg.t === 'hello') {
      if (bundle !== undefined) fail('bad_request', 'hello was already sent');
      else if (msg.v !== PROTOCOL_VERSION) {
        fail('bad_request', `Unsupported protocol version ${msg.v}, expected ${PROTOCOL_VERSION}`);
      } else if (!options.bundleExists(msg.bundle)) {
        fail('not_found', `Bundle "${msg.bundle}" is not running`);
      } else {
        bundle = msg.bundle;
        send({ t: 'welcome', v: PROTOCOL_VERSION });
      }
      return;
    }
    if (bundle === undefined) {
      fail('bad_request', 'Expected hello first', 'id' in msg ? msg.id : undefined);
    } else if (msg.t === 'rep.sub') subscribe(msg, bundle);
    else if (msg.t === 'rep.op') applyOp(msg, bundle);
    else if (msg.t === 'call.ok' || msg.t === 'call.err') answer(msg);
    else if (msg.t === 'http.route') route(msg, bundle);
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
    },
    stats: () => ({
      replicants: replicants.size,
      listeners: listeners.size,
      handlers: handlers.size,
      routes: registered.length,
      calls: calls.size,
    }),
  };
}
