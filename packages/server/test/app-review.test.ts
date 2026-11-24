import { MessageBus, ReplicantRegistry, RouteTable } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import type { ExtensionHost, ExtensionServices } from '../src/extension-host/extension-host.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { WorkerHost } from '../src/extension-host/worker-host.js';
import { type AppOptions, createApp, resolveLocalAdmin } from '../src/http/app.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const WORKER_BOOTSTRAP = new URL('./worker-bootstrap.mjs', import.meta.url);
const TEST_TIMEOUT = 30_000;

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const api = `export default async function start(ctx) {
  await ctx.http.get('/hello/:name', (request) => ({ body: { hello: request.params.name } }));
  await ctx.http.post('/hello/:name', (request) => ({ body: request.text() }));
  await ctx.http.get('/', () => ({ body: 'root' }));
  await ctx.http.delete('/only-delete', () => ({ status: 204 }));
  await ctx.http.get('/evil-header', () => ({ headers: { 'x-evil': 'a\\r\\nset-cookie: stolen=1' }, body: 'x' }));
  await ctx.http.get('/hop', () => ({
    headers: { connection: 'close', 'transfer-encoding': 'chunked', 'content-length': '999', 'x-kept': 'yes' },
    body: 'intact',
  }));
  await ctx.http.get('/informational', () => ({ status: 101, body: 'x' }));
}`;

const files = () => ({
  'demo/mooncg.json': manifest('demo', {
    extension: 'extension/index.js',
    capabilities: ['http.routes'],
  }),
  'demo/extension/index.js': api,
  'broken/mooncg.json': manifest('broken', {
    replicants: { score: { schema: 'schemas/missing.json' } },
  }),
});

const hosts: [string, (services: ExtensionServices) => ExtensionHost][] = [
  ['InlineHost', (services) => new InlineHost(services)],
  ['WorkerHost', (services) => new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP })],
];

describe.each(hosts)('HTTP hardening with %s', (_name, createHost) => {
  async function setup(overrides: Partial<AppOptions> = {}) {
    const dir = await temporary.create(files());
    const registry = new ReplicantRegistry();
    const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
    const routes = new RouteTable();
    const { logger, lines } = memoryLogger();
    const host = createHost({ registry, bus, routes, logger });
    const storage = memoryStorage();
    const manager = new BundleManager({
      bundlesDir: dir,
      registry,
      bus,
      host,
      logger,
      settings: storage.bundles,
    });
    await manager.start();
    cleanup.push(() => manager.close());
    const app = await createApp({
      resolvePrincipal: resolveLocalAdmin,
      bundles: () => manager.list(),
      routes,
      lifecycle: manager,
      sdkFile: undefined,
      maxBodyBytes: 1024,
      allowedOrigins: ['http://studio.example'],
      ...overrides,
    });
    cleanup.push(() => app.close());
    return { app, manager, storage, lines, dir };
  }

  const envelope = (code: string) => ({ error: { code, message: expect.any(String) } });

  it(
    'refuses lifecycle calls for names that are not bundle names, and creates nothing',
    async () => {
      const { app, manager, storage } = await setup();
      const before = manager.list().map((bundle) => bundle.name);

      for (const name of ['..%2F', '..', '.git', 'Demo', 'a%2Fb', '%2e%2e']) {
        for (const action of ['enable', 'disable', 'reload']) {
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/bundles/${name}/${action}`,
          });
          expect([name, action, response.statusCode]).toEqual([name, action, 404]);
          expect(response.json()).toEqual(envelope('not_found'));
        }
      }

      expect(manager.list().map((bundle) => bundle.name)).toEqual(before);
      expect(await storage.bundles.disabled()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'refuses state-changing requests from another origin, whatever their content type',
    async () => {
      const { app, manager } = await setup();
      const foreign = { origin: 'http://evil.example', 'content-type': 'text/plain' };
      const post = (url: string, headers: Record<string, string>) =>
        app.inject({ method: 'POST', url, headers, payload: 'x' });

      const lifecycle = await post('/api/v1/bundles/demo/disable', foreign);
      const route = await post('/b/demo/api/hello/x', foreign);
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/b/demo/api/hello/x',
        headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
      });

      expect([lifecycle.statusCode, route.statusCode, preflight.statusCode]).toEqual([
        403, 403, 403,
      ]);
      expect(lifecycle.json()).toEqual(envelope('forbidden'));
      expect(manager.isRunning('demo')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'accepts them from the server itself, from an allowed origin and without an Origin',
    async () => {
      const { app } = await setup();
      const post = (headers: Record<string, string>) =>
        app.inject({ method: 'POST', url: '/b/demo/api/hello/x', headers, payload: 'body' });

      const sameOrigin = await post({ host: 'show.local:9090', origin: 'http://show.local:9090' });
      const allowed = await post({ origin: 'http://studio.example' });
      const none = await post({});
      const reading = await app.inject({
        url: '/b/demo/api/hello/x',
        headers: { origin: 'http://evil.example' },
      });

      expect([sameOrigin.statusCode, allowed.statusCode, none.statusCode]).toEqual([200, 200, 200]);
      expect(reading.statusCode).toBe(200);
      expect(none.body).toBe('body');
    },
    TEST_TIMEOUT,
  );

  it(
    'dispatches the same path whether or not the bundle name is percent-encoded',
    async () => {
      const { app } = await setup();
      const encoded = await app.inject({ url: '/b/%64emo/api/hello/world' });
      expect(encoded.statusCode).toBe(200);
      expect(encoded.json()).toEqual({ hello: 'world' });
    },
    TEST_TIMEOUT,
  );

  it(
    'ignores a trailing slash',
    async () => {
      const { app } = await setup();
      const response = await app.inject({ url: '/b/demo/api/hello/world/' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hello: 'world' });
    },
    TEST_TIMEOUT,
  );

  it(
    'answers HEAD like GET, without the body',
    async () => {
      const { app } = await setup();

      const get = await app.inject({ url: '/b/demo/api/hello/world' });
      const head = await app.inject({ method: 'HEAD', url: '/b/demo/api/hello/world' });
      const none = await app.inject({ method: 'HEAD', url: '/b/demo/api/only-delete' });

      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-type']).toBe(get.headers['content-type']);
      expect(head.headers['content-length']).toBe(String(get.rawPayload.length));
      expect(none.statusCode).toBe(405);
    },
    TEST_TIMEOUT,
  );

  it(
    'answers 405 with the allowed methods for a path that exists under another method',
    async () => {
      const { app } = await setup();

      const put = await app.inject({ method: 'PUT', url: '/b/demo/api/hello/world' });
      const options = await app.inject({ method: 'OPTIONS', url: '/b/demo/api/only-delete' });
      const unknown = await app.inject({ method: 'PUT', url: '/b/demo/api/nope' });

      expect(put.statusCode).toBe(405);
      expect(put.headers.allow).toBe('GET, HEAD, POST');
      expect(put.json()).toEqual(envelope('bad_request'));
      expect([options.statusCode, options.headers.allow]).toEqual([405, 'DELETE']);
      expect(unknown.statusCode).toBe(404);
    },
    TEST_TIMEOUT,
  );

  it(
    'answers 500 without details for a response that would forge headers or is not final',
    async () => {
      const { app } = await setup();

      const forged = await app.inject({ url: '/b/demo/api/evil-header' });
      const informational = await app.inject({ url: '/b/demo/api/informational' });

      for (const response of [forged, informational]) {
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual(envelope('internal'));
        expect(response.body).not.toMatch(/evil|cookie|stolen/);
      }
      expect(forged.headers).not.toHaveProperty('set-cookie');
    },
    TEST_TIMEOUT,
  );

  it(
    'drops connection-level headers and sets the content length itself',
    async () => {
      const { app } = await setup();

      const response = await app.inject({ url: '/b/demo/api/hop' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('intact');
      expect(response.headers['content-length']).toBe('6');
      expect(response.headers['x-kept']).toBe('yes');
      expect(response.headers).not.toHaveProperty('transfer-encoding');
      expect(response.headers.connection).not.toBe('close');
    },
    TEST_TIMEOUT,
  );

  it(
    'uses its own error envelope for requests the HTTP layer itself refuses',
    async () => {
      const { app } = await setup();

      const tooLarge = await app.inject({
        method: 'POST',
        url: '/b/demo/api/hello/x',
        payload: 'x'.repeat(5000),
      });
      const badUrl = await app.inject({ url: '/b/demo/api/%E0%A4%A' });
      const unknown = await app.inject({ url: '/nowhere' });

      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toEqual(envelope('bad_request'));
      expect([400, 404]).toContain(badUrl.statusCode);
      expect(badUrl.json()).toEqual(
        envelope(badUrl.statusCode === 400 ? 'bad_request' : 'not_found'),
      );
      expect(unknown.json()).toEqual(envelope('not_found'));
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps server file paths out of the errors it lists',
    async () => {
      const { app, dir } = await setup();

      const { bundles } = (await app.inject({ url: '/api/v1/bundles' })).json();
      const broken = bundles.find((bundle: { name: string }) => bundle.name === 'broken');

      expect(broken.state).toBe('failed');
      expect(JSON.stringify(broken)).not.toContain(dir.replaceAll('\\', '\\\\'));
      expect(JSON.stringify(broken)).not.toContain(dir.replaceAll('\\', '/'));
      expect(broken.errors[0]).toContain('schemas/missing.json');
      expect(broken.lastError).toBe(broken.errors[0]);
    },
    TEST_TIMEOUT,
  );
});
