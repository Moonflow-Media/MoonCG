import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
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
  LOGS_VIEW,
  MODULES_MANAGE,
  MoonCGError,
  normalizeRoutePath,
  type Policy,
  type RouteAnswer,
  type RouteTable,
  SETTINGS_MANAGE,
} from '@mooncg/core';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { assetType } from '../assets/names.js';
import { AssetError, type AssetStore } from '../assets/store.js';
import type { Auth } from '../auth/auth.js';
import { redactSecrets } from '../auth/secrets.js';
import type { BundleRecord } from '../bundles/bundles.js';
import type { OnAirOverride } from '../bundles/manager.js';
import type { BundleConfigs } from '../config/bundle-config.js';
import type { OnAirLock } from '../dev/on-air.js';
import type { GraphicInstances } from '../graphics/instances.js';
import type { BundleInstaller } from '../install/installer.js';
import type { ModuleInstaller } from '../install/module-installer.js';
import type { FetchableSource } from '../install/sources.js';
import type { LogBuffer } from '../kernel/logger.js';
import { localPasswordProvider } from '../modules/auth-local.js';
import { ProviderRegistry } from '../modules/providers.js';
import { jsonBody, registerAuthRoutes } from './auth-routes.js';
import { readWhole, requestBody, type UploadPace } from './bodies.js';
import {
  createIdentify,
  credentialsOf,
  devLinkTarget,
  devLoginAllowed,
  devLoginHeldBack,
  type Identify,
  type RequestIdentity,
  type ResolvePrincipal,
  SESSION_COOKIE,
  secureCookies,
  sessionCookie,
  TOKEN_COOKIE,
  TOKEN_PARAMETER,
  type Transport,
  viaHttps,
} from './identity.js';
import { escapeHtml } from './login-page.js';
import { type ModuleHttp, registerModuleRoutes } from './module-routes.js';
import { devOrigins, devServerUrl, originAllowed } from './origin.js';
import { type RegistryHttp, registerRegistryRoutes } from './registry-routes.js';
import {
  ASSET_CSP,
  CONNECTION_HEADERS,
  CREDENTIAL_HEADERS,
  canonicalFile,
  flatten,
} from './shared.js';

export { type ResolvePrincipal, resolveLocalAdmin } from './identity.js';
export { ASSET_CSP } from './shared.js';

/** The largest request body a bundle route accepts, unless configured otherwise. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The largest streamed request body any bundle route accepts, whatever the route asks for,
 * also with `maxBodyBytes: null`: 1 GiB. That is a few minutes of video at a high bitrate,
 * enough for the uploads a show needs, and it keeps a route without a limit from filling the
 * disk of the extension that stores what arrives. An operator raises it on purpose.
 */
export const DEFAULT_MAX_STREAM_BODY_BYTES = 1024 ** 3;

/**
 * How long a streamed answer may wait for its client to take the next piece before it is cut
 * off and the extension's source is stopped. Waiting for the extension does not count.
 */
export const DEFAULT_STREAM_DRAIN_TIMEOUT_MS = 30_000;

/** How long a connection that is closed early still takes what the client sends. */
const LINGER_MS = 2_000;

/**
 * A state-changing request authenticated by a cookie must either carry JSON or this header.
 * A page of another site can make a browser send neither along with the cookie.
 */
export const CSRF_HEADER = 'x-mooncg-csrf';

/**
 * What the server's own pages (the shell, login, setup) may load and where they may appear:
 * only what this server serves, styles from its files and none written into a page, no
 * plugins, no `<base>`, forms that post back here, and never inside a frame. Bundle content gets no such policy: what a
 * bundle's pages load is the bundle author's business.
 */
export const BUILT_IN_CSP = [
  "default-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Changes a bundle's state. Each rejects with a `MoonCGError`. `forceOnAir` lets a change
 * through although the installation is on air.
 */
export interface BundleLifecycle {
  enable(name: string): Promise<BundleRecord>;
  disable(name: string, options?: OnAirOverride): Promise<BundleRecord>;
  reload(name: string, options?: OnAirOverride): Promise<BundleRecord>;
  /** Starts the extension of a running bundle again, with the configuration as it is now. */
  restartExtension?(name: string, options?: OnAirOverride): Promise<BundleRecord>;
}

/** What the API needs of the installer. */
export type BundleInstalls = Pick<
  BundleInstaller,
  | 'stage'
  | 'staged'
  | 'commit'
  | 'discard'
  | 'update'
  | 'remove'
  | 'backups'
  | 'allBackups'
  | 'restore'
  | 'jobs'
  | 'job'
  | 'sources'
  | 'limits'
>;

/** What the API needs of the module installer. */
export type ModuleInstalls = Pick<
  ModuleInstaller,
  'stage' | 'staged' | 'commit' | 'discard' | 'update' | 'remove' | 'jobs' | 'job' | 'sources'
>;

export interface AppOptions {
  /** The bundles as they are now. A function, because bundles change while the server runs. */
  readonly bundles: readonly BundleRecord[] | (() => readonly BundleRecord[]);
  /** Path of the SDK's browser build, served at `/sdk/mooncg.js`. */
  readonly sdkFile: string | undefined;
  /**
   * The folder with the built dashboard: `index.html` and its files under `ui/`. Without it
   * the dashboard routes answer 404.
   */
  readonly dashboardDir?: string | undefined;
  /** The latest lines of the server log, for `GET /api/v1/logs`. Without it that is a 404. */
  readonly logs?: LogBuffer | undefined;
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
  /** Installs, updates and removes bundles. Without it that part of the API answers 404. */
  readonly installer?: BundleInstalls | undefined;
  /** Installs, updates and removes modules. Without it that part of the API answers 404. */
  readonly moduleInstaller?: ModuleInstalls | undefined;
  /** The registry indexes and the catalog. Without it their API answers 404. */
  readonly registry?: RegistryHttp | undefined;
  /** The connected graphic pages. Without it no instance can be reloaded. */
  readonly instances?: Pick<GraphicInstances, 'get' | 'reload' | 'disconnect' | 'of'> | undefined;
  /** The files uploaded for each bundle. Without it there are no assets. */
  readonly assets?: AssetStore | undefined;
  /** The configuration of each bundle. Without it the configuration API answers 404. */
  readonly config?: Pick<BundleConfigs, 'describe' | 'write' | 'scrub'> | undefined;
  readonly maxBodyBytes?: number | undefined;
  /**
   * The largest streamed request body a bundle route accepts, in bytes, whatever the route
   * itself allows. `DEFAULT_MAX_STREAM_BODY_BYTES` without it.
   */
  readonly maxStreamBodyBytes?: number | undefined;
  /** How fast a client must send a request body to a bundle route. For tests. */
  readonly uploadPace?: UploadPace | undefined;
  /** See `DEFAULT_STREAM_DRAIN_TIMEOUT_MS`. For tests. */
  readonly streamDrainTimeoutMs?: number | undefined;
  /** Origins besides the server's own whose pages may send state-changing requests. */
  readonly allowedOrigins?: readonly string[] | undefined;
  /** Marks session cookies `Secure` on every request. */
  readonly secureCookies?: boolean | undefined;
  /** Believes `X-Forwarded-Proto` and `X-Forwarded-For`. Only behind a reverse proxy. */
  readonly trustProxy?: boolean | undefined;
  /**
   * The origin people reach the server at. When it is an `https://` one, requests addressed
   * to it are answered as requests over HTTPS: see `viaHttps`. Without it, what `modules`
   * names as the public address counts.
   */
  readonly publicUrl?: string | undefined;
  /**
   * Dev mode: the `dev.url` of a manifest is honoured. Requests for that bundle's pages are
   * sent on to its development server, whose origin may then be framed by the dashboard and
   * send requests. Nothing of that exists without it.
   */
  readonly dev?: boolean | undefined;
  /** Dev mode: who a request from this machine without credentials acts as. */
  readonly devLogin?: (() => RequestIdentity) | undefined;
  /** The "On Air" lock. Without it the API for it answers 404. */
  readonly onAir?: Pick<OnAirLock, 'state' | 'set' | 'reason'> | undefined;
  /**
   * The ways to sign in. Without it there is the local login and nothing else: the registry
   * the server builds also has what modules registered.
   */
  readonly providers?: ProviderRegistry | undefined;
  /**
   * Modules and external logins. Without it their routes and their API answer 404. Needs
   * `auth`.
   */
  readonly modules?: ModuleHttp | undefined;
}

const SERVED_AREAS = new Set(['dashboard', 'graphics']);
/** The paths the dashboard application draws. Each is answered with its one page. */
export const DASHBOARD_ROUTES = [
  '/',
  '/w/:workspace',
  '/bundles',
  '/bundles/catalog',
  '/graphics',
  '/assets',
  '/admin/users',
  '/admin/roles',
  '/admin/tokens',
  '/settings',
  '/modules',
  '/logs',
  '/account',
] as const;
const LIFECYCLE_ACTIONS = ['enable', 'disable', 'reload'] as const;
/**
 * The path segment under `/api/v1/bundles` that everything about installing lives below. A
 * dash is not the name of a bundle, so no bundle can ever be in its way.
 */
const INSTALLS = '/api/v1/bundles/-';

/**
 * A source as a JSON request names it: something the server fetches itself. An upload is
 * not among them; it is the body of a `PUT`. Only the known fields are taken over, so that
 * nothing a request adds reaches the installer.
 */
function fetchableSource(value: unknown): FetchableSource {
  const given =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const { type, url, ref, path, sha256 } = given;
  if (type === 'git' && typeof url === 'string' && (ref === undefined || typeof ref === 'string')) {
    return { type, url, ...(ref === undefined ? {} : { ref }) };
  }
  if ((type === 'path' || type === 'zip') && typeof path === 'string') return { type, path };
  if (type === 'url' && typeof url === 'string' && typeof sha256 === 'string') {
    return { type, url, sha256 };
  }
  throw new MoonCGError(
    'invalid',
    '"source" must be { type: "git", url, ref? }, { type: "path", path }, { type: "zip", path } or { type: "url", url, sha256 }',
  );
}

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

/** Where the page for a link from another site in dev mode has its target put in. */
const DEV_LINK_SLOT = '<!-- target -->';

const publicFile = (name: string) => new URL(`../../public/${name}`, import.meta.url);

/** What the API tells about a bundle's state. The same shape as in `system:bundles`. */
function describeBundle(record: BundleRecord) {
  const { name, state, manifest, errors, lastError, reloadErrors, pendingChanges } = record;
  return {
    name,
    state,
    title: manifest?.title,
    version: manifest?.version,
    errors,
    lastError,
    reloadErrors,
    pendingChanges,
  };
}

/**
 * Whether a request asks to go ahead although the installation is on air: with a plain
 * `true` as `forceOnAir` in its JSON body, and with nothing else. `force` is another word,
 * for removing a bundle that others still need, and overrides no lock.
 */
function overridesOnAir(request: FastifyRequest): boolean {
  try {
    return jsonBody(request).forceOnAir === true;
  } catch {
    // No body, or none that is JSON: nothing was overridden.
    return false;
  }
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
  /**
   * Sends one of the server's own files; a page goes out with the built-in policy. `fill`
   * gets the content and answers what is sent in its place.
   */
  sendPage(
    reply: FastifyReply,
    name: string,
    fill?: (content: string) => string,
  ): Promise<FastifyReply>;
  /** The ways to sign in. */
  readonly providers: ProviderRegistry;
}

/** Builds the HTTP application. Every route checks `authorize()` before it answers. */
export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const { sdkFile, routes, lifecycle, auth } = options;
  const bundles = () =>
    typeof options.bundles === 'function' ? options.bundles() : options.bundles;
  const running = (name: string) =>
    bundles().find((candidate) => candidate.name === name && candidate.state === 'running');
  /** How the server is reached: one answer for cookies, for origins and for who a request is. */
  const transport: Transport = {
    secureCookies: options.secureCookies,
    trustProxy: options.trustProxy,
    publicUrl: options.publicUrl ?? options.modules?.publicUrl,
  };
  const identify: Identify = createIdentify({ ...options, ...transport });
  const { dashboardDir, onAir } = options;
  /** The origins besides the server's own that pages may come from, as of now. */
  const allowedOrigins = () => {
    const configured = options.allowedOrigins ?? [];
    return options.dev ? [...configured, ...devOrigins(bundles())] : configured;
  };
  /**
   * Refuses with the reason the installation gives for being locked, unless the request
   * overrides the lock. `note` is added to the reason: what becomes of what was asked for.
   */
  const assertNotOnAir = (
    name: string,
    operation: 'update' | 'remove',
    forceOnAir: boolean,
    note = '',
  ) => {
    const reason = forceOnAir ? undefined : onAir?.reason(name, operation);
    if (reason !== undefined) throw new MoonCGError('conflict', `${reason}${note}`);
  };
  // No message leaves the server with an API token or a secret of a bundle's configuration
  // in it, whatever put it there.
  const fail = (reply: FastifyReply, status: number, code: string, message: string) => {
    const scrubbed = options.modules?.configs.scrub(message) ?? message;
    const safe = redactSecrets(options.config?.scrub(scrubbed) ?? scrubbed);
    return reply.code(status).send({ error: { code, message: safe } });
  };
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
  const secure = (request: FastifyRequest) => secureCookies(request.headers, transport);
  /** One of the server's own pages: never framed, and loading only what this server serves. */
  const builtIn = (reply: FastifyReply, policy = BUILT_IN_CSP) =>
    reply
      .header('content-security-policy', policy)
      .header('x-frame-options', 'DENY')
      .type(CONTENT_TYPES['.html'] as string);
  /**
   * The policy of the dashboard page. In dev mode it may frame the development servers of
   * the running bundles, where their panels are served from; nothing else is loosened, and
   * outside dev mode it is the built-in policy to the letter.
   */
  const dashboardPolicy = () => {
    const origins = options.dev ? devOrigins(bundles()) : [];
    return origins.length === 0
      ? BUILT_IN_CSP
      : `${BUILT_IN_CSP}; frame-src 'self' ${origins.join(' ')}`;
  };
  const sendPage = async (
    reply: FastifyReply,
    name: string,
    fill: (content: string) => string = (content) => content,
  ) => {
    const content = fill(await readFile(publicFile(name), 'utf8'));
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
    const https = viaHttps(request.headers, transport);
    if (!originAllowed(request.headers, allowedOrigins(), https)) {
      return fail(reply, 403, 'forbidden', 'Requests from this origin are not allowed');
    }
    // A browser attaches cookies by itself, so a cookie alone does not prove that the page
    // meant to send this request. A token in a header is only ever sent on purpose. The
    // sign-in of dev mode needs no cookie at all, so it is asked the same.
    const { via } = identityOf(request);
    if (via !== 'session' && via !== 'token-session' && via !== 'dev') return;
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

  // The dashboard is one page that draws all of its routes itself, so each of them answers
  // with that page. The page is not cached: it names the built files, which change.
  const dashboardPage = async (request: FastifyRequest, reply: FastifyReply) => {
    // Dev mode signs in only a request without credentials. A browser that still holds a
    // cookie from an earlier start, of a session that has ended since, would be stuck at a
    // login page nobody has a password for. Such cookies are taken away and the browser is
    // sent to the same page again, which it then asks for without them. Nothing is signed
    // in here, and a request that would not get the dev login anyway is left alone.
    if (auth && options.devLogin && anonymous(request) && devLoginAllowed(request.raw)) {
      const { session, tokenSession } = credentialsOf(request.headers, secure(request));
      const only = request.headers.authorization === undefined;
      if (only && (session !== undefined || tokenSession !== undefined)) {
        const gone = { secure: secure(request), maxAge: 0 };
        return reply
          .header('cache-control', 'no-store')
          .header('set-cookie', [
            sessionCookie(SESSION_COOKIE, '', gone),
            sessionCookie(TOKEN_COOKIE, '', gone),
          ])
          .redirect(request.raw.url ?? '/', 302);
      }
    }
    // Dev mode signs in nothing that a page of another site caused, and a link there to a
    // page here is that. A login page would be of no use: nobody has a password. So the
    // answer is a page that says what happened, with a link to where the visitor was going.
    // Following it is a request of a page of this server, which is signed in. Nothing does
    // that by itself: it takes the visitor's own click.
    if (
      auth &&
      options.devLogin &&
      anonymous(request) &&
      devLoginHeldBack(request.raw, secure(request))
    ) {
      const target = devLinkTarget(request.raw.url);
      return sendPage(reply.header('cache-control', 'no-store'), 'dev-link.html', (page) =>
        page.replace(DEV_LINK_SLOT, () => escapeHtml(target)),
      );
    }
    // Whoever is not signed in is sent where that can be done.
    if (auth && anonymous(request)) {
      return reply.redirect(auth.setupCode() === undefined ? '/login' : '/setup', 302);
    }
    if (!can(request, DASHBOARD_VIEW)) return deny(request, reply, DASHBOARD_VIEW);
    const page =
      dashboardDir === undefined
        ? undefined
        : await readFile(join(dashboardDir, 'index.html'), 'utf8').catch(() => undefined);
    if (page === undefined) {
      return fail(reply, 404, 'not_found', 'The dashboard is not built yet. Run "pnpm build".');
    }
    return builtIn(reply, dashboardPolicy()).header('cache-control', 'no-cache').send(page);
  };
  for (const path of DASHBOARD_ROUTES) app.get(path, dashboardPage);

  // The scripts and styles the dashboard page loads.
  app.get<{ Params: { '*': string } }>('/ui/*', async (request, reply) => {
    if (anonymous(request)) return unauthenticated(reply);
    const rest = request.params['*'];
    const path =
      dashboardDir === undefined || !isSafeRelativePath(rest)
        ? undefined
        : await canonicalFile(join(dashboardDir, 'ui'), rest);
    if (path === undefined) return notFound(reply);
    return reply
      .type(CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
      .header('cache-control', 'no-cache')
      .send(createReadStream(path));
  });

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

  // The list is for whoever may open the dashboard, and for whoever manages bundles without
  // it, such as the command line with a token that holds nothing else.
  const requireListing = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!can(request, DASHBOARD_VIEW) && !can(request, BUNDLES_MANAGE)) {
        return deny(request, reply, DASHBOARD_VIEW);
      }
    },
  };
  app.get('/api/v1/bundles', requireListing, async (request) => {
    const usable = (item: { requires?: string | undefined }, bundle: string) =>
      can(request, bundlePermission(bundle, item.requires));
    const canManage = can(request, BUNDLES_MANAGE);
    // A bundle shows only to those who may manage bundles or hold a permission of it.
    const shown = (name: string) => canManage || can(request, bundlePermission(name, undefined));
    const installed = new Set(bundles().map(({ name }) => name));
    // Where a bundle came from is for those who could fetch it again.
    const sources = canManage ? await options.installer?.sources().catch(() => undefined) : {};
    return {
      canManage,
      // How many earlier versions are kept, so that a question about removing can be true.
      ...(canManage && options.installer
        ? { backupsKept: options.installer.limits.backupsKept }
        : {}),
      bundles: bundles()
        .filter(({ name }) => shown(name))
        .map((record) => {
          const { name, manifest } = record;
          const served = record.state === 'running' ? manifest : undefined;
          return {
            ...describeBundle(record),
            ...(sources?.[name] === undefined ? {} : { source: sources[name] }),
            // In dev mode, where its pages really come from: the dashboard believes the
            // dialog messages of its panels from that origin, and from no other.
            ...(options.dev && served?.dev !== undefined
              ? { devOrigin: new URL(served.dev.url).origin }
              : {}),
            // The bundles this one needs, by the manifest, so also while it does not run. A
            // bundle the caller is not shown is not named here either, and one that is not
            // installed only to those who may manage bundles: a grant with a wildcard
            // covers every name, also one no bundle has.
            dependencies: Object.keys(manifest?.dependencies ?? {}).filter(
              (needed) => canManage || (installed.has(needed) && shown(needed)),
            ),
            panels: (served?.panels ?? [])
              .filter((panel) => usable(panel, name))
              .map(({ id, title, width, workspace, file }) => ({
                id,
                title,
                width,
                workspace,
                url: fileUrl(name, file),
              })),
            dialogs: (served?.dialogs ?? [])
              .filter((dialog) => usable(dialog, name))
              .map(({ id, title, width, file }) => ({
                id,
                title,
                width,
                url: fileUrl(name, file),
              })),
            // The asset categories the caller may see, and whether they may change them.
            assets: (served ? (options.assets?.categories(name) ?? []) : [])
              .filter((category) => can(request, category.read))
              .map(({ id, title, accept, write }) => ({
                id,
                title,
                accept,
                canWrite: can(request, write),
              })),
            graphics: (served?.graphics ?? [])
              .filter((graphic) => usable(graphic, name))
              .map(({ id, title, width, height, file, singleInstance }) => ({
                id,
                title,
                width,
                height,
                singleInstance: singleInstance === true,
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
      if (options.installer && (action === 'update' || action === 'remove')) {
        if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
        try {
          const body = jsonBody(request);
          const by = actor(request);
          // A removal is refused here, before anything is stopped. Two things can stand in
          // its way, and each has its own word: `forceOnAir` for the lock, `force` for the
          // bundles that still need this one. An update is only fetched here, which
          // interrupts nothing; putting it in place is what the lock is asked about.
          const forceOnAir = body.forceOnAir === true;
          if (action === 'remove') assertNotOnAir(name, action, forceOnAir);
          const job =
            action === 'remove'
              ? options.installer.remove(name, {
                  force: body.force === true,
                  forceOnAir,
                  deleteFiles: body.deleteFiles === true,
                  purgeData: body.purgeData === true,
                  by,
                })
              : await options.installer.update(name, {
                  source: body.source === undefined ? undefined : fetchableSource(body.source),
                  scripts: body.scripts === true,
                  by,
                });
          return reply.code(202).send({ job });
        } catch (error) {
          return failWith(reply, error);
        }
      }
      const change = LIFECYCLE_ACTIONS.find((candidate) => candidate === action);
      // Only what can be a bundle name gets as far as the bundle manager.
      if (!lifecycle || !change || !BUNDLE_NAME_PATTERN.test(name)) return notFound(reply);
      if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
      try {
        const record = await lifecycle[change](name, { forceOnAir: overridesOnAir(request) });
        return { bundle: describeBundle(record) };
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  // The "On Air" lock: one switch for the whole installation. Whoever sees the dashboard
  // may know where it stands, since it is why buttons refuse; switching it takes what the
  // changes it blocks take.
  const onAirState = (request: FastifyRequest) => {
    const { onAir: on, since, by } = onAir?.state ?? { onAir: false };
    const canSwitch = can(request, BUNDLES_MANAGE);
    return {
      onAir: on,
      ...(since === undefined ? {} : { since }),
      // Who switched it is a user's name: for those who manage the installation.
      ...(canSwitch && by !== undefined ? { by } : {}),
      canSwitch,
    };
  };
  app.get('/api/v1/on-air', requireListing, async (request, reply) => {
    if (!onAir) return notFound(reply);
    return onAirState(request);
  });
  app.put('/api/v1/on-air', async (request, reply) => {
    if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
    if (!onAir) return notFound(reply);
    try {
      const { onAir: wanted } = jsonBody(request);
      if (typeof wanted !== 'boolean') {
        throw new MoonCGError('bad_request', '"onAir" must be true or false');
      }
      await onAir.set(wanted, actor(request));
      return onAirState(request);
    } catch (error) {
      return failWith(reply, error);
    }
  });

  // Installing, updating and removing bundles. A bundle is code that runs on the server, so
  // all of it is for whoever may manage bundles and nobody else, and that is asked first:
  // without the permission nothing is told, not even whether something exists. Whatever
  // takes time answers 202 with a job; `GET .../jobs/<id>` and the replicant
  // `system:installs` say where it stands.
  const { installer } = options;
  /** Who a change is logged as: the name of the user or token, or else the principal. */
  const actor = (request: FastifyRequest) => {
    const identity = identityOf(request);
    const described = auth?.describe(identity);
    if (described?.name == null) return identity.principal.id;
    return described.kind === 'token' ? `${described.name} (token)` : described.name;
  };
  const installs = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
      if (!installer) return notFound(reply);
    },
  };
  /** The name of a bundle an update is staged for, from a request that may name one. */
  const targetOf = (value: unknown) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new MoonCGError('invalid', '"target" must be a bundle');
    return value;
  };

  app.post(`${INSTALLS}/stage`, installs, async (request, reply) => {
    try {
      const body = jsonBody(request);
      // Fetching interrupts nothing, also the update of a bundle that is on air: the lock
      // is asked when what was fetched is to be put in place.
      const job = await installer?.stage({
        source: fetchableSource(body.source),
        target: targetOf(body.target),
        // Nothing but a plain `true` trusts a bundle to run code while it is installed.
        scripts: body.scripts === true,
        by: actor(request),
      });
      return reply.code(202).send({ job });
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.get(`${INSTALLS}/staged`, installs, async () => ({ staged: installer?.staged() ?? [] }));

  app.post<{ Params: { id: string } }>(
    `${INSTALLS}/staged/:id/commit`,
    installs,
    async (request, reply) => {
      try {
        const { scripts, forceOnAir } = jsonBody(request);
        // What is put in the place of an installed bundle interrupts it. This is where an
        // update meets the lock, and the answer says that nothing was lost.
        const target = installer
          ?.staged()
          .find((staged) => staged.id === request.params.id)?.target;
        if (target !== undefined) {
          assertNotOnAir(
            target,
            'update',
            forceOnAir === true,
            ' The new version stays staged: put it in place once On Air is off.',
          );
        }
        // Nothing but a plain `true` lets the scripts of npm packages run.
        const job = installer?.commit(request.params.id, {
          scripts: scripts === true,
          forceOnAir: forceOnAir === true,
          by: actor(request),
        });
        return reply.code(202).send({ job });
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${INSTALLS}/staged/:id`,
    installs,
    async (request, reply) => {
      const discarded = await installer?.discard(request.params.id, actor(request));
      return discarded ? reply.code(204).send() : notFound(reply);
    },
  );

  app.get(`${INSTALLS}/jobs`, installs, async () => ({ jobs: installer?.jobs() ?? [] }));

  app.get<{ Params: { id: string } }>(`${INSTALLS}/jobs/:id`, installs, async (request, reply) => {
    const job = installer?.job(request.params.id);
    return job ? { job } : notFound(reply);
  });

  // The backups of every bundle at once: the only way to learn of a bundle that was removed
  // and can be brought back, since nothing else lists it any more.
  app.get(`${INSTALLS}/backups`, installs, async () => ({
    bundles: (await installer?.allBackups()) ?? [],
  }));

  app.get<{ Params: { name: string } }>(
    '/api/v1/bundles/:name/backups',
    installs,
    async (request) => ({ backups: (await installer?.backups(request.params.name)) ?? [] }),
  );

  app.post<{ Params: { name: string; id: string } }>(
    '/api/v1/bundles/:name/backups/:id/restore',
    installs,
    async (request, reply) => {
      try {
        const { name, id } = request.params;
        const forceOnAir = overridesOnAir(request);
        if (record(name)) assertNotOnAir(name, 'update', forceOnAir);
        const job = await installer?.restore(name, id, actor(request), { forceOnAir });
        return reply.code(202).send({ job });
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  // Installing, updating and removing modules: the same steps as for bundles, and all of it
  // for whoever may manage modules. A module runs inside the server, so nothing of it is
  // told to anyone else, not even whether something exists.
  const { moduleInstaller } = options;
  const MODULE_INSTALLS = '/api/v1/modules/-';
  const moduleInstalls = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!can(request, MODULES_MANAGE)) return deny(request, reply, MODULES_MANAGE);
      if (!moduleInstaller) return notFound(reply);
    },
  };

  app.post(`${MODULE_INSTALLS}/stage`, moduleInstalls, async (request, reply) => {
    try {
      const body = jsonBody(request);
      const job = await moduleInstaller?.stage({
        source: fetchableSource(body.source),
        target: targetOf(body.target),
        scripts: body.scripts === true,
        by: actor(request),
      });
      return reply.code(202).send({ job });
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.get(`${MODULE_INSTALLS}/staged`, moduleInstalls, async () => ({
    staged: moduleInstaller?.staged() ?? [],
  }));

  app.post<{ Params: { id: string } }>(
    `${MODULE_INSTALLS}/staged/:id/commit`,
    moduleInstalls,
    async (request, reply) => {
      try {
        const { scripts, forceOnAir } = jsonBody(request);
        const job = moduleInstaller?.commit(request.params.id, {
          scripts: scripts === true,
          forceOnAir: forceOnAir === true,
          by: actor(request),
        });
        return reply.code(202).send({ job });
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${MODULE_INSTALLS}/staged/:id`,
    moduleInstalls,
    async (request, reply) => {
      const discarded = await moduleInstaller?.discard(request.params.id, actor(request));
      return discarded ? reply.code(204).send() : notFound(reply);
    },
  );

  app.get(`${MODULE_INSTALLS}/jobs`, moduleInstalls, async () => ({
    jobs: moduleInstaller?.jobs() ?? [],
  }));

  app.get<{ Params: { id: string } }>(
    `${MODULE_INSTALLS}/jobs/:id`,
    moduleInstalls,
    async (request, reply) => {
      const job = moduleInstaller?.job(request.params.id);
      return job ? { job } : notFound(reply);
    },
  );

  app.get(`${MODULE_INSTALLS}/sources`, moduleInstalls, async () => ({
    sources: (await moduleInstaller?.sources()) ?? {},
  }));

  app.post<{ Params: { name: string } }>(
    '/api/v1/modules/:name/update',
    moduleInstalls,
    async (request, reply) => {
      try {
        const { source, scripts } = jsonBody(request);
        const job = await moduleInstaller?.update(request.params.name, {
          source: source === undefined ? undefined : fetchableSource(source),
          scripts: scripts === true,
          by: actor(request),
        });
        return reply.code(202).send({ job });
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/v1/modules/:name/remove',
    moduleInstalls,
    async (request, reply) => {
      try {
        const { forceOnAir, purgeData } = jsonBody(request);
        const job = moduleInstaller?.remove(request.params.name, {
          forceOnAir: forceOnAir === true,
          purgeData: purgeData === true,
          by: actor(request),
        });
        return reply.code(202).send({ job });
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  if (options.registry) {
    registerRegistryRoutes(app, { can, deny, fail, failWith, actor }, options.registry, {
      bundle: installer,
      module: moduleInstaller,
    });
  }

  // A bundle's configuration holds secrets, and changing it restarts the bundle's extension.
  // So it is for whoever may manage the server's settings, and for nobody else, whatever
  // they hold of the bundle. The permission is checked first: without it, a bundle that
  // exists is answered like one that does not.
  const configurable = (name: string) =>
    bundles().find((record) => record.name === name && record.manifest?.config !== undefined);
  const record = (name: string) => bundles().find((candidate) => candidate.name === name);

  app.get('/api/v1/config', async (request, reply) => {
    if (!options.config) return notFound(reply);
    if (!can(request, SETTINGS_MANAGE)) return deny(request, reply, SETTINGS_MANAGE);
    return {
      bundles: bundles()
        .filter(({ name }) => configurable(name))
        .map(describeBundle),
    };
  });

  app.get<{ Params: { name: string } }>('/api/v1/bundles/:name/config', async (request, reply) => {
    const { config } = options;
    if (!config) return notFound(reply);
    if (!can(request, SETTINGS_MANAGE)) return deny(request, reply, SETTINGS_MANAGE);
    const bundle = configurable(request.params.name);
    if (!bundle?.manifest) return notFound(reply);
    try {
      const described = await config.describe({ ...bundle, manifest: bundle.manifest });
      return { ...described, bundle: describeBundle(bundle) };
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.put<{ Params: { name: string } }>('/api/v1/bundles/:name/config', async (request, reply) => {
    const { config } = options;
    const { name } = request.params;
    if (!config) return notFound(reply);
    if (!can(request, SETTINGS_MANAGE)) return deny(request, reply, SETTINGS_MANAGE);
    const bundle = configurable(name);
    if (!bundle?.manifest) return notFound(reply);
    try {
      const { values, forceOnAir } = jsonBody(request);
      if (values === undefined) {
        throw new MoonCGError('bad_request', '"values" must be the configuration');
      }
      const described = await config.write({ ...bundle, manifest: bundle.manifest }, values);
      // From here on the values are stored, and the answer says so whatever else happens.
      // The extension reads its configuration when it starts, so it is started again: the
      // extension only, so that graphics on air keep what they follow. A bundle that failed,
      // perhaps over the very configuration, gets another try. While the installation is on
      // air the restart is refused like any other, unless the request overrides the lock.
      const { state } = record(name) ?? bundle;
      let restartNote: string | undefined;
      try {
        if (bundle.manifest.extension === undefined) {
          restartNote = 'The bundle has no extension that could be restarted.';
        } else if (state === 'running') {
          await lifecycle?.restartExtension?.(name, { forceOnAir: forceOnAir === true });
        } else if (state === 'failed') await lifecycle?.enable(name);
        else restartNote = `The bundle is ${state}. The settings apply when it is started.`;
      } catch (error) {
        // Such as a change of the bundle's state that got in between.
        restartNote =
          error instanceof MoonCGError ? error.message : 'The extension could not be restarted.';
      }
      const now = record(name) ?? bundle;
      if (restartNote === undefined && now.state !== 'running') {
        restartNote = now.lastError ?? `The bundle is ${now.state}.`;
      }
      return {
        ...described,
        restarted: restartNote === undefined,
        ...(restartNote === undefined
          ? {}
          : { restartNote: redactSecrets(config.scrub(restartNote)) }),
        bundle: describeBundle(now),
      };
    } catch (error) {
      return failWith(reply, error);
    }
  });

  // Assets: the files people upload for a bundle. Listing and loading take what the category
  // asks for reading, uploading and deleting what it asks for writing; a category that names
  // neither takes any permission of the bundle. Whoever holds nothing of the bundle gets 404.
  type AssetParams = { name: string; category: string; file?: string };
  const assetCategory = (
    request: FastifyRequest,
    reply: FastifyReply,
    access: 'read' | 'write',
  ) => {
    const { name, category: id } = request.params as AssetParams;
    if (anonymous(request)) return void unauthenticated(reply);
    if (!BUNDLE_NAME_PATTERN.test(name) || !can(request, bundlePermission(name, undefined))) {
      return void notFound(reply);
    }
    const category = options.assets?.category(name, id);
    if (!category) return void notFound(reply);
    // Whoever may not see the files may not change them either.
    const needed = access === 'read' ? [category.read] : [category.read, category.write];
    for (const permission of needed) {
      if (!can(request, permission)) return void deny(request, reply, permission);
    }
    return category;
  };

  app.get<{ Params: AssetParams }>(
    '/api/v1/bundles/:name/assets/:category',
    async (request, reply) => {
      const category = assetCategory(request, reply, 'read');
      if (!category || !options.assets) return reply;
      const files = await options.assets.list(request.params.name, category.id);
      return {
        files,
        used: files.reduce((sum, file) => sum + file.size, 0),
        limits: {
          maxFileBytes: options.assets.maxFileBytes,
          quotaBytes: options.assets.quotaBytes,
          maxFiles: options.assets.maxFiles,
        },
      };
    },
  );

  app.delete<{ Params: AssetParams }>(
    '/api/v1/bundles/:name/assets/:category/:file',
    async (request, reply) => {
      const category = assetCategory(request, reply, 'write');
      if (!category || !options.assets) return reply;
      const { name, file = '' } = request.params;
      const removed = await options.assets.remove(name, category.id, file);
      return removed ? reply.code(204).send() : notFound(reply);
    },
  );

  // An upload is the body of the request, as it comes: one file, named by the URL. Here the
  // body is not read into memory first, as everywhere else, but handed on as it arrives, and
  // the store counts it against the limits while it writes.
  await app.register(async (uploads) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser('*', (_request, _payload, done) => done(null));
    // A ZIP archive of a bundle, as the body of the request. It is written to staging as it
    // arrives and counted against the limit there. `filename` is what it is remembered as,
    // `target` the installed bundle it is the update of, and `scripts=true` trusts it to
    // run code while it is installed. Like every fetch it is taken while on air too.
    uploads.put<{
      Querystring: { filename?: string; target?: string; scripts?: string };
    }>(`${INSTALLS}/stage`, installs, async (request, reply) => {
      const length = request.headers['content-length'];
      try {
        const target = targetOf(request.query.target);
        const job = await installer?.stage({
          source: {
            type: 'upload',
            body: request.raw,
            length: length === undefined ? undefined : Number(length),
            filename:
              typeof request.query.filename === 'string' ? request.query.filename : undefined,
          },
          target,
          scripts: request.query.scripts === 'true',
          by: actor(request),
        });
        return reply.code(202).send({ job });
      } catch (error) {
        // What is left of a refused upload is not waited for.
        reply.header('connection', 'close');
        return failWith(reply, error);
      }
    });
    // The same for a module.
    uploads.put<{
      Querystring: { filename?: string; target?: string; scripts?: string };
    }>(`${MODULE_INSTALLS}/stage`, moduleInstalls, async (request, reply) => {
      const length = request.headers['content-length'];
      try {
        const job = await moduleInstaller?.stage({
          source: {
            type: 'upload',
            body: request.raw,
            length: length === undefined ? undefined : Number(length),
            filename:
              typeof request.query.filename === 'string' ? request.query.filename : undefined,
          },
          target: targetOf(request.query.target),
          scripts: request.query.scripts === 'true',
          by: actor(request),
        });
        return reply.code(202).send({ job });
      } catch (error) {
        reply.header('connection', 'close');
        return failWith(reply, error);
      }
    });
    uploads.put<{ Params: AssetParams }>(
      '/api/v1/bundles/:name/assets/:category/:file',
      async (request, reply) => {
        const category = assetCategory(request, reply, 'write');
        if (!category || !options.assets) return reply;
        const { name, file = '' } = request.params;
        const length = request.headers['content-length'];
        try {
          const stored = await options.assets.put(
            name,
            category,
            file,
            request.raw,
            length === undefined ? undefined : Number(length),
          );
          return reply.code(201).send({ file: stored });
        } catch (error) {
          if (!(error instanceof AssetError)) return failWith(reply, error);
          // What is left of a refused upload is not waited for.
          reply.header('connection', 'close');
          const code = error.status >= 500 ? 'internal' : 'bad_request';
          return fail(reply, error.status, code, error.message);
        }
      },
    );
  });

  // What can be done to one connected graphic page: `reload` tells it to load itself again,
  // `disconnect` takes it off its graphic, which frees the place of a graphic that takes
  // one instance. Both interrupt what is on air, so they take what reloading a bundle
  // takes, besides being allowed to open the graphic.
  const INSTANCE_ACTIONS = ['reload', 'disconnect'] as const;
  app.post<{ Params: { name: string; instance: string; action: string } }>(
    '/api/v1/bundles/:name/instances/:instance/:action',
    async (request, reply) => {
      const { name, instance } = request.params;
      const action = INSTANCE_ACTIONS.find((known) => known === request.params.action);
      if (!action) return notFound(reply);
      if (anonymous(request)) return unauthenticated(reply);
      if (!BUNDLE_NAME_PATTERN.test(name)) return notFound(reply);
      if (!can(request, bundlePermission(name, undefined))) return notFound(reply);
      const open = options.instances?.get(instance);
      if (open?.bundle !== name) return notFound(reply);
      if (!can(request, open.permission)) return deny(request, reply, open.permission);
      if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
      return options.instances?.[action](instance) ? reply.code(204).send() : notFound(reply);
    },
  );

  // Who has the graphics of a bundle open. The replicants say that a page is connected;
  // who it acts as is told here, to whoever manages the installation.
  app.get<{ Params: { name: string } }>(
    '/api/v1/bundles/:name/instances',
    async (request, reply) => {
      const { name } = request.params;
      if (anonymous(request)) return unauthenticated(reply);
      if (!BUNDLE_NAME_PATTERN.test(name)) return notFound(reply);
      if (!can(request, bundlePermission(name, undefined))) return notFound(reply);
      if (!can(request, BUNDLES_MANAGE)) return deny(request, reply, BUNDLES_MANAGE);
      const { policy } = identityOf(request);
      return {
        instances: (options.instances?.of(name) ?? []).map(({ id, graphic, principal, since }) => ({
          id,
          graphic,
          principal: principal.id,
          kind: principal.kind ?? 'user',
          name: auth?.describe({ principal, policy }).name ?? null,
          since,
        })),
      };
    },
  );

  // The latest lines of the server log. `after` is the id of the last line the caller has,
  // so a page that follows the log asks only for what is new.
  app.get<{ Querystring: { after?: string } }>('/api/v1/logs', async (request, reply) => {
    if (!options.logs) return notFound(reply);
    if (!can(request, LOGS_VIEW)) return deny(request, reply, LOGS_VIEW);
    const { after = '0' } = request.query;
    if (!/^\d{1,15}$/.test(after)) {
      return fail(reply, 400, 'bad_request', '"after" must be the id of a log line');
    }
    const entries = options.logs.entries(Number(after));
    // `last` is where the log ends, whatever was asked for: a page that is ahead of it, as
    // after a restart of the server, sees that and starts over.
    return { entries, last: options.logs.entries().at(-1)?.id ?? 0 };
  });

  if (auth) {
    // The local login is a provider like any other. Whoever builds the app without a
    // registry of their own, as tests do, gets one with just that.
    let { providers } = options;
    if (!providers) {
      providers = new ProviderRegistry();
      providers.addPassword(localPasswordProvider(auth));
    }
    const context: HttpContext = {
      auth,
      providers,
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
    };
    registerAuthRoutes(app, context);
    if (options.modules) registerModuleRoutes(app, context, options.modules);
  }

  /**
   * Answers without waiting for what is left of the request body: the connection is closed
   * after the answer, so that no further request follows on it. Until the client has had a
   * moment to read the answer, what it still sends is thrown away (a socket closed with
   * unread data would be reset, and the client might never see the answer); then the request
   * is destroyed. Nothing changes for a request that has no body to begin with.
   */
  const closeAfter = (request: FastifyRequest, reply: FastifyReply, announced = true) => {
    if (!announced || reply.getHeader('connection') === 'close') return;
    reply.header('connection', 'close');
    reply.raw.once('finish', () => {
      request.raw.resume();
      setTimeout(() => request.raw.destroy(), LINGER_MS).unref();
    });
  };
  /** Whether a request says it has a body. */
  const hasBody = (request: FastifyRequest) => {
    const length = Number(request.headers['content-length']);
    return (
      (Number.isFinite(length) && length > 0) || request.headers['transfer-encoding'] !== undefined
    );
  };

  /**
   * Hands a streamed answer to the reply. A client that takes no piece for the drain timeout
   * is cut off. However the reply ends, the pieces are stopped, so that the extension's
   * source is told and its place among the streams is free again.
   */
  const sendPieces = (reply: FastifyReply, pieces: AsyncIterable<Uint8Array>) => {
    const iterator = pieces[Symbol.asyncIterator]();
    const drainMs = options.streamDrainTimeoutMs ?? DEFAULT_STREAM_DRAIN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watched: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]: () => watched,
      next: async () => {
        clearTimeout(timer);
        const next = await iterator.next();
        // From here on it is up to the client to take the piece.
        if (!next.done) {
          timer = setTimeout(() => reply.raw.destroy(), drainMs);
          timer.unref?.();
        }
        return next;
      },
      return: async () => {
        clearTimeout(timer);
        await iterator.return?.();
        return { done: true, value: undefined };
      },
    };
    const stream = Readable.from(watched, { objectMode: false });
    reply.raw.once('close', () => {
      clearTimeout(timer);
      // Destroying the stream returns the iterator, if it is not over yet.
      stream.destroy();
    });
    return reply.send(stream);
  };

  /** Dispatches to the routes bundle extensions registered. They come and go at run time. */
  const dispatch = async (
    request: FastifyRequest<{ Params: { bundle: string } }>,
    reply: FastifyReply,
  ) => {
    const { bundle } = request.params;
    // Whatever is refused before the route is known leaves its body unread.
    const early = () => closeAfter(request, reply, hasBody(request));
    // Nothing about a bundle's routes is told to someone who is not signed in, and nothing
    // about a bundle to someone who holds none of its permissions: for them it is not there.
    if (anonymous(request)) {
      early();
      return unauthenticated(reply);
    }
    if (!can(request, bundlePermission(bundle, undefined))) {
      early();
      return notFound(reply);
    }
    // The path below `/b/<bundle>/api`, still percent-encoded: the first four parts of the
    // raw path are '', 'b', the bundle (however it was written) and 'api'.
    const rawPath = request.raw.url?.split('?')[0] ?? '';
    const path = normalizeRoutePath(`/${rawPath.split('/').slice(4).join('/')}`);
    // HEAD is answered like GET; the body is left out when the answer is sent.
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const match = running(bundle) && routes?.match(bundle, method, path);
    if (!match) {
      early();
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
    if (!can(request, route.permission)) {
      early();
      return deny(request, reply, route.permission);
    }
    const { principal } = identityOf(request);
    // A streamed body has the route's own limit, and never more than the operator allows for
    // any streamed body; every other body has the server's limit.
    const serverLimit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const streamCap = options.maxStreamBodyBytes ?? DEFAULT_MAX_STREAM_BODY_BYTES;
    const routeLimit =
      route.stream && route.maxBodyBytes !== undefined ? route.maxBodyBytes : serverLimit;
    const limit = route.stream ? Math.min(routeLimit ?? streamCap, streamCap) : routeLimit;
    const declared = Number(request.headers['content-length']);
    const tooLarge = () => {
      closeAfter(request, reply);
      return fail(reply, 413, 'bad_request', 'The request body is too large');
    };
    if (limit !== null && Number.isFinite(declared) && declared > limit) return tooLarge();
    const body = requestBody(request.raw, limit, options.uploadPace);
    /** Answers an error; with the body not read to its end, on a connection that closes. */
    const failed = (error: unknown) => {
      if (body.overLimit) return tooLarge();
      if (!body.complete) closeAfter(request, reply);
      if (body.tooSlow) return fail(reply, 408, 'timeout', 'The request body arrived too slowly');
      return failWith(reply, error);
    };
    // The client going away ends the call: the extension is told to stop.
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    let buffered: Buffer | null = null;
    if (!route.stream) {
      try {
        buffered = await readWhole(body.pieces);
      } catch (error) {
        return abort.signal.aborted ? reply : failed(error);
      }
    }
    let response: RouteAnswer;
    try {
      response = await route.invoke(
        {
          method: method as HttpMethod,
          path,
          params,
          query: flatten(request.query as Record<string, unknown>, new Set([TOKEN_PARAMETER])),
          headers: flatten(request.headers, CREDENTIAL_HEADERS),
          body: buffered === null ? null : buffered.toString('base64'),
          sender: { principal: principal.id, kind: principal.kind ?? 'user', bundle },
        },
        { body: route.stream ? body.pieces : undefined, signal: abort.signal },
      );
    } catch (error) {
      return abort.signal.aborted ? reply : failed(error);
    }
    const { pieces } = response;
    try {
      if (route.stream && !body.complete) closeAfter(request, reply);
      reply.code(response.status);
      for (const [name, value] of Object.entries(response.headers)) {
        // How the answer travels is the server's business, not the handler's.
        if (!CONNECTION_HEADERS.has(name.toLowerCase())) reply.header(name, value);
      }
      if (pieces) {
        // An answer that has no body by its nature: the pieces are not wanted.
        if (request.method === 'HEAD' || response.status === 204 || response.status === 304) {
          await pieces[Symbol.asyncIterator]().return?.();
          return reply.send();
        }
        // Read only as fast as the client takes it; a client that goes away stops it.
        return sendPieces(reply, pieces);
      }
      return reply.send(response.body === null ? undefined : Buffer.from(response.body, 'base64'));
    } catch (error) {
      // Whatever failed before the reply owned the pieces: they are stopped here, so that the
      // extension's source and its place among the streams are released.
      await pieces?.[Symbol.asyncIterator]().return?.();
      throw error;
    }
  };
  // HEAD comes with GET. OPTIONS is taken so that it is answered like any other method
  // without a route: 405 with the methods the path does take. The body is not read before
  // the route is known: one that streams takes it as it arrives.
  const methods = [...HTTP_METHODS, 'OPTIONS' as const];
  await app.register(async (bundleApi) => {
    bundleApi.removeAllContentTypeParsers();
    bundleApi.addContentTypeParser('*', (_request, _payload, done) => done(null));
    bundleApi.route({ method: methods, url: '/b/:bundle/api', handler: dispatch });
    bundleApi.route({ method: methods, url: '/b/:bundle/api/*', handler: dispatch });
  });

  app.get<{ Params: { bundle: string; area: string; '*': string } }>(
    '/b/:bundle/:area/*',
    async (request, reply) => {
      const { bundle: name, area, '*': rest } = request.params;
      // Whether a bundle or a file exists is told only to someone who is signed in.
      if (anonymous(request)) return unauthenticated(reply);
      // A bundle the caller holds nothing of is answered like one that does not exist.
      if (!can(request, bundlePermission(name, undefined))) return notFound(reply);
      const bundle = running(name);
      if (bundle && area === 'assets') {
        // `<category>/<file>`, and nothing deeper: a category is one flat folder.
        const [id = '', file, ...deeper] = rest.split('/');
        const category = options.assets?.category(name, id);
        if (!category || file === undefined || deeper.length > 0) return notFound(reply);
        if (!can(request, category.read)) return deny(request, reply, category.read);
        // Opened first, and measured through what was opened: a file that is replaced
        // while it is being sent is still sent whole, with the length that was announced.
        const found = await options.assets?.open(name, id, file);
        if (!found) return notFound(reply);
        const { handle, size } = found;
        const { type, inline } = assetType(file);
        reply
          .type(type)
          .header('accept-ranges', 'bytes')
          .header('cache-control', 'no-cache')
          .header('content-security-policy', ASSET_CSP);
        // What a browser cannot show safely is handed over as a download.
        if (!inline) reply.header('content-disposition', 'attachment');
        // A player that seeks or loops a clip asks for parts of the file.
        const range = byteRange(request.headers.range, size);
        if (range === 'unsatisfiable') {
          await handle.close();
          reply.type('application/json; charset=utf-8').header('content-range', `bytes */${size}`);
          return fail(reply, 416, 'bad_request', 'The range is outside the file');
        }
        const { start, end } = range ?? { start: 0, end: size - 1 };
        if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
        reply.header('content-length', end - start + 1);
        if (request.method === 'HEAD' || size === 0) {
          await handle.close();
          return reply.send();
        }
        return reply.send(handle.createReadStream({ start, end }));
      }
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

      // In dev mode a bundle that names a development server has its pages served there:
      // the browser is sent on to the same file on that server, after every check above.
      // The manifest allows only an address on this machine.
      if (options.dev && bundle.manifest.dev) {
        // Everything after the first question mark: a query may hold more of them.
        const url = request.raw.url ?? '';
        const at = url.indexOf('?');
        const query = at === -1 ? undefined : url.slice(at + 1);
        return reply
          .header('cache-control', 'no-store')
          .redirect(devServerUrl(bundle.manifest.dev.url, file, query), 302);
      }

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

/** The URL of a bundle file, with every path segment percent-encoded. */
function fileUrl(bundle: string, file: string): string {
  return `/b/${encodeURIComponent(bundle)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * What a `Range` header asks for of a file of `size` bytes: one range of bytes, with both
 * ends inside the file. `undefined` for no header and for anything that is not one range of
 * bytes, which is then answered with the whole file; `'unsatisfiable'` for a range that
 * lies outside the file.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | 'unsatisfiable' | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '') {
    // The last so many bytes.
    if (last === '') return undefined;
    const length = Number(last);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== '' && Number(last) < start) return undefined;
  return start >= size ? 'unsatisfiable' : { start, end };
}
