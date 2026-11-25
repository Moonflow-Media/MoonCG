import { MoonCGError } from '../errors.js';
import type { Sender } from '../messages/bus.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A request as it is handed to a bundle's route handler. Plain data. */
export interface HttpRequestData {
  readonly method: HttpMethod;
  /** The path below `/b/<bundle>/api`, starting with `/`. */
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** The whole body, base64-encoded, or `null` without one or when it is streamed. */
  readonly body: string | null;
  /**
   * Set for a route that takes its body as a stream: it follows the call in `http.data`
   * messages and ends with `http.end`.
   */
  readonly stream?: true;
  /** Who is calling, in the same form as the sender of a message. */
  readonly sender: Sender;
}

/** What a route handler answers. Plain data. */
export interface HttpResponseData {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The body, base64-encoded, or `null` for none or when it is streamed. */
  readonly body: string | null;
  /** Set when the body follows as a stream of `http.data` messages. `body` is `null` then. */
  readonly stream?: true;
}

/** What a route answers on the server's side: a streamed body arrives as `stream`. */
export interface RouteAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  /** The body, piece by piece, when the handler streams it. Read it, or `return()` it. */
  readonly pieces?: AsyncIterable<Uint8Array> | undefined;
}

/** What the HTTP layer hands a route besides the request. */
export interface RouteCall {
  /**
   * The request body as it arrives, for a route that streams it. It throws when the client
   * goes away or the body breaks a limit; the call then fails with that error.
   */
  readonly body?: AsyncIterable<Uint8Array> | undefined;
  /** Aborted when the client went away: the extension is told to stop. */
  readonly signal?: AbortSignalLike | undefined;
}

/** The part of `AbortSignal` a route call uses. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface Route {
  readonly bundle: string;
  readonly method: HttpMethod;
  /** Such as `/teams/:id`. See `isRoutePattern`. */
  readonly pattern: string;
  /** The permission a caller needs. */
  readonly permission: string;
  /** Whether the route takes its request body as a stream instead of whole. */
  readonly stream?: boolean | undefined;
  /**
   * How many bytes a streamed request body may have. `null` for no limit, `undefined` for
   * the server's limit, which is also the limit of every route that does not stream.
   */
  readonly maxBodyBytes?: number | null | undefined;
  /** Rejects with a `MoonCGError`. */
  invoke(request: HttpRequestData, call?: RouteCall): Promise<RouteAnswer>;
}

const MAX_PATTERN_LENGTH = 200;
const SEGMENT = /^(:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9._~-]+)$/;

/**
 * A route pattern is `/` or `/`-separated segments, each either literal text
 * (letters, digits, `.`, `_`, `~`, `-`) or a parameter `:name`. Parameter names are unique.
 */
export function isRoutePattern(pattern: string): boolean {
  if (pattern === '/') return true;
  if (!pattern.startsWith('/') || pattern.length > MAX_PATTERN_LENGTH) return false;
  const segments = pattern.slice(1).split('/');
  const params = segments.filter((segment) => segment.startsWith(':'));
  return (
    segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..') &&
    new Set(params).size === params.length
  );
}

const segmentsOf = (path: string) => (path === '/' ? [] : path.slice(1).split('/'));

/** `/score/` asks for the same thing as `/score`: one trailing slash is dropped. */
export const normalizeRoutePath = (path: string) =>
  path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

/** A pattern with its parameter names taken out: `/u/:id` and `/u/:name` have one shape. */
const shapeOf = (pattern: string) =>
  segmentsOf(pattern)
    .map((segment) => (segment.startsWith(':') ? ':' : segment))
    .join('/');

/**
 * The routes bundles have registered. It can change at any time, which is why one fixed
 * server route dispatches through it instead of registering each route with the HTTP server.
 */
export class RouteTable {
  readonly #routes = new Set<Route>();

  /**
   * Returns the function that removes the route again. Refuses a pattern that matches exactly
   * the same paths as a registered one of that bundle and method, such as `/u/:id` next to
   * `/u/:name`: the second could never be reached.
   */
  add(route: Route): () => void {
    for (const existing of this.#routes) {
      if (
        existing.bundle === route.bundle &&
        existing.method === route.method &&
        shapeOf(existing.pattern) === shapeOf(route.pattern)
      ) {
        throw new MoonCGError(
          'conflict',
          `Route ${route.method} ${route.pattern} collides with ${existing.pattern}`,
        );
      }
    }
    this.#routes.add(route);
    return () => {
      this.#routes.delete(route);
    };
  }

  /**
   * `path` is the still percent-encoded path below `/b/<bundle>/api`; a trailing slash is
   * ignored. Where several patterns fit, the one with more literal segments wins, and among
   * those the one registered first.
   */
  match(
    bundle: string,
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    const wanted = segmentsOf(normalizeRoutePath(path));
    let best: { route: Route; params: Record<string, string>; literals: number } | undefined;
    for (const route of this.#routes) {
      if (route.bundle !== bundle || route.method !== method) continue;
      const pattern = segmentsOf(route.pattern);
      if (pattern.length !== wanted.length) continue;
      const params = matchSegments(pattern, wanted);
      const literals = pattern.filter((segment) => !segment.startsWith(':')).length;
      // A literal segment is more specific than a parameter.
      if (params && (!best || literals > best.literals)) best = { route, params, literals };
    }
    return best && { route: best.route, params: best.params };
  }

  /** The route of each method that would answer `path`, to tell a caller what is allowed. */
  methods(bundle: string, path: string): Route[] {
    return HTTP_METHODS.flatMap((method) => this.match(bundle, method, path)?.route ?? []);
  }

  count(bundle?: string): number {
    if (bundle === undefined) return this.#routes.size;
    return [...this.#routes].filter((route) => route.bundle === bundle).length;
  }
}

function matchSegments(
  pattern: readonly string[],
  wanted: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    let value: string;
    try {
      value = decodeURIComponent(wanted[index] as string);
    } catch {
      return undefined;
    }
    if (value === '') return undefined;
    if (segment.startsWith(':')) params[segment.slice(1)] = value;
    else if (segment !== value) return undefined;
  }
  return params;
}
