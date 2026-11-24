import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import {
  authorize,
  BUNDLE_NAME_PATTERN,
  BUNDLES_MANAGE,
  bundlePermission,
  DASHBOARD_VIEW,
  type ErrorCode,
  HTTP_METHODS,
  type HttpMethod,
  isSafeRelativePath,
  MoonCGError,
  normalizeRoutePath,
  type Policy,
  type RouteTable,
} from '@mooncg/core';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Auth } from '../auth/auth.js';
import { redactSecrets } from '../auth/secrets.js';
import type { BundleRecord } from '../bundles/bundles.js';
import { registerAuthRoutes } from './auth-routes.js';
import {
  createIdentify,
  type Identify,
  type RequestIdentity,
  type ResolvePrincipal,
  secureCookies,
  sessionCookie,
  TOKEN_COOKIE,
  viaHttps,
} from './identity.js';
import { originAllowed } from './origin.js';

export { type ResolvePrincipal, resolveLocalAdmin } from './identity.js';

/** The largest request body a bundle route accepts, unless configured otherwise. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * A state-changing request authenticated by a cookie must either carry JSON or this header.
 * A page of another site can make a browser send neither along with the cookie.
 */
export const CSRF_HEADER = 'x-mooncg-csrf';

/**
 * What the server's own pages (the shell, login, setup) may load and where they may appear:
 * only what this server serves, styles written into the page, no plugins, no `<base>`, forms
 * that post back here, and never inside a frame. Bundle content gets no such policy: what a
 * bundle's pages load is the bundle author's business.
 */
export const BUILT_IN_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Changes a bundle's state. Each rejects with a `MoonCGError`. */
export interface BundleLifecycle {
  enable(name: string): Promise<BundleRecord>;
  disable(name: string): Promise<BundleRecord>;
  reload(name: string): Promise<BundleRecord>;
}

export interface AppOptions {
  /** The bundles as they are now. A function, because bundles change while the server runs. */
  readonly bundles: readonly BundleRecord[] | (() => readonly BundleRecord[]);
  /** Path of the SDK's browser build, served at `/sdk/mooncg.js`. */
  readonly sdkFile: string | undefined;
  /**
   * Accounts and permissions. With it the app serves login, setup and the user, role and
   * token APIs, and identifies every request by its session cookie or API token.
   */
  readonly auth?: Auth | undefined;
  /**
   * For tests: who every request acts as, and against which policy, instead of asking `auth`.
   * Without `auth` and without these, every request is anonymous and is refused.
   */
  readonly policy?: Policy;
  readonly resolvePrincipal?: ResolvePrincipal;
  /** The routes bundle extensions registered, served below `/b/<bundle>/api`. */
  readonly routes?: RouteTable | undefined;
  /** Without it the lifecycle API answers 404. */
  readonly lifecycle?: BundleLifecycle | undefined;
  readonly maxBodyBytes?: number | undefined;
  /** Origins besides the server's own whose pages may send state-changing requests. */
  readonly allowedOrigins?: readonly string[] | undefined;
  /** Marks session cookies `Secure` on every request. */
  readonly secureCookies?: boolean | undefined;
  /** Believes `X-Forwarded-Proto` and `X-Forwarded-For`. Only behind a reverse proxy. */
  readonly trustProxy?: boolean | undefined;
}

const SERVED_AREAS = new Set(['dashboard', 'graphics']);
const LIFECYCLE_ACTIONS = ['enable', 'disable', 'reload'] as const;

/** Headers a bundle route may not set: they describe the connection, which the server owns. */
const CONNECTION_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request headers a bundle route never sees: they are the caller's credentials. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);
/** The query parameter an API token may arrive in. A bundle route never sees it either. */
const TOKEN_PARAMETER = 'token';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** The HTTP status for an error a bundle route or a lifecycle change ended with. */
const STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
  unavailable: 503,
  timeout: 504,
};

const publicFile = (name: string) => new URL(`../../public/${name}`, import.meta.url);

/** What the API tells about a bundle's state. The same shape as in `system:bundles`. */
function describeBundle({ name, state, manifest, errors, lastError }: BundleRecord) {
  return { name, state, title: manifest?.title, version: manifest?.version, errors, lastError };
}

/** What the routes for accounts need from the application they are part of. */
export interface HttpContext {
  readonly auth: Auth;
  identityOf(request: FastifyRequest): RequestIdentity;
  can(request: FastifyRequest, permission: string): boolean;
  /** Answers 401 to an anonymous request and 403 to anyone else. */
  deny(request: FastifyRequest, reply: FastifyReply, permission: string): FastifyReply;
  fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply;
  failWith(reply: FastifyReply, error: unknown): FastifyReply;
  /** Whether cookies set in answer to this request are marked `Secure`. */
  secure(request: FastifyRequest): boolean;
  /** The address a login attempt is counted against. */
  remoteAddress(request: FastifyRequest): string;
  /** Sends one of the server's own files; a page goes out with the built-in policy. */
  sendPage(reply: FastifyReply, name: string): Promise<FastifyReply>;
}

/** Builds the HTTP application. Every route checks `authorize()` before it answers. */
export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const { sdkFile, routes, lifecycle, auth } = options;
  const bundles = () =>
    typeof options.bundles === 'function' ? options.bundles() : options.bundles;
  const running = (name: string) =>
    bundles().find((candidate) => candidate.name === name && candidate.state === 'running');
  const identify: Identify = createIdentify(options);
  const shellPage = await readFile(publicFile('index.html'), 'utf8');
  const shellScript = await readFile(publicFile('shell.js'), 'utf8');
  // No message leaves the server with an API token in it, whatever put it there.
  const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.code(status).send({ error: { code, message: redactSecrets(message) } });
  /** Answers for an error the HTTP layer itself raised, such as a body that is too large. */
  const refuse = (reply: FastifyReply, error: unknown) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (status === 413) return fail(reply, 413, 'bad_request', 'The request body is too large');
    if (status === 404) return fail(reply, 404, 'not_found', 'Not found');
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return fail(reply, status, 'bad_request', 'The request could not be understood');
    }
    return fail(reply, 500, 'internal', 'The request could not be completed');
  };
  const app = fastify({
    bodyLimit: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    // Errors raised before routing, such as a malformed URL.
    frameworkErrors: (error, _request, reply) => {
      refuse(reply, error);
    },
    // Shutting down must not wait for a client that keeps a connection busy.
    forceCloseConnections: true,
  });

  // Bodies are handed to bundle routes as they came, whatever their content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  /** A request is identified once, however many permissions are checked for it. */
  const identities = new WeakMap<object, RequestIdentity>();
  const identityOf = (request: FastifyRequest): RequestIdentity => {
    let identity = identities.get(request.raw);
    if (!identity) {
      identity = identify(request.raw);
      identities.set(request.raw, identity);
    }
    return identity;
  };
  const can = (request: FastifyRequest, permission: string) => {
    const { principal, policy } = identityOf(request);
    return authorize(principal, permission, policy);
  };
  const anonymous = (request: FastifyRequest) => identityOf(request).principal.kind === 'anonymous';
  const unauthenticated = (reply: FastifyReply) =>
    fail(reply, 401, 'forbidden', 'Authentication required');
  const deny = (request: FastifyRequest, reply: FastifyReply, permission: string) =>
    anonymous(request)
      ? unauthenticated(reply)
      : fail(reply, 403, 'forbidden', `Missing permission "${permission}"`);
  const notFound = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'Not found');
  /** Answers with a typed error. Anything else is a bug: its details stay out of the answer. */
  const failWith = (reply: FastifyReply, error: unknown) => {
    if (error instanceof MoonCGError && error.code !== 'disconnected') {
      return fail(reply, STATUS[error.code], error.code, error.message);
    }
    return fail(reply, 500, 'internal', 'The request could not be completed');
  };
  const requireDashboard = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!can(request, DASHBOARD_VIEW)) return deny(request, reply, DASHBOARD_VIEW);
    },
  };
  const secure = (request: FastifyRequest) => secureCookies(request.headers, options);
  /** One of the server's own pages: never framed, and loading only what this server serves. */
  const builtIn = (reply: FastifyReply) =>
    reply
      .header('content-security-policy', BUILT_IN_CSP)
      .header('x-frame-options', 'DENY')
      .type(CONTENT_TYPES['.html'] as string);
  const sendPage = async (reply: FastifyReply, name: string) => {
    const content = await readFile(publicFile(name), 'utf8');
    return name.endsWith('.html')
      ? builtIn(reply).send(content)
      : reply.type(CONTENT_TYPES[extname(name)] ?? 'text/plain').send(content);
  };

  app.setNotFoundHandler((_request, reply) => notFound(reply));
  // Whatever goes wrong before a route answers gets the same envelope as everything else.
  app.setErrorHandler((error, _request, reply) => refuse(reply, error));

  // Set first, so they are on every answer, also on one a later hook or an error gives.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin');
  });

  // An API token in the URL of a bundle page is exchanged for a cookie, and the browser is
  // sent on to the same URL without it. That is how a browser source in OBS signs in: it can
  // send no header, and the token must not stay in a URL that pages and logs get to see.
  app.addHook('onRequest', async (request, reply) => {
    if (!auth || (request.method !== 'GET' && request.method !== 'HEAD')) return;
    const [path = '', query] = (request.raw.url ?? '').split('?');
    if (!path.startsWith('/b/') || query === undefined) return;
    const parameters = query.split('&');
    const isToken = (parameter: string) => parameter.split('=')[0] === TOKEN_PARAMETER;
    const given = parameters.find(isToken);
    if (given === undefined) return;
    const rest = parameters.filter((parameter) => !isToken(parameter)).join('&');
    const clean = reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer');
    const onward = () => clean.redirect(rest === '' ? path : `${path}?${rest}`, 302);
    // Whoever is signed in already stays who they are: the token is neither needed nor
    // looked at, only taken out of the URL. A stale token in a bookmark must not lock out
    // someone with a valid session.
    if (!anonymous(request)) return onward();
    let exchanged: ReturnType<typeof auth.exchangeToken>;
    try {
      exchanged = auth.exchangeToken(decodeURIComponent(given.slice(TOKEN_PARAMETER.length + 1)));
    } catch {
      // Not even well-formed: refused like any other unusable token.
    }
    if (exchanged === undefined) return unauthenticated(reply);
    clean.header(
      'set-cookie',
      sessionCookie(TOKEN_COOKIE, exchanged.session, {
        secure: secure(request),
        maxAge: exchanged.maxAgeSeconds,
      }),
    );
    return onward();
  });

  // A page of another site must not change anything here through a visitor's browser.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const https = viaHttps(request.headers, options);
    if (!originAllowed(request.headers, options.allowedOrigins ?? [], https)) {
      return fail(reply, 403, 'forbidden', 'Requests from this origin are not allowed');
    }
    // A browser attaches cookies by itself, so a cookie alone does not prove that the page
    // meant to send this request. A token in a header is only ever sent on purpose.
    const { via } = identityOf(request);
    if (via !== 'session' && via !== 'token-session') return;
    const json = request.headers['content-type']?.toLowerCase().startsWith('application/json');
    if (!json && request.headers[CSRF_HEADER] === undefined) {
      return fail(
        reply,
        403,
        'forbidden',
        'A request that changes something needs a JSON body or the header "X-MoonCG-CSRF"',
      );
    }
  });

  // What the API answers is about one caller and may hold a secret shown once.
  app.addHook('onSend', async (request, reply) => {
    if (request.raw.url?.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.get('/', async (request, reply) => {
    // Whoever is not signed in is sent where that can be done.
    if (auth && anonymous(request)) {
      return reply.redirect(auth.setupCode() === undefined ? '/login' : '/setup', 302);
    }
    if (!can(request, DASHBOARD_VIEW)) return deny(request, reply, DASHBOARD_VIEW);
    return builtIn(reply).send(shellPage);
  });

  app.get('/shell.js', requireDashboard, (_request, reply) =>
    reply.type(CONTENT_TYPES['.js'] as string).send(shellScript),
  );

  // The SDK is what every page of a bundle loads, also a graphic opened with a token that
  // holds nothing but one bundle permission. So it takes being signed in, and no more.
  app.get('/sdk/mooncg.js', async (request, reply) => {
    if (anonymous(request)) return unauthenticated(reply);
    const script = sdkFile === undefined ? undefined : await readFile(sdkFile).catch(() => {});
    if (!script) {
      return fail(reply, 404, 'not_found', 'The SDK is not built yet. Run "pnpm build".');
    }
    return reply.type(CONTENT_TYPES['.js'] as string).send(script);
  });

  app.get('/api/v1/bundles', requireDashboard, (request) => {
    const usable = (item: { requires?: string | undefined }, bundle: string) =>
      can(request, bundlePermission(bundle, item.requires));
    const canManage = can(request, BUNDLES_MANAGE);
    return {
      canManage,
      bundles: bundles()
        // A bundle shows only to those who may manage bundles or hold a permission of it.
        .filter(({ name }) => canManage || can(request, bundlePermission(name, undefined)))
        .map((record) => {
          const { name, manifest } = record;
          const served = record.state === 'running' ? manifest : undefined;
          return {
            ...describeBundle(record),
            panels: (served?.panels ?? [])
              .filter((panel) => usable(panel, name))
              .map(({ id, title, width, workspace, file }) => ({
                id,
                title,
                width,
                workspace,
                url: fileUrl(name, file),
              })),
            graphics: (served?.graphics ?? [])
              .filter((graphic) => usable(graphic, name))
              .map(({ id, title, width, height, file }) => ({
                id,
                title,
                width,
                height,
                url: fileUrl(name, file),
              })),
          };
        }),
    };
  });

  app.post<{ Params: { name: string; action: string } }>(
    '/api/v1/bundles/:name/:action',
    async (request, reply) => {
      const { name, action } = request.params;
      const change = LIFECYCLE_ACTIONS.find((candidate) => candidate === action);
      // Only what can be a bundle name gets as far as the bundle manager.
      if (!lifecycle || !change || !BUNDLE_NAME_PATTERN.test(name)) return notFound(reply);
      if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
      try {
        return { bundle: describeBundle(await lifecycle[change](name)) };
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  if (auth) {
    registerAuthRoutes(app, {
      auth,
      identityOf,
      can,
      deny,
      fail,
      failWith,
      secure,
      // Behind a proxy every connection comes from the proxy; it appends the real client.
      remoteAddress: (request) => {
        const forwarded = options.trustProxy ? request.headers['x-forwarded-for'] : undefined;
        const last = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(',').at(-1);
        // Cut to the longest an address can be, whatever a proxy passed on.
        return (last?.trim() || (request.raw.socket.remoteAddress ?? 'unknown')).slice(0, 64);
      },
      sendPage,
    });
  }

  /** Dispatches to the routes bundle extensions registered. They come and go at run time. */
  const dispatch = async (
    request: FastifyRequest<{ Params: { bundle: string } }>,
    reply: FastifyReply,
  ) => {
    const { bundle } = request.params;
    // Nothing about a bundle's routes is told to someone who is not signed in, and nothing
    // about a bundle to someone who holds none of its permissions: for them it is not there.
    if (anonymous(request)) return unauthenticated(reply);
    if (!can(request, bundlePermission(bundle, undefined))) return notFound(reply);
    // The path below `/b/<bundle>/api`, still percent-encoded: the first four parts of the
    // raw path are '', 'b', the bundle (however it was written) and 'api'.
    const rawPath = request.raw.url?.split('?')[0] ?? '';
    const path = normalizeRoutePath(`/${rawPath.split('/').slice(4).join('/')}`);
    // HEAD is answered like GET; the body is left out when the answer is sent.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const match = running(bundle) && routes?.match(bundle, method, path);
    if (!match) {
      // A path that exists under another method says which methods it takes.
      const others = (running(bundle) ? (routes?.methods(bundle, path) ?? []) : []).filter(
        (other) => can(request, other.permission),
      );
      if (others.length === 0) return notFound(reply);
      const allow = others.flatMap((other) =>
        other.method === 'GET' ? ['GET', 'HEAD'] : [other.method],
      );
      reply.header('allow', allow.join(', '));
      return fail(reply, 405, 'bad_request', `${request.method} is not allowed for this path`);
    }
    const { route, params } = match;
    if (!can(request, route.permission)) return deny(request, reply, route.permission);
    const { principal } = identityOf(request);
    try {
      const response = await route.invoke({
        method: method as HttpMethod,
        path,
        params,
        query: flatten(request.query as Record<string, unknown>, new Set([TOKEN_PARAMETER])),
        headers: flatten(request.headers, CREDENTIAL_HEADERS),
        body: Buffer.isBuffer(request.body) ? request.body.toString('base64') : null,
        sender: { principal: principal.id, kind: principal.kind ?? 'user', bundle },
      });
      reply.code(response.status);
      for (const [name, value] of Object.entries(response.headers)) {
        // How the answer travels is the server's business, not the handler's.
        if (!CONNECTION_HEADERS.has(name.toLowerCase())) reply.header(name, value);
      }
      return reply.send(response.body === null ? undefined : Buffer.from(response.body, 'base64'));
    } catch (error) {
      return failWith(reply, error);
    }
  };
  // HEAD comes with GET. OPTIONS is taken so that it is answered like any other method
  // without a route: 405 with the methods the path does take.
  const methods = [...HTTP_METHODS, 'OPTIONS' as const];
  app.route({ method: methods, url: '/b/:bundle/api', handler: dispatch });
  app.route({ method: methods, url: '/b/:bundle/api/*', handler: dispatch });

  app.get<{ Params: { bundle: string; area: string; '*': string } }>(
    '/b/:bundle/:area/*',
    async (request, reply) => {
      const { bundle: name, area, '*': rest } = request.params;
      // Whether a bundle or a file exists is told only to someone who is signed in.
      if (anonymous(request)) return unauthenticated(reply);
      // A bundle the caller holds nothing of is answered like one that does not exist.
      if (!can(request, bundlePermission(name, undefined))) return notFound(reply);
      const bundle = running(name);
      if (!bundle?.manifest || !SERVED_AREAS.has(area) || !isSafeRelativePath(rest)) {
        return notFound(reply);
      }
      // A panel or graphic entry file needs what its manifest entry requires; any other file
      // is open to whoever holds a permission of the bundle. The lookup is by exact name,
      // which is safe because only a file with exactly this name is ever served.
      const file = `${area}/${rest}`;
      const { panels, dialogs, graphics } = bundle.manifest;
      const entry = [...panels, ...dialogs, ...graphics].find((item) => item.file === file);
      const permission = bundlePermission(name, entry?.requires);
      if (!can(request, permission)) return deny(request, reply, permission);

      const path = await canonicalFile(join(bundle.dir, area), rest);
      if (path === undefined) return notFound(reply);
      return (
        reply
          .type(CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
          .header('cache-control', 'no-cache')
          // Panels are framed by the shell; no other site may frame a bundle's page.
          .header('content-security-policy', "frame-ancestors 'self'")
          .header('x-frame-options', 'SAMEORIGIN')
          .send(createReadStream(path))
      );
    },
  );

  return app;
}

/** Keeps the string values of a query or header map; of a repeated one, the first. */
function flatten(
  values: Readonly<Record<string, unknown>>,
  without: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && !without.has(name)) flat[name] = first;
  }
  return flat;
}

/** The URL of a bundle file, with every path segment percent-encoded. */
function fileUrl(bundle: string, file: string): string {
  return `/b/${encodeURIComponent(bundle)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Resolves a requested file to its real location on disk. Answers `undefined` unless that is a
 * file whose real path, relative to the real area directory, is exactly the requested one.
 * This rejects names that differ only in case on a case-insensitive file system, and anything
 * reached through a symlink or junction, including one that points outside the area.
 */
async function canonicalFile(areaDir: string, requested: string): Promise<string | undefined> {
  try {
    const root = await realpath(areaDir);
    const real = await realpath(join(root, requested));
    if (relative(root, real).split(sep).join('/') !== requested) return undefined;
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}
