import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerHost } from '../src/extension-host/worker-host.js';
import { resolveLocalAdmin } from '../src/http/identity.js';
import { startServer } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger, testConfig } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const WORKER_BOOTSTRAP = new URL('./worker-bootstrap.mjs', import.meta.url);
const WAIT = { timeout: 10_000, interval: 25 };
const TEST_TIMEOUT = 40_000;

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const files = () => ({
  'hung/mooncg.json': manifest('hung', { extension: 'extension/index.js' }),
  'hung/extension/index.js': 'export default () => new Promise(() => {});',
  'ok/mooncg.json': manifest('ok', {
    extension: 'extension/index.js',
    capabilities: ['http.routes'],
  }),
  'ok/extension/index.js': `export default async function start(ctx) {
    await ctx.http.get('/alive', () => ({ body: 'yes' }));
  }`,
});

/** A server with real worker threads and a bundle whose extension never finishes starting. */
async function start(startTimeoutMs: number) {
  const { logger } = memoryLogger();
  const began = Date.now();
  const server = await startServer(
    testConfig({
      bundlesDir: await temporary.create(files()),
      extensionStartTimeoutMs: startTimeoutMs,
    }),
    {
      logger,
      sdkFile: undefined,
      resolvePrincipal: resolveLocalAdmin,
      storage: memoryStorage(),
      createHost: (services) =>
        new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP, startTimeoutMs }),
    },
  );
  const listeningAfter = Date.now() - began;
  let closed = false;
  cleanup.push(async () => {
    if (!closed) await server.close();
  });
  const states = async () =>
    Object.fromEntries(
      (
        (await (await fetch(`${server.url}/api/v1/bundles`)).json()) as {
          bundles: { name: string; state: string; errors: string[] }[];
        }
      ).bundles.map((bundle) => [bundle.name, bundle]),
    );
  const close = async () => {
    closed = true;
    await server.close();
  };
  return { server, listeningAfter, states, close };
}

describe('a bundle whose extension hangs while starting', () => {
  it(
    'does not keep the server from listening or the other bundles from working',
    async () => {
      const { server, listeningAfter, states } = await start(3000);

      // Listening long before the hung extension's three seconds are up.
      expect(listeningAfter).toBeLessThan(2000);
      expect((await states()).hung?.state).toBe('enabling');
      await vi.waitFor(async () => expect((await states()).ok?.state).toBe('running'), WAIT);

      const began = Date.now();
      const reloaded = await fetch(`${server.url}/api/v1/bundles/ok/reload`, { method: 'POST' });
      expect(reloaded.status).toBe(200);
      expect(Date.now() - began).toBeLessThan(2000);
      expect((await states()).hung?.state).toBe('enabling');
      expect(await (await fetch(`${server.url}/b/ok/api/alive`)).text()).toBe('yes');

      await vi.waitFor(async () => expect((await states()).hung?.state).toBe('failed'), WAIT);
      expect((await states()).hung?.errors).toEqual([
        'Extension failed to start: The extension did not start within 3000 ms',
      ]);
      await server.started;
    },
    TEST_TIMEOUT,
  );

  it(
    'does not keep the server from shutting down',
    async () => {
      const { server, close } = await start(30_000);
      await vi.waitFor(() => expect(server.host.stats().threads.started).toBe(2), WAIT);
      const began = Date.now();

      await close();

      expect(Date.now() - began).toBeLessThan(4000);
      expect(server.host.stats().threads.live).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
