import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@mooncg/sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerHost } from '../src/extension-host/worker-host.js';
import { resolveLocalAdmin } from '../src/http/identity.js';
import { type RunningServer, startServer } from '../src/server.js';
import { memoryLogger, testConfig } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const WORKER_BOOTSTRAP = new URL('./worker-bootstrap.mjs', import.meta.url);
/** Worker threads take a moment to start; every wait in here is bounded by this. */
const WAIT = { timeout: 10_000, interval: 25 };
const TEST_TIMEOUT = 60_000;

/** How many worker message ports this process holds open: Node's own count of live workers. */
const livePorts = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'MessagePort').length;

/**
 * How much the server's heap may grow over 90 reloads. Three runs measured -2.1, -2.8 and
 * -3.3 MiB, without a forced collection; a session, its listeners and its routes kept alive
 * per reload would add well over this.
 */
const HEAP_TOLERANCE_MB = 12;

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const extension = (version: string) => `export default async function start(ctx) {
  const score = ctx.replicant('score');
  await ctx.handle('reset', async () => {
    await score.set({ home: 0 });
    return 'reset by ${version}';
  });
  await ctx.on('bump', () => score.update((draft) => { draft.home++; }));
  await ctx.http.get('/score', () => ({ body: score.value }));
}`;

const files = () => ({
  'board/mooncg.json': manifest('board', {
    extension: 'extension/index.js',
    capabilities: ['http.routes'],
    panels: [{ id: 'p', title: 'Panel', file: 'dashboard/panel.html' }],
    replicants: { score: { default: { home: 0 }, persistent: true } },
    messages: { reset: {}, bump: {} },
  }),
  'board/extension/index.js': extension('v1'),
  'board/dashboard/panel.html': 'board panel',
});

async function temporaryData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-data-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A server whose extensions run in real worker threads, storing to SQLite. */
async function start(bundlesDir: string, dataDir: string) {
  const { logger, lines } = memoryLogger();
  const server = await startServer(testConfig({ bundlesDir, dataDir }), {
    logger,
    sdkFile: undefined,
    resolvePrincipal: resolveLocalAdmin,
    createHost: (services) => new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP }),
  });
  let closed = false;
  const close = async () => {
    if (!closed) await server.close();
    closed = true;
  };
  cleanup.push(close);
  await server.started;
  const post = (path: string) => fetch(`${server.url}${path}`, { method: 'POST' });
  return { server, lines, close, post };
}

function connect(server: RunningServer, bundle = 'board', waitForBundle = true) {
  const client = createClient({ bundle, url: `ws://127.0.0.1:${server.port}/ws`, waitForBundle });
  cleanup.push(() => client.close());
  return client;
}

interface Score {
  home: number;
}

describe('a server with extensions in worker threads', () => {
  it(
    'connects pages and an extension through replicants, messages, requests and HTTP',
    async () => {
      const { server } = await start(await temporary.create(files()), await temporaryData());
      const client = connect(server);
      const score = client.replicant<Score>('score');
      await score.ready;

      await client.send('bump');
      await client.send('bump');
      await vi.waitFor(() => expect(score.value).toEqual({ home: 2 }), WAIT);
      const viaHttp = await fetch(`${server.url}/b/board/api/score`);
      expect(viaHttp.status).toBe(200);
      expect(await viaHttp.json()).toEqual({ home: 2 });

      await expect(client.request('reset')).resolves.toBe('reset by v1');
      await vi.waitFor(() => expect(score.value).toEqual({ home: 0 }), WAIT);
      expect(server.host.stats()).toMatchObject({
        running: 1,
        ledger: {
          board: { replicants: 1, listeners: 1, handlers: 1, routes: 1, calls: 0, streams: 0 },
        },
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'picks up changed extension code on reload, without restarting the server',
    async () => {
      const bundles = await temporary.create(files());
      const { server, post } = await start(bundles, await temporaryData());
      const client = connect(server);
      await expect(client.request('reset')).resolves.toBe('reset by v1');

      await writeFile(join(bundles, 'board/extension/index.js'), extension('v2'));
      const reloaded = await post('/api/v1/bundles/board/reload');

      expect(reloaded.status).toBe(200);
      expect(await reloaded.json()).toMatchObject({ bundle: { name: 'board', state: 'running' } });
      await expect(client.request('reset')).resolves.toBe('reset by v2');
    },
    TEST_TIMEOUT,
  );

  it(
    'takes a disabled bundle away from clients and brings its stored state back on enable',
    async () => {
      const { server, post } = await start(await temporary.create(files()), await temporaryData());
      const client = connect(server);
      const score = client.replicant<Score>('score');
      await score.set({ home: 7 });
      const states = connect(server, 'system').replicant<{ name: string; state: string }[]>(
        'bundles',
      );
      await states.ready;
      expect(states.value).toMatchObject([{ name: 'board', state: 'running' }]);

      expect((await post('/api/v1/bundles/board/disable')).status).toBe(200);

      await vi.waitFor(() => expect(score.error).toMatchObject({ code: 'not_found' }), WAIT);
      await vi.waitFor(
        () => expect(states.value).toMatchObject([{ name: 'board', state: 'disabled' }]),
        WAIT,
      );
      expect((await fetch(`${server.url}/b/board/dashboard/panel.html`)).status).toBe(404);
      expect((await fetch(`${server.url}/b/board/api/score`)).status).toBe(404);
      await expect(connect(server, 'board', false).ready).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(states.set([])).rejects.toMatchObject({ code: 'forbidden' });
      expect(server.host.stats()).toMatchObject({ running: 0, ledger: {} });

      expect((await post('/api/v1/bundles/board/enable')).status).toBe(200);
      const again = connect(server).replicant<Score>('score');
      await again.ready;

      expect(again.value).toEqual({ home: 7 });
      // The page that was connected all along has its replicant back without a reload.
      await vi.waitFor(() => expect(score.error).toBeUndefined(), WAIT);
      expect(score.value).toEqual({ home: 7 });
      await score.set({ home: 8 });
      await vi.waitFor(() => expect(again.value).toEqual({ home: 8 }), WAIT);
      const panel = await fetch(`${server.url}/b/board/dashboard/panel.html`);
      expect(panel.status).toBe(200);
      expect(await panel.text()).toBe('board panel');
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps a bundle disabled across a restart',
    async () => {
      const bundles = await temporary.create(files());
      const data = await temporaryData();
      const first = await start(bundles, data);
      await first.post('/api/v1/bundles/board/disable');
      await first.close();

      const second = await start(bundles, data);

      expect(second.server.bundles).toMatchObject([{ name: 'board', state: 'disabled' }]);
      expect(second.server.host.stats().running).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it('holds no more after a hundred reloads than after the first start', async () => {
    const { server, post } = await start(await temporary.create(files()), await temporaryData());
    const client = connect(server);
    await expect(client.request('reset')).resolves.toBe('reset by v1');
    const before = server.stats();
    const portsBefore = livePorts();
    const reload = async (times: number) => {
      for (let round = 0; round < times; round++) {
        const response = await post('/api/v1/bundles/board/reload');
        expect(response.status).toBe(200);
      }
    };

    // Memory is compared after a warm-up, so what loads once is not counted as growth.
    await reload(10);
    const warm = process.memoryUsage().heapUsed;
    await reload(90);
    const after = server.stats();
    const grownMb = (process.memoryUsage().heapUsed - warm) / (1024 * 1024);

    console.log(
      `leak test: before ${JSON.stringify(before)} after ${JSON.stringify(after)}; ` +
        `heap grew ${grownMb.toFixed(1)} MiB over 90 reloads`,
    );
    // Everything registered is as it was; only the count of threads started and ended moved.
    const withoutThreads = ({
      extensions: { threads: _threads, ...extensions },
      ...rest
    }: typeof before) => ({
      ...rest,
      extensions,
    });
    expect(withoutThreads(after)).toEqual(withoutThreads(before));
    expect(before.extensions.threads).toEqual({ started: 1, exited: 0, live: 1 });
    expect(after.extensions.threads).toEqual({ started: 101, exited: 100, live: 1 });
    // The same, counted by Node instead of by the host: one message port per live worker.
    expect(livePorts()).toBe(portsBefore);
    expect(grownMb).toBeLessThan(HEAP_TOLERANCE_MB);
    await expect(client.request('reset')).resolves.toBe('reset by v1');
  }, 240_000);
});
