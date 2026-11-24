import { MessageBus, ReplicantRegistry, RouteTable } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionHost, ExtensionServices } from '../src/extension-host/extension-host.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { WorkerHost } from '../src/extension-host/worker-host.js';
import { fixture, memoryLogger } from './helpers.js';

export const WORKER_BOOTSTRAP = new URL('./worker-bootstrap.mjs', import.meta.url);

/** Worker threads take a moment to start; every wait in here is bounded by this. */
const WAIT = { timeout: 8000, interval: 20 };
const TEST_TIMEOUT = 30_000;

const hosts: ExtensionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

function setup(
  create: (services: ExtensionServices) => ExtensionHost,
  services: Partial<ExtensionServices> = {},
) {
  const registry = new ReplicantRegistry();
  const out = registry.declare('demo', 'out', { initial: { pings: [] } }).replicant;
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  bus.declare('demo', 'ping', {});
  bus.declare('demo', 'double', {});
  bus.declare('demo', 'do', {});
  const routes = new RouteTable();
  const { logger, lines } = memoryLogger();
  const host = create({ registry, bus, routes, logger, ...services });
  hosts.push(host);
  const crashes: { bundle: string; message: string }[] = [];
  host.onCrash((bundle, error) => crashes.push({ bundle, message: error.message }));
  const spec = (file: string, capabilities = ['http.routes']) => ({
    bundle: 'demo',
    version: '1.0.0',
    entry: fixture(`extensions/${file}`),
    capabilities,
    permissions: [],
  });
  const sender = { principal: 'tester', kind: 'user', bundle: 'demo' } as const;
  const get = (path: string) => {
    const match = routes.match('demo', 'GET', path);
    if (!match) throw new Error(`No route for ${path}`);
    return match.route.invoke({
      method: 'GET',
      path,
      params: match.params,
      query: {},
      headers: {},
      sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
      body: null,
    });
  };
  return { host, registry, out, bus, routes, lines, crashes, spec, sender, get };
}

const inline = (services: ExtensionServices) => new InlineHost(services);
const worker = (services: ExtensionServices) =>
  new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP });

describe.each([
  ['InlineHost', inline],
  ['WorkerHost', worker],
])('%s', (_name, create) => {
  it(
    'hands the extension the configuration it was started with',
    async () => {
      const { host, out, spec } = setup(create);
      const config = { league: 'A', mail: { password: 'pw-123' } };
      await host.start({ ...spec('full.js'), config });
      expect(out.value).toMatchObject({ config });
    },
    TEST_TIMEOUT,
  );

  it(
    'runs an extension that uses the whole context',
    async () => {
      const { host, out, bus, lines, spec, sender, get } = setup(create);

      await host.start(spec('full.js'));

      expect(out.value).toMatchObject({ bundle: { name: 'demo', version: '1.0.0' }, config: {} });
      expect(lines).toEqual(['INFO  [bundle:demo] started']);

      bus.publish('demo:ping', 'hi', sender);
      await vi.waitFor(
        () => expect(out.value).toMatchObject({ pings: [{ data: 'hi', by: 'tester' }] }),
        WAIT,
      );
      await expect(bus.request('demo:double', 21, sender)).resolves.toBe(42);
      const response = await get('/hello/world');
      expect(JSON.parse(Buffer.from(response.body as string, 'base64').toString())).toEqual({
        hello: 'world',
      });
      expect(host.stats()).toMatchObject({
        running: 1,
        ledger: { demo: { replicants: 1, listeners: 1, handlers: 1, routes: 1, calls: 0 } },
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'runs dispose callbacks on stop and releases everything the extension registered',
    async () => {
      const { host, out, bus, routes, lines, spec, sender } = setup(create);
      await host.start(spec('full.js'));
      const before = out.rev;

      await host.stop('demo');
      bus.publish('demo:ping', 'late', sender);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(lines).toEqual(['INFO  [bundle:demo] started', 'INFO  [bundle:demo] disposed']);
      expect(host.stats()).toMatchObject({ running: 0, ledger: {} });
      expect(routes.count()).toBe(0);
      expect(out.rev).toBe(before);
      await expect(bus.request('demo:double', 1, sender)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(host.stop('demo')).resolves.toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it.each([
    ['throws.js', /sync failure/],
    ['rejects.js', /async failure/],
    ['no-default.js', /default export/],
    ['missing.js', /missing\.js/],
  ])(
    'rejects start when %s fails and leaves nothing behind',
    async (file, message) => {
      const { host, routes, crashes, spec } = setup(create);

      await expect(host.start(spec(file))).rejects.toThrow(message);

      expect(host.stats()).toMatchObject({ running: 0, ledger: {} });
      expect(routes.count()).toBe(0);
      expect(crashes).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'holds the extension to its capabilities and to the policy it is given',
    async () => {
      const without = setup(create);
      await expect(without.host.start(spec('full.js', []))).rejects.toThrow(/http\.routes/);

      // Under a policy that grants it nothing, its own bundle is not there for it.
      const denied = setup(create, { policy: { roles: {} } });
      await expect(denied.host.start(denied.spec('full.js'))).rejects.toThrow(/not running/i);

      function spec(file: string, capabilities: string[]) {
        return without.spec(file, capabilities);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'can run the same bundle again after a stop',
    async () => {
      const { host, bus, spec, sender } = setup(create);
      await host.start(spec('full.js'));
      await host.stop('demo');

      await host.start(spec('full.js'));

      await expect(bus.request('demo:double', 4, sender)).resolves.toBe(8);
      await expect(host.start(spec('full.js'))).rejects.toThrow(/already running/);
    },
    TEST_TIMEOUT,
  );
});

describe('WorkerHost isolation', () => {
  it.each([
    ['an uncaught exception', 'throw', /late crash/],
    ['an unhandled rejection', 'reject', /late rejection/],
    ['a process.exit() call', 'exit', /exit/i],
  ])(
    'reports %s as a crash of that bundle and releases its ledger',
    async (_label, action, message) => {
      const { host, bus, routes, crashes, spec, sender } = setup(worker);
      await host.start(spec('misbehaves.js'));
      expect(routes.count()).toBe(1);

      bus.publish('demo:do', action, sender);

      await vi.waitFor(() => expect(crashes).toHaveLength(1), WAIT);
      expect(crashes[0]).toEqual({ bundle: 'demo', message: expect.stringMatching(message) });
      expect(host.stats()).toMatchObject({ running: 0, ledger: {} });
      expect(routes.count()).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'ends an extension that exceeds its memory limit, and nothing else',
    async () => {
      const { host, bus, crashes, spec, sender } = setup((services) => {
        return new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP, memoryMb: 32 });
      });
      await host.start(spec('misbehaves.js'));

      bus.publish('demo:do', 'hog', sender);

      await vi.waitFor(() => expect(crashes).toHaveLength(1), { timeout: 20_000, interval: 50 });
      expect(crashes[0]?.message).toMatch(/memory/i);
      expect(host.stats().running).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'ends an extension that does not finish its cleanup in time',
    async () => {
      const { host, crashes, spec } = setup((services) => {
        return new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP, stopTimeoutMs: 200 });
      });
      await host.start(spec('stubborn.js'));
      const started = Date.now();

      await host.stop('demo');

      expect(Date.now() - started).toBeLessThan(5000);
      expect(host.stats().running).toBe(0);
      expect(crashes).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'ends an extension that is stuck in a loop',
    async () => {
      const { host, bus, crashes, spec, sender } = setup((services) => {
        return new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP, stopTimeoutMs: 200 });
      });
      await host.start(spec('misbehaves.js'));
      bus.publish('demo:do', 'spin', sender);
      await new Promise((resolve) => setTimeout(resolve, 200));

      await host.stop('demo');

      expect(host.stats().running).toBe(0);
      expect(crashes).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'gives up on an extension that does not start in time',
    async () => {
      const { host, spec } = setup((services) => {
        return new WorkerHost({ ...services, bootstrap: WORKER_BOOTSTRAP, startTimeoutMs: 1 });
      });
      await expect(host.start(spec('full.js'))).rejects.toThrow(/did not start/);
      expect(host.stats().running).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'stops every worker on close',
    async () => {
      const { host, spec } = setup(worker);
      await host.start(spec('full.js'));
      await host.close();
      expect(host.stats()).toMatchObject({ running: 0, ledger: {} });
    },
    TEST_TIMEOUT,
  );
});
