import {
  type HttpMethod,
  type HttpRequestData,
  type HttpResponseData,
  isPlainObject,
  type Json,
  jsonProblem,
  MoonCGError,
} from '@mooncg/core';
import type {
  Connection,
  MessageListener,
  Messaging,
  RequestHandler,
  SocketLike,
} from '../client/client.js';

export type { ErrorCode, Json, ReplicantHandle, ReplicantMeta, Sender } from '@mooncg/core';
export { MoonCGError } from '@mooncg/core';
export type {
  Connection,
  MessageListener,
  MessageMeta,
  ReplicantMap,
  RequestHandler,
  RequestOptions,
} from '../client/client.js';
export { createConnection } from '../client/client.js';

export interface BundleLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** An HTTP request to one of the bundle's routes. */
export interface HttpRequest {
  readonly method: HttpMethod;
  /** The path below `/b/<bundle>/api`, starting with `/`. */
  readonly path: string;
  /** The values of the `:name` parts of the route. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Header names are lowercase. */
  readonly headers: Readonly<Record<string, string>>;
  /** The whole body, or `undefined` without one. */
  readonly body: Uint8Array | undefined;
  /** The body as UTF-8 text. */
  text(): string;
  /** The body parsed as JSON. Fails the request with status 400 if it is not JSON. */
  json(): unknown;
}

/**
 * What a route answers. `body` decides the content type unless `headers` sets one: a string
 * is sent as text, a `Uint8Array` as bytes, anything else as JSON. `status` defaults to 200.
 */
export interface HttpResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Json | Uint8Array;
}

export type HttpHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export interface RouteOptions {
  /**
   * A permission declared in the bundle manifest that a caller needs. Without it the route
   * needs the bundle's general `access` permission.
   */
  readonly permission?: string;
}

type RegisterRoute = (path: string, handler: HttpHandler, options?: RouteOptions) => Promise<void>;

/**
 * Registers routes below `/b/<bundle>/api`. `path` is `/` or segments of literal text and
 * `:name` parameters, such as `/teams/:id`. Needs the `http.routes` capability.
 */
export interface BundleHttp {
  readonly get: RegisterRoute;
  readonly post: RegisterRoute;
  readonly put: RegisterRoute;
  readonly patch: RegisterRoute;
  readonly delete: RegisterRoute;
}

/**
 * What a bundle's extension receives. Everything that reaches the server is asynchronous,
 * because the extension runs in its own thread.
 *
 *     export default async function start(ctx) { ... }
 */
export interface BundleContext extends Messaging {
  readonly bundle: { readonly name: string; readonly version: string };
  readonly log: BundleLog;
  /** The bundle's configuration. Empty for now. */
  readonly config: Readonly<Record<string, Json>>;
  /**
   * Answers requests for a message of this bundle. There is one handler per message.
   * Resolves with the function that stops handling.
   */
  handle(name: string, handler: RequestHandler): Promise<() => void>;
  readonly http: BundleHttp;
  /** Registers cleanup to run when the extension stops. Callbacks run in reverse order. */
  onDispose(dispose: () => void | Promise<void>): void;
}

/** The default export of an extension's entry module. */
export type ExtensionMain = (ctx: BundleContext) => void | Promise<void>;

export interface BundleContextOptions {
  readonly connection: Connection;
  readonly bundle: { readonly name: string; readonly version: string };
  readonly log: BundleLog;
}

/**
 * Builds the context an extension works with on top of a connection to the server.
 * `dispose` runs the extension's cleanup and closes the connection.
 */
export function createBundleContext(options: BundleContextOptions): {
  context: BundleContext;
  dispose(): Promise<void>;
} {
  const { connection, bundle, log } = options;
  const disposers: (() => void | Promise<void>)[] = [];

  const register =
    (method: HttpMethod): RegisterRoute =>
    (path, handler, routeOptions = {}) =>
      connection.route(
        method,
        path,
        async (request) => toResponseData(await handler(toRequest(request))),
        routeOptions.permission,
      );

  const context: BundleContext = {
    bundle,
    log,
    config: {},
    replicant: ((name: string) => connection.replicant(name)) as BundleContext['replicant'],
    send: (name: string, data?: Json) => connection.send(name, data),
    on: (name: string, listener: MessageListener) => connection.on(name, listener),
    request: (name, data, requestOptions) => connection.request(name, data, requestOptions),
    handle: (name, handler) => connection.handle(name, handler),
    http: {
      get: register('GET'),
      post: register('POST'),
      put: register('PUT'),
      patch: register('PATCH'),
      delete: register('DELETE'),
    },
    onDispose: (dispose) => {
      disposers.push(dispose);
    },
  };

  return {
    context,
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          log.error(`A dispose callback failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      connection.close();
    },
  };
}

/** The two ends of an in-process connection: `socket` for the client, `server` for the host. */
export interface Loopback {
  readonly socket: SocketLike;
  readonly server: {
    /** Delivers a frame to the client. */
    send(frame: string): void;
    /** Called with each frame the client sends. */
    onFrame(listener: (frame: string) => void): void;
    /** Called once when either side closes. */
    onClose(listener: () => void): void;
    close(): void;
  };
}

/**
 * Connects a client to a server session inside one thread, without a socket. Used to run an
 * extension in the server's own process.
 */
export function createLoopback(): Loopback {
  const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
  const emit = (type: string, event: { data?: unknown }) => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  let onFrame: (frame: string) => void = () => {};
  let onClose: () => void = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
    emit('close', {});
  };
  // A real socket opens after the caller has attached its listeners; so does this one.
  queueMicrotask(() => {
    if (!closed) emit('open', {});
  });
  return {
    socket: {
      send: (data) => {
        if (!closed) onFrame(data);
      },
      close,
      addEventListener: (type, listener) => {
        listeners[type] = [...(listeners[type] ?? []), listener];
      },
    },
    server: {
      send: (frame) => {
        if (!closed) emit('message', { data: frame });
      },
      onFrame: (listener) => {
        onFrame = listener;
      },
      onClose: (listener) => {
        onClose = listener;
      },
      close,
    },
  };
}

const CONTENT_TYPE = 'content-type';

function toRequest(data: HttpRequestData): HttpRequest {
  const body = data.body === null ? undefined : fromBase64(data.body);
  const text = () => new TextDecoder().decode(body);
  return {
    method: data.method,
    path: data.path,
    params: data.params,
    query: data.query,
    headers: data.headers,
    body,
    text,
    json() {
      try {
        return JSON.parse(text());
      } catch {
        throw new MoonCGError('bad_request', 'The request body is not valid JSON');
      }
    },
  };
}

/** Checks what a route handler returned and puts it into the form that travels. */
function toResponseData(response: HttpResponse | undefined | null): HttpResponseData {
  if (response === undefined || response === null) return { status: 200, headers: {}, body: null };
  const unusable = (what: string) =>
    new Error(`A route handler must return { status?, headers?, body? }: ${what}`);
  if (!isPlainObject(response)) throw unusable('it returned something else');
  // What the handler returned is checked here, whatever its declared type says.
  const { status = 200, body } = response as { status?: unknown; body?: HttpResponse['body'] };
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    throw unusable('status must be a number from 200 to 599');
  }
  if (response.headers !== undefined && !isPlainObject(response.headers)) {
    throw unusable('headers must be an object');
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers[name.toLowerCase()] = String(value);
  }
  let bytes: Uint8Array | undefined;
  let contentType: string | undefined;
  if (body instanceof Uint8Array) {
    bytes = body;
    contentType = 'application/octet-stream';
  } else if (typeof body === 'string') {
    bytes = new TextEncoder().encode(body);
    contentType = 'text/plain; charset=utf-8';
  } else if (body !== undefined) {
    const problem = jsonProblem(body);
    if (problem !== null) throw unusable(`body is not JSON (${problem})`);
    bytes = new TextEncoder().encode(JSON.stringify(body));
    contentType = 'application/json; charset=utf-8';
  }
  if (contentType !== undefined) headers[CONTENT_TYPE] ??= contentType;
  return {
    status,
    headers,
    body: bytes === undefined ? null : toBase64(bytes),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks, because a call takes only so many arguments.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
