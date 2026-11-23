import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageBus, ReplicantRegistry, RouteTable } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  WorkerHost,
  type WorkerHostOptions,
} from '../src/extension-host/worker-host.js';
import { createApp } from '../src/http/app.js';
import { fixture, memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const WORKER_BOOTSTRAP = new URL('./worker-bootstrap.mjs', import.meta.url);
/** Worker threads take a moment to start; every wait in here is bounded. */
const WAIT = { timeout: 10_000, interval: 20 };
const TEST_TIMEOUT = 30_000;

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

/** How many worker message ports this process holds open: an independent count of live workers. */
const livePorts = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'MessagePort').length;

function setup(options: Partial<WorkerHostOptions> = {}) {
  const registry = new ReplicantRegistry();
  const out = registry.declare('demo', 'out', { initial: { pings: [] } }).replicant;
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  for (const topic of ['ping', 'double', 'do']) bus.declare('demo', topic, {});
  const routes = new RouteTable();
  const { logger, lines } = memoryLogger();
  const host = new WorkerHost({
    registry,
    bus,
    routes,
    logger,
    bootstrap: WORKER_BOOTSTRAP,
    ...options,
  });
  cleanup.push(() => host.close());
  const crashes: string[] = [];
  host.onCrash((_bundle, error) => crashes.push(error.message));
  const spec = (file: string, bundle = 'demo') => ({
    bundle,
    version: '1.0.0',
    entry: fixture(`extensions/${file}`),
    capabilities: ['http.routes'],
    permissions: [],
  });
  const sender = { principal: 'tester', bundle: 'demo' };
  const counts = () => ({
    registry: registry.stats(),
    bus: bus.stats(),
    routes: routes.count(),
  });
  return { host, registry, out, bus, routes, lines, crashes, spec, sender, counts };
}

describe('WorkerHost start and stop', () => {
  it('gives an extension ten seconds to start by default', () => {
    expect(DEFAULT_START_TIMEOUT_MS).toBe(10_000);
  });

  it(
    'leaves no thread behind when an extension does not start in time',
    async () => {
      const before = livePorts();
      const { host, spec } = setup({ startTimeoutMs: 300 });

      await expect(host.start(spec('hangs.js'))).rejects.toThrow(/did not start within 300 ms/);

      expect(host.stats()).toMatchObject({
        running: 0,
        threads: { started: 1, exited: 1, live: 0 },
      });
      expect(livePorts()).toBe(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'aborts an extension that is still starting when the host closes',
    async () => {
      const before = livePorts();
      const { host, spec } = setup();
      const starting = host.start(spec('hangs.js'));
      starting.catch(() => {});
      await vi.waitFor(() => expect(host.stats().threads.started).toBe(1), WAIT);
      const began = Date.now();

      await host.close();

      expect(Date.now() - began).toBeLessThan(2000);
      await expect(starting).rejects.toThrow(/shutting down/);
      expect(host.stats().threads.live).toBe(0);
      expect(livePorts()).toBe(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'stops all extensions at the same time, within one cleanup period',
    async () => {
      const { host, spec } = setup({ stopTimeoutMs: 600 });
      await Promise.all(['a', 'b', 'c'].map((bundle) => host.start(spec('stubborn.js', bundle))));
      const began = Date.now();

      await host.close();

      // Three cleanups that never finish: 600 ms together, not 1800 ms in a row.
      expect(Date.now() - began).toBeLessThan(1500);
      expect(host.stats()).toMatchObject({ running: 0, threads: { started: 3, exited: 3 } });
    },
    TEST_TIMEOUT,
  );

  it(
    'registers nothing for an extension whose start failed, whatever it still sends',
    async () => {
      const { host, counts, spec } = setup();
      const before = counts();

      await expect(host.start(spec('late-frames.js'))).rejects.toThrow(/failed after registering/);
      const atFailure = counts();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(atFailure).toEqual(before);
      expect(counts()).toEqual(before);
      expect(host.stats().threads.live).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe('WorkerHost against a misbehaving extension', () => {
  it(
    'writes only so many of its log lines and says how many it dropped',
    async () => {
      const { host, bus, lines, spec, sender } = setup();
      await host.start(spec('chatty.js'));

      bus.publish('demo:do', 'flood', sender);

      await vi.waitFor(() => expect(lines.at(-1)).toMatch(/after the flood/), WAIT);
      const written = lines.filter((line) => /\] line \d+$/.test(line));
      expect(written).toHaveLength(100);
      expect(lines).toContain('WARN  [bundle:demo] 4900 log lines dropped');
    },
    TEST_TIMEOUT,
  );

  it(
    'treats a frame over the size limit as a crash of that bundle',
    async () => {
      const { host, bus, crashes, spec, sender } = setup();
      await host.start(spec('chatty.js'));

      bus.publish('demo:do', 'big', sender);

      await vi.waitFor(() => expect(crashes).toHaveLength(1), WAIT);
      expect(crashes[0]).toMatch(/frame larger than/);
      await vi.waitFor(
        () => expect(host.stats()).toMatchObject({ running: 0, threads: { live: 0 } }),
        WAIT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'ends an extension that floods the server with messages',
    async () => {
      const { host, bus, crashes, spec, sender } = setup();
      await host.start(spec('chatty.js'));

      bus.publish('demo:do', 'frames', sender);

      await vi.waitFor(() => expect(crashes).toHaveLength(1), { timeout: 5000, interval: 20 });
      expect(crashes[0]).toMatch(/more than \d+ messages in a second/);
      await vi.waitFor(
        () => expect(host.stats()).toMatchObject({ running: 0, threads: { live: 0 } }),
        WAIT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'does not end an extension for logging too much: the lines are dropped where they are written',
    async () => {
      const { host, bus, lines, crashes, spec, sender } = setup();
      await host.start(spec('chatty.js'));

      bus.publish('demo:do', 'flood-many', sender);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      bus.publish('demo:do', 5, sender);

      await vi.waitFor(() => expect(lines).toContain('INFO  [bundle:demo] blocked for 5 ms'), WAIT);
      expect(crashes).toEqual([]);
      expect(host.stats().running).toBe(1);
      expect(lines.filter((line) => /\] line \d+$/.test(line))).toHaveLength(100);
      expect(lines.some((line) => / log lines dropped$/.test(line))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not mistake a busy server for an unresponsive extension',
    async () => {
      const { host, crashes, spec } = setup({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 500 });
      await host.start(spec('chatty.js'));

      // The server's own thread is stuck for longer than the heartbeat timeout.
      const end = Date.now() + 900;
      while (Date.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(crashes).toEqual([]);
      expect(host.stats().running).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it('has a heartbeat that tolerates a few seconds of synchronous work', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(5000);
    expect(DEFAULT_HEARTBEAT_TIMEOUT_MS).toBe(10_000);
  });

  it(
    'reports an extension that stops responding as crashed',
    async () => {
      const { host, bus, crashes, spec, sender } = setup({
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 500,
      });
      await host.start(spec('misbehaves.js'));

      bus.publish('demo:do', 'spin', sender);

      await vi.waitFor(() => expect(crashes).toHaveLength(1), WAIT);
      expect(crashes[0]).toMatch(/did not respond for 500 ms/);
      await vi.waitFor(
        () => expect(host.stats()).toMatchObject({ running: 0, threads: { live: 0 } }),
        WAIT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'leaves an extension alone that blocks for less than the heartbeat timeout',
    async () => {
      const { host, bus, lines, crashes, spec, sender } = setup({
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 2000,
      });
      await host.start(spec('chatty.js'));

      bus.publish('demo:do', 600, sender);

      await vi.waitFor(
        () => expect(lines).toContain('INFO  [bundle:demo] blocked for 600 ms'),
        WAIT,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(crashes).toEqual([]);
      expect(host.stats().running).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('an extension outside the workspace', () => {
  it(
    'can import the SDK without installing anything, and answer with a typed error',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'mooncg-outside-'));
      cleanup.push(() => rm(outside, { recursive: true, force: true }));
      const entry = join(outside, 'index.js');
      await writeFile(
        entry,
        `import { MoonCGError } from '@mooncg/sdk/extension';
         export default async function start(ctx) {
           await ctx.http.get('/teams/:id', (request) => {
             throw new MoonCGError('not_found', 'No team ' + request.params.id);
           });
           await ctx.handle('double', async () => { throw new MoonCGError('invalid', 'not a number'); });
         }`,
      );
      const { host, routes, bus, spec, sender } = setup();

      await host.start({ ...spec('unused.js'), entry });
      const match = routes.match('demo', 'GET', '/teams/7');
      const response = match?.route.invoke({
        method: 'GET',
        path: '/teams/7',
        params: match.params,
        query: {},
        headers: {},
        body: null,
      });

      await expect(response).rejects.toMatchObject({ code: 'not_found', message: 'No team 7' });
      await expect(bus.request('demo:double', 1, sender)).rejects.toMatchObject({
        code: 'invalid',
        message: 'not a number',
      });
    },
    TEST_TIMEOUT,
  );
});

describe('BundleManager with worker threads', () => {
  const crashOnce = `import { existsSync, writeFileSync } from 'node:fs';
    const marker = new URL('./crashed-once', import.meta.url);
    export default async function start(ctx) {
      await ctx.http.get('/alive', () => ({ body: 'yes' }));
      await ctx.on('do', () => setTimeout(() => { throw new Error('asked to crash'); }, 0));
      if (!existsSync(marker)) {
        writeFileSync(marker, '');
        setTimeout(() => { throw new Error('first run crashes'); }, 50);
      }
    }`;

  async function managed(
    files: Record<string, string | object>,
    options: Partial<WorkerHostOptions> = {},
  ) {
    const dir = await temporary.create(files);
    const registry = new ReplicantRegistry();
    const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
    const routes = new RouteTable();
    const { logger, lines } = memoryLogger();
    const host = new WorkerHost({
      registry,
      bus,
      routes,
      logger,
      bootstrap: WORKER_BOOTSTRAP,
      ...options,
    });
    const manager = new BundleManager({ bundlesDir: dir, registry, bus, host, logger });
    cleanup.push(() => manager.close());
    await manager.start();
    const app = await createApp({
      bundles: () => manager.list(),
      routes,
      lifecycle: manager,
      sdkFile: undefined,
    });
    cleanup.push(() => app.close());
    return { manager, host, bus, routes, app, lines };
  }

  const bundle = (extension: string, messages: object = { do: {} }) => ({
    'demo/mooncg.json': manifest('demo', {
      extension: 'extension/index.js',
      capabilities: ['http.routes'],
      messages,
    }),
    'demo/extension/index.js': extension,
  });

  it(
    'restarts a crashed extension by itself and serves again',
    async () => {
      const { manager, host, app } = await managed(bundle(crashOnce));

      await vi.waitFor(() => expect(manager.get('demo')?.state).toBe('failed'), WAIT);
      expect(manager.get('demo')?.errors).toEqual(['Extension crashed: first run crashes']);
      await vi.waitFor(() => expect(manager.get('demo')?.state).toBe('running'), WAIT);

      expect((await app.inject({ url: '/b/demo/api/alive' })).body).toBe('yes');
      expect(host.stats()).toMatchObject({
        running: 1,
        threads: { started: 2, exited: 1, live: 1 },
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'ends with one running extension when it crashes while being reloaded',
    async () => {
      const { manager, host, bus, app } = await managed(bundle(crashOnce));
      await vi.waitFor(() => expect(manager.get('demo')?.state).toBe('running'), WAIT);
      await vi.waitFor(() => expect(host.stats().threads.live).toBe(1), WAIT);

      bus.publish('demo:do', null, { principal: 'tester', bundle: 'demo' });
      const reloaded = await manager.reload('demo');
      await manager.idle();
      await vi.waitFor(() => expect(manager.get('demo')?.state).toBe('running'), WAIT);

      expect(['running', 'failed']).toContain(reloaded.state);
      expect((await app.inject({ url: '/b/demo/api/alive' })).body).toBe('yes');
      await vi.waitFor(
        () => expect(host.stats()).toMatchObject({ running: 1, threads: { live: 1 } }),
        WAIT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'fails requests that are under way when the bundle is disabled',
    async () => {
      const never = `export default async function start(ctx) {
        await ctx.handle('double', () => new Promise(() => {}));
        await ctx.http.get('/never', () => new Promise(() => {}));
      }`;
      const { manager, bus, app } = await managed(bundle(never, { double: {} }));
      const viaHttp = app.inject({ url: '/b/demo/api/never' });
      const viaBus = bus.request('demo:double', 1, { principal: 'tester', bundle: 'demo' });
      viaBus.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));

      await manager.disable('demo');

      const response = await viaHttp;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'unavailable' } });
      await expect(viaBus).rejects.toMatchObject({ code: 'unavailable' });
    },
    TEST_TIMEOUT,
  );
});
