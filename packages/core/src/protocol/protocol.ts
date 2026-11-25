import { ERROR_CODES, type ErrorCode } from '../errors.js';
import {
  HTTP_METHODS,
  type HttpMethod,
  type HttpRequestData,
  isRoutePattern,
} from '../http/routes.js';
import { isPlainObject, type Json, jsonProblem } from '../json.js';
import type { Sender } from '../messages/bus.js';
import { BUNDLE_NAME_PATTERN } from '../names.js';
import { isSafeRelativePath } from '../paths.js';
import { PRINCIPAL_KINDS } from '../permissions/authorize.js';
import type { PatchOp } from '../replicant/patch.js';

/** The largest frame either side accepts, 1 MiB. Whoever sends a larger one is cut off. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Sent in `hello` and `welcome`. Bump on any incompatible change to the messages below. */
export const PROTOCOL_VERSION = 6;

/**
 * `name` is a replicant or message name, either bare (the session's own bundle) or
 * `bundle:name`. `id` numbers a request; the answer echoes it.
 */
export type ClientMessage =
  | {
      readonly t: 'hello';
      readonly v: number;
      readonly bundle: string;
      /**
       * Sent by a page that is a graphic: its file inside the bundle, such as
       * `graphics/overlay.html`. The server lists the page as a connected instance of that
       * graphic, and refuses it with `conflict` if the graphic takes a single instance and
       * has one.
       */
      readonly graphic?: string;
    }
  | {
      readonly t: 'rep.sub';
      readonly id: number;
      readonly name: string;
      /**
       * The state the client already has. If the server can replay what was missed, it answers
       * with `rep.patch` messages and an `ack` instead of a `rep.snap`.
       */
      readonly since?: KnownState;
    }
  | {
      readonly t: 'rep.op';
      readonly id: number;
      readonly name: string;
      /** Omitted for last-write-wins. */
      readonly baseRev?: number;
      readonly patches: readonly PatchOp[];
    }
  /** Start or stop receiving a message topic. Answered with `ok`. */
  | { readonly t: 'msg.sub' | 'msg.unsub'; readonly id: number; readonly name: string }
  /** Publish to a topic's subscribers. Answered with `ok`. */
  | { readonly t: 'msg.send'; readonly id: number; readonly name: string; readonly data: Json }
  /** Ask a topic's handler. Answered with `msg.res`. */
  | {
      readonly t: 'msg.req';
      readonly id: number;
      readonly name: string;
      readonly data: Json;
      /** Milliseconds to wait for the answer. */
      readonly timeout?: number;
    }
  | ExtensionMessage;

/** Messages only a bundle's extension may send. Any other client gets `forbidden`. */
export type ExtensionMessage =
  /** Become, or stop being, the handler of a topic of the own bundle. Answered with `ok`. */
  | { readonly t: 'msg.handle' | 'msg.unhandle'; readonly id: number; readonly name: string }
  /** Register an HTTP route below `/b/<bundle>/api`. Answered with `ok`. */
  | {
      readonly t: 'http.route';
      readonly id: number;
      readonly method: HttpMethod;
      readonly pattern: string;
      /** A permission name from the bundle manifest. */
      readonly permission?: string;
    }
  /**
   * Ask whether a principal holds a permission of the own bundle, by the permission's name in
   * the manifest. Answered with `perm.res`.
   */
  | {
      readonly t: 'perm.check';
      readonly id: number;
      readonly principal: string;
      readonly permission: string;
    }
  /** The answer to a `msg.call` (any JSON) or an `http.call` (an `HttpResponseData`). */
  | { readonly t: 'call.ok'; readonly call: number; readonly data: Json }
  | {
      readonly t: 'call.err';
      readonly call: number;
      readonly code: ErrorCode;
      readonly message: string;
    };

/** A revision is only comparable within one epoch, the lifetime of one replicant instance. */
export interface KnownState {
  readonly epoch: string;
  readonly rev: number;
}

export const GRAPHIC_END_REASONS = ['replaced', 'disconnected'] as const;
export type GraphicEndReason = (typeof GRAPHIC_END_REASONS)[number];

/** `name` is always the qualified `bundle:name`. `id` echoes the request being answered. */
export type ServerMessage =
  | { readonly t: 'welcome'; readonly v: number }
  /**
   * To a page: load yourself again. Sent to one graphic page when an operator reloads it, and
   * to the pages of a bundle whose files changed while the server watches them.
   */
  | { readonly t: 'reload' }
  /**
   * To a graphic page: you are no longer the instance of your graphic. `replaced` when the
   * same principal opened it again, `disconnected` when an operator took the place away.
   * Either way the page is not to ask for the place again by itself.
   */
  | { readonly t: 'graphic.end'; readonly reason: GraphicEndReason }
  | {
      readonly t: 'rep.snap';
      readonly id: number;
      readonly name: string;
      readonly rev: number;
      readonly value: Json;
      readonly epoch: string;
    }
  | {
      readonly t: 'rep.patch';
      readonly name: string;
      readonly rev: number;
      readonly patches: readonly PatchOp[];
    }
  /** The replicant, or the message topic, was removed; the subscription has ended. */
  | { readonly t: 'rep.gone' | 'msg.gone'; readonly name: string; readonly message: string }
  /**
   * A replicant, or a message topic, the client asked for and could not have, or had and
   * lost, is declared again, as after its bundle was reloaded. Nothing is subscribed by it:
   * the client asks again with `rep.sub` or `msg.sub`, and is checked like the first time.
   */
  | { readonly t: 'rep.back' | 'msg.back'; readonly name: string }
  /** Answers a `rep.op`, or a `rep.sub` that needed no snapshot. */
  | { readonly t: 'ack'; readonly id: number; readonly rev: number }
  /** Answers a request that has nothing to return. */
  | { readonly t: 'ok'; readonly id: number }
  /** A message on a topic the client subscribed to. */
  | { readonly t: 'msg'; readonly name: string; readonly data: Json; readonly sender: Sender }
  /** The handler's answer to a `msg.req`. */
  | { readonly t: 'msg.res'; readonly id: number; readonly data: Json }
  /** Answers a `perm.check`. */
  | { readonly t: 'perm.res'; readonly id: number; readonly allowed: boolean }
  /** To an extension: answer this request with `call.ok` or `call.err`. */
  | {
      readonly t: 'msg.call';
      readonly call: number;
      readonly name: string;
      readonly data: Json;
      readonly sender: Sender;
    }
  /** To an extension: handle this HTTP request. `route` is the `id` of its `http.route`. */
  | {
      readonly t: 'http.call';
      readonly call: number;
      readonly route: number;
      readonly request: HttpRequestData;
    }
  | ErrorMessage;

export interface ErrorMessage {
  readonly t: 'err';
  readonly id?: number;
  readonly code: ErrorCode;
  readonly message: string;
}

export type Decoded<M> =
  | { readonly ok: true; readonly msg: M }
  | { readonly ok: false; readonly error: ErrorMessage };

export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Decodes and validates what a client sent. Malformed input yields a `bad_request` error. */
export function decodeClientMessage(text: string): Decoded<ClientMessage> {
  return decode(text, (m) => {
    switch (m.t) {
      case 'hello':
        if (!isRev(m.v) || typeof m.bundle !== 'string' || !BUNDLE_NAME_PATTERN.test(m.bundle)) {
          return null;
        }
        if (m.graphic === undefined) return { t: 'hello', v: m.v, bundle: m.bundle };
        return isFile(m.graphic)
          ? { t: 'hello', v: m.v, bundle: m.bundle, graphic: m.graphic }
          : null;
      case 'rep.sub':
        if (!isId(m.id) || !isName(m.name)) return null;
        if (m.since === undefined) return { t: 'rep.sub', id: m.id, name: m.name };
        return isKnownState(m.since)
          ? {
              t: 'rep.sub',
              id: m.id,
              name: m.name,
              since: { epoch: m.since.epoch, rev: m.since.rev },
            }
          : null;
      case 'rep.op':
        if (!isId(m.id) || !isName(m.name) || !isPatches(m.patches)) return null;
        if (m.baseRev === undefined) {
          return { t: 'rep.op', id: m.id, name: m.name, patches: m.patches };
        }
        return isRev(m.baseRev)
          ? { t: 'rep.op', id: m.id, name: m.name, baseRev: m.baseRev, patches: m.patches }
          : null;
      case 'msg.sub':
      case 'msg.unsub':
      case 'msg.handle':
      case 'msg.unhandle':
        return isId(m.id) && isName(m.name) ? { t: m.t, id: m.id, name: m.name } : null;
      case 'msg.send':
        return isId(m.id) && isName(m.name) && isJson(m.data)
          ? { t: 'msg.send', id: m.id, name: m.name, data: m.data }
          : null;
      case 'msg.req':
        if (!isId(m.id) || !isName(m.name) || !isJson(m.data)) return null;
        if (m.timeout === undefined) return { t: 'msg.req', id: m.id, name: m.name, data: m.data };
        return isRev(m.timeout)
          ? { t: 'msg.req', id: m.id, name: m.name, data: m.data, timeout: m.timeout }
          : null;
      case 'http.route': {
        if (!isId(m.id) || !isMethod(m.method)) return null;
        if (typeof m.pattern !== 'string' || !isRoutePattern(m.pattern)) return null;
        const route = { t: 'http.route', id: m.id, method: m.method, pattern: m.pattern } as const;
        if (m.permission === undefined) return route;
        return isName(m.permission) ? { ...route, permission: m.permission } : null;
      }
      case 'perm.check':
        return isId(m.id) && isName(m.principal) && isName(m.permission)
          ? { t: 'perm.check', id: m.id, principal: m.principal, permission: m.permission }
          : null;
      case 'call.ok':
        return isId(m.call) && isJson(m.data) ? { t: 'call.ok', call: m.call, data: m.data } : null;
      case 'call.err':
        return isId(m.call) && isErrorCode(m.code) && typeof m.message === 'string'
          ? { t: 'call.err', call: m.call, code: m.code, message: m.message }
          : null;
      default:
        return null;
    }
  });
}

/** Decodes and validates what the server sent. */
export function decodeServerMessage(text: string): Decoded<ServerMessage> {
  return decode(text, (m) => {
    switch (m.t) {
      case 'welcome':
        return isRev(m.v) ? { t: 'welcome', v: m.v } : null;
      case 'reload':
        return { t: 'reload' };
      case 'graphic.end': {
        const reason = GRAPHIC_END_REASONS.find((known) => known === m.reason);
        return reason ? { t: 'graphic.end', reason } : null;
      }
      case 'rep.snap':
        return isId(m.id) && isName(m.name) && isRev(m.rev) && isName(m.epoch) && isJson(m.value)
          ? { t: 'rep.snap', id: m.id, name: m.name, rev: m.rev, value: m.value, epoch: m.epoch }
          : null;
      case 'rep.gone':
      case 'msg.gone':
        return isName(m.name) && typeof m.message === 'string'
          ? { t: m.t, name: m.name, message: m.message }
          : null;
      case 'rep.back':
      case 'msg.back':
        return isName(m.name) ? { t: m.t, name: m.name } : null;
      case 'rep.patch':
        return isName(m.name) && isRev(m.rev) && isPatches(m.patches)
          ? { t: 'rep.patch', name: m.name, rev: m.rev, patches: m.patches }
          : null;
      case 'ack':
        return isId(m.id) && isRev(m.rev) ? { t: 'ack', id: m.id, rev: m.rev } : null;
      case 'ok':
        return isId(m.id) ? { t: 'ok', id: m.id } : null;
      case 'msg':
        return isName(m.name) && isJson(m.data) && isSender(m.sender)
          ? { t: 'msg', name: m.name, data: m.data, sender: senderOf(m.sender) }
          : null;
      case 'msg.res':
        return isId(m.id) && isJson(m.data) ? { t: 'msg.res', id: m.id, data: m.data } : null;
      case 'perm.res':
        return isId(m.id) && typeof m.allowed === 'boolean'
          ? { t: 'perm.res', id: m.id, allowed: m.allowed }
          : null;
      case 'msg.call':
        return isId(m.call) && isName(m.name) && isJson(m.data) && isSender(m.sender)
          ? { t: 'msg.call', call: m.call, name: m.name, data: m.data, sender: senderOf(m.sender) }
          : null;
      case 'http.call':
        return isId(m.call) && isId(m.route) && isHttpRequest(m.request)
          ? { t: 'http.call', call: m.call, route: m.route, request: m.request }
          : null;
      case 'err':
        if (!isErrorCode(m.code) || typeof m.message !== 'string') return null;
        if (m.id === undefined) return { t: 'err', code: m.code, message: m.message };
        return isId(m.id) ? { t: 'err', id: m.id, code: m.code, message: m.message } : null;
      default:
        return null;
    }
  });
}

function decode<M>(text: string, read: (raw: Record<string, unknown>) => M | null): Decoded<M> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return badRequest('Message is not valid JSON');
  }
  if (!isPlainObject(raw)) return badRequest('Message must be a JSON object');
  const msg = read(raw);
  if (msg !== null) return { ok: true, msg };
  const type = typeof raw.t === 'string' ? `"${raw.t}"` : 'without a type';
  return badRequest(`Malformed message ${type}`, isId(raw.id) ? raw.id : undefined);
}

function badRequest(message: string, id?: number): Decoded<never> {
  const error: ErrorMessage =
    id === undefined
      ? { t: 'err', code: 'bad_request', message }
      : { t: 'err', id, code: 'bad_request', message };
  return { ok: false, error };
}

function isId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRev(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/** A file inside a bundle, as a manifest names it. */
function isFile(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && isSafeRelativePath(value);
}

/** Also refuses a value nested deeper than the limit, before anything walks it. */
function isJson(value: unknown): value is Json {
  return jsonProblem(value) === null;
}

function isKnownState(value: unknown): value is KnownState {
  return isPlainObject(value) && isName(value.epoch) && isRev(value.rev);
}

function isSender(value: unknown): value is Sender {
  return (
    isPlainObject(value) &&
    isName(value.principal) &&
    isName(value.bundle) &&
    (PRINCIPAL_KINDS as readonly unknown[]).includes(value.kind)
  );
}

const senderOf = ({ principal, kind, bundle }: Sender): Sender => ({ principal, kind, bundle });

function isErrorCode(value: unknown): value is ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(value);
}

function isMethod(value: unknown): value is HttpMethod {
  return (HTTP_METHODS as readonly unknown[]).includes(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isHttpRequest(value: unknown): value is HttpRequestData {
  return (
    isPlainObject(value) &&
    isMethod(value.method) &&
    typeof value.path === 'string' &&
    isStringRecord(value.params) &&
    isStringRecord(value.query) &&
    isStringRecord(value.headers) &&
    (value.body === null || typeof value.body === 'string') &&
    isSender(value.sender)
  );
}

/** An HTTP header name is a token: no spaces, colons or control characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A header value has no line breaks or other control characters, which could forge headers. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\uffff]*$/;

/**
 * Whether a value an extension answered an HTTP call with is a usable response: a final
 * status (200 to 599, an informational one cannot be the answer) and well-formed headers.
 */
export function isHttpResponse(value: unknown): value is {
  status: number;
  headers: Record<string, string>;
  body: string | null;
} {
  return (
    isPlainObject(value) &&
    Number.isInteger(value.status) &&
    (value.status as number) >= 200 &&
    (value.status as number) <= 599 &&
    isStringRecord(value.headers) &&
    Object.entries(value.headers).every(
      ([name, header]) => HEADER_NAME.test(name) && HEADER_VALUE.test(header),
    ) &&
    (value.body === null || typeof value.body === 'string')
  );
}

function isPatches(value: unknown): value is PatchOp[] {
  return Array.isArray(value) && value.every(isPatch);
}

function isPatch(value: unknown): boolean {
  if (!isPlainObject(value) || typeof value.path !== 'string') return false;
  if (value.op === 'remove') return true;
  return (value.op === 'add' || value.op === 'replace') && isJson(value.value);
}
