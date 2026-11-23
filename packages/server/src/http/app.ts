import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
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
  type Principal,
  type RouteTable,
} from '@mooncg/core';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { BundleRecord } from '../bundles/bundles.js';
import { originAllowed } from './origin.js';

/** Finds out who a request acts as. Until authentication exists, everyone is the local admin. */
export type ResolvePrincipal = (request: IncomingMessage) => Principal;
export const resolveLocalAdmin: ResolvePrincipal = () => ALLOW_ALL_PRINCIPAL;

/** The largest request body a bundle route accepts, unless configured otherwise. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

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
  readonly policy?: Policy;
  readonly resolvePrincipal?: ResolvePrincipal;
  /** The routes bundle extensions registered, served below `/b/<bundle>/api`. */
  readonly routes?: RouteTable | undefined;
  /** Without it the lifecycle API answers 404. */
  readonly lifecycle?: BundleLifecycle | undefined;
  readonly maxBodyBytes?: number | undefined;
  /** Origins besides the server's own whose pages may send state-changing requests. */
  readonly allowedOrigins?: readonly string[] | undefined;
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

/** Builds the HTTP application. Every route checks `authorize()` before it answers. */
export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const { sdkFile, routes, lifecycle } = options;
  const bundles = () =>
    typeof options.bundles === 'function' ? options.bundles() : options.bundles;
  const running = (name: string) =>
    bundles().find((candidate) => candidate.name === name && candidate.state === 'running');
  const policy = options.policy ?? ALLOW_ALL_POLICY;
  const resolvePrincipal = options.resolvePrincipal ?? resolveLocalAdmin;
  const shellPage = await readFile(publicFile('index.html'), 'utf8');
  const shellScript = await readFile(publicFile('shell.js'), 'utf8');
  const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.code(status).send({ error: { code, message } });
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

  const can = (request: FastifyRequest, permission: string) =>
    authorize(resolvePrincipal(request.raw), permission, policy);
  const forbidden = (reply: FastifyReply, permission: string) =>
    fail(reply, 403, 'forbidden', `Missing permission "${permission}"`);
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
      if (!can(request, DASHBOARD_VIEW)) return forbidden(reply, DASHBOARD_VIEW);
    },
  };

  app.setNotFoundHandler((_request, reply) => notFound(reply));
  // Whatever goes wrong before a route answers gets the same envelope as everything else.
  app.setErrorHandler((error, _request, reply) => refuse(reply, error));

  // A page of another site must not change anything here through a visitor's browser.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    if (!originAllowed(request.headers, options.allowedOrigins ?? [])) {
      return fail(reply, 403, 'forbidden', 'Requests from this origin are not allowed');
    }
  });

  app.get('/', requireDashboard, (_request, reply) =>
    reply.type(CONTENT_TYPES['.html'] as string).send(shellPage),
  );

  app.get('/shell.js', requireDashboard, (_request, reply) =>
    reply.type(CONTENT_TYPES['.js'] as string).send(shellScript),
  );

  app.get('/sdk/mooncg.js', requireDashboard, async (_request, reply) => {
    const script = sdkFile === undefined ? undefined : await readFile(sdkFile).catch(() => {});
    if (!script) {
      return fail(reply, 404, 'not_found', 'The SDK is not built yet. Run "pnpm build".');
    }
    return reply.type(CONTENT_TYPES['.js'] as string).send(script);
  });

  app.get('/api/v1/bundles', requireDashboard, (request) => {
    const usable = (item: { requires?: string | undefined }, bundle: string) =>
      can(request, bundlePermission(bundle, item.requires));
    return {
      bundles: bundles().map((record) => {
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
      if (!can(request, BUNDLES_MANAGE)) return forbidden(reply, BUNDLES_MANAGE);
      try {
        return { bundle: describeBundle(await lifecycle[change](name)) };
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  /** Dispatches to the routes bundle extensions registered. They come and go at run time. */
  const dispatch = async (
    request: FastifyRequest<{ Params: { bundle: string } }>,
    reply: FastifyReply,
  ) => {
    const { bundle } = request.params;
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
    if (!can(request, route.permission)) return forbidden(reply, route.permission);
    try {
      const response = await route.invoke({
        method: method as HttpMethod,
        path,
        params,
        query: flatten(request.query as Record<string, unknown>),
        headers: flatten(request.headers),
        body: Buffer.isBuffer(request.body) ? request.body.toString('base64') : null,
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
      const bundle = running(name);
      if (!bundle?.manifest || !SERVED_AREAS.has(area) || !isSafeRelativePath(rest)) {
        return notFound(reply);
      }
      // A panel or graphic entry file needs what its manifest entry requires. The lookup is by
      // exact name, which is safe because only a file with exactly this name is ever served.
      const file = `${area}/${rest}`;
      const { panels, dialogs, graphics } = bundle.manifest;
      const entry = [...panels, ...dialogs, ...graphics].find((item) => item.file === file);
      const permission = bundlePermission(name, entry?.requires);
      if (!can(request, permission)) return forbidden(reply, permission);

      const path = await canonicalFile(join(bundle.dir, area), rest);
      if (path === undefined) return notFound(reply);
      return reply
        .type(CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
        .header('cache-control', 'no-cache')
        .send(createReadStream(path));
    },
  );

  return app;
}

/** Keeps the string values of a query or header map; of a repeated one, the first. */
function flatten(values: Readonly<Record<string, unknown>>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') flat[name] = first;
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
