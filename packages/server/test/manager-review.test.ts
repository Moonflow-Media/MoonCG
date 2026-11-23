import { MessageBus, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundleManager, RESTART_DELAY_MS } from '../src/bundles/manager.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

const WAIT = { timeout: 3000, interval: 10 };

/** Fails the test instead of hanging it when something does not settle. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Not settled within ${ms} ms`)), ms),
    ),
  ]);
}

function fakeTimers() {
  let now = 0;
  let tasks: { at: number; run: () => void }[] = [];
  const clock = {
    settle: async () => {},
    timers: {
      setTimeout(run: () => void, ms: number) {
        const task = { at: now + ms, run };
        tasks.push(task);
        return task;
      },
      clearTimeout(handle: unknown) {
        tasks = tasks.filter((task) => task !== handle);
      },
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = tasks.filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        tasks = tasks.filter((task) => task !== due);
        now = due.at;
        due.run();
        await clock.settle();
      }
      now = end;
    },
    pending: () => tasks.length,
  };
  return clock;
}

/** A host under the test's control: starts can hang, fail, and extensions can crash. */
function fakeHost() {
  const calls: string[] = [];
  const failing = new Set<string>();
  const hanging = new Map<string, (error?: Error) => void>();
  const hang = new Set<string>();
  const active = new Map<string, number>();
  let crashed: (bundle: string, error: Error) => void = () => {};
  let busy = 0;
  let closed = false;
  let mostAtOnce = 0;
  let mostPerBundle = 0;
  const work = async (bundle: string, label: string, body: () => Promise<void>) => {
    busy++;
    active.set(bundle, (active.get(bundle) ?? 0) + 1);
    mostAtOnce = Math.max(mostAtOnce, busy);
    mostPerBundle = Math.max(mostPerBundle, active.get(bundle) ?? 0);
    calls.push(label);
    try {
      await body();
    } finally {
      busy--;
      active.set(bundle, (active.get(bundle) ?? 1) - 1);
    }
  };
  const host: ExtensionHost = {
    start: (spec) =>
      work(spec.bundle, `start ${spec.bundle}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (hang.has(spec.bundle)) {
          if (closed) throw new Error('The server is shutting down');
          await new Promise<void>((resolve, reject) => {
            hanging.set(spec.bundle, (error) => (error ? reject(error) : resolve()));
          });
        }
        if (failing.has(spec.bundle)) throw new Error('boom');
      }),
    stop: (bundle) =>
      work(bundle, `stop ${bundle}`, () => new Promise((resolve) => setTimeout(resolve, 5))),
    onCrash(listener) {
      crashed = listener;
    },
    stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
    async close() {
      closed = true;
      calls.push('close');
      for (const settle of hanging.values()) settle(new Error('The server is shutting down'));
      hanging.clear();
    },
  };
  return {
    host,
    calls,
    failing,
    hang,
    release(bundle: string) {
      hang.delete(bundle);
      hanging.get(bundle)?.();
      hanging.delete(bundle);
    },
    crash: (bundle: string, message = 'crashed') => crashed(bundle, new Error(message)),
    mostAtOnce: () => mostAtOnce,
    mostPerBundle: () => mostPerBundle,
  };
}

const entry = 'export default async function start() {}';

/** `lib`, `app` which depends on it, `top` which depends on `app`, and two loners. */
const files = () => ({
  'lib/mooncg.json': manifest('lib', {
    extension: 'extension/index.js',
    replicants: { data: { default: 1 } },
  }),
  'lib/extension/index.js': entry,
  'app/mooncg.json': manifest('app', {
    extension: 'extension/index.js',
    dependencies: { lib: '*' },
  }),
  'app/extension/index.js': entry,
  'top/mooncg.json': manifest('top', {
    extension: 'extension/index.js',
    dependencies: { app: '*' },
  }),
  'top/extension/index.js': entry,
  'solo/mooncg.json': manifest('solo', { extension: 'extension/index.js' }),
  'solo/extension/index.js': entry,
  'slow/mooncg.json': manifest('slow', { extension: 'extension/index.js' }),
  'slow/extension/index.js': entry,
});

async function setup(
  options: {
    files?: Record<string, string | object>;
    hang?: string[];
    failing?: string[];
    boot?: boolean;
  } = {},
) {
  const dir = await temporary.create(options.files ?? files());
  const registry = new ReplicantRegistry();
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  const { logger, lines } = memoryLogger();
  const storage = memoryStorage();
  const fake = fakeHost();
  for (const name of options.hang ?? []) fake.hang.add(name);
  for (const name of options.failing ?? []) fake.failing.add(name);
  const clock = fakeTimers();
  const manager = new BundleManager({
    bundlesDir: dir,
    registry,
    bus,
    host: fake.host,
    logger,
    settings: storage.bundles,
    timers: clock.timers,
  });
  clock.settle = () => manager.idle();
  if (options.boot !== false) await manager.start();
  const states = () => Object.fromEntries(manager.list().map(({ name, state }) => [name, state]));
  return { dir, manager, registry, lines, storage, states, ...fake, ...clock };
}

describe('starting bundles at boot', () => {
  it('shows bundles as enabling at once and does not wait for a hung one', async () => {
    const { manager, states, calls, release } = await setup({ boot: false, hang: ['slow'] });

    await manager.load();
    expect(states()).toEqual({
      app: 'enabling',
      lib: 'enabling',
      slow: 'enabling',
      solo: 'enabling',
      top: 'enabling',
    });
    const started = manager.startAll();

    await vi.waitFor(
      () =>
        expect(states()).toEqual({
          app: 'running',
          lib: 'running',
          slow: 'enabling',
          solo: 'running',
          top: 'running',
        }),
      WAIT,
    );
    expect(calls.indexOf('start lib')).toBeLessThan(calls.indexOf('start app'));
    expect(calls.indexOf('start app')).toBeLessThan(calls.indexOf('start top'));

    release('slow');
    await within(2000, started);
    expect(states().slow).toBe('running');
  });

  it('starts bundles that do not depend on each other at the same time', async () => {
    const { mostAtOnce, mostPerBundle } = await setup();
    expect(mostAtOnce()).toBeGreaterThanOrEqual(3);
    expect(mostPerBundle()).toBe(1);
  });
});

describe('lifecycle calls while another bundle is busy', () => {
  it('answers for an unrelated bundle without waiting for a hung start', async () => {
    const { manager, states, release } = await setup({ boot: false, hang: ['slow'] });
    await manager.load();
    const started = manager.startAll();
    await vi.waitFor(() => expect(states().solo).toBe('running'), WAIT);

    const reloaded = await within(1000, manager.reload('solo'));
    const disabled = await within(1000, manager.disable('top'));

    expect(reloaded.state).toBe('running');
    expect(disabled.state).toBe('disabled');
    expect(states().slow).toBe('enabling');
    release('slow');
    await within(2000, started);
  });

  it('still runs the calls for one bundle, and for a bundle and its dependents, in turn', async () => {
    const { manager, mostPerBundle, states } = await setup();

    const results = await Promise.allSettled([
      manager.reload('solo'),
      manager.reload('lib'),
      manager.disable('top'),
      manager.reload('app'),
      manager.enable('top'),
      manager.reload('solo'),
      manager.reload('lib'),
    ]);

    expect(results.map((result) => result.status)).toEqual(Array(7).fill('fulfilled'));
    expect(mostPerBundle()).toBe(1);
    expect(states()).toEqual({
      app: 'running',
      lib: 'running',
      slow: 'running',
      solo: 'running',
      top: 'running',
    });
  });

  it('closes within a bounded time although a start is hanging', async () => {
    const { manager, calls } = await setup({ boot: false, hang: ['slow'] });
    await manager.load();
    const started = manager.startAll();
    await vi.waitFor(() => expect(calls).toContain('start slow'), WAIT);

    await within(2000, manager.close());

    expect(calls).toContain('close');
    await within(2000, started);
  });
});

describe('bundle names', () => {
  it.each([['../'], ['..'], ['.hidden'], ['a/b'], ['Bad_Name'], ['%2e%2e'], ['']])(
    'refuses %j for every lifecycle call and creates nothing',
    async (name) => {
      const { manager, storage, dir } = await setup();
      await temporary.add(dir, { '.hidden/mooncg.json': manifest('hidden') });
      const before = manager.list().map((bundle) => bundle.name);

      for (const call of [manager.enable(name), manager.disable(name), manager.reload(name)]) {
        await expect(call).rejects.toMatchObject({ code: 'not_found' });
      }

      expect(manager.list().map((bundle) => bundle.name)).toEqual(before);
      expect(await storage.bundles.disabled()).toEqual([]);
    },
  );

  it('creates no record for a valid name without a folder', async () => {
    const { manager } = await setup();
    await expect(manager.enable('ghost')).rejects.toMatchObject({ code: 'not_found' });
    expect(manager.get('ghost')).toBeUndefined();
  });
});

describe('restart policy', () => {
  it('does not retry a start that was asked for and failed', async () => {
    const { manager, failing, calls, pending, advance } = await setup({ failing: ['solo'] });
    expect(manager.get('solo')?.state).toBe('failed');

    failing.add('lib');
    await manager.reload('lib');
    await manager.disable('slow');
    failing.add('slow');
    await manager.enable('slow');
    calls.length = 0;
    await advance(RESTART_DELAY_MS * 100);

    expect(pending()).toBe(0);
    expect(calls).toEqual([]);
    expect(manager.get('slow')?.state).toBe('failed');
  });

  it('keeps the count of restarts when enable is refused for a running bundle', async () => {
    const { manager, crash, calls, advance } = await setup();
    crash('solo');
    await manager.idle();
    await advance(RESTART_DELAY_MS);
    expect(manager.get('solo')?.state).toBe('running');

    await expect(manager.enable('solo')).rejects.toMatchObject({ code: 'conflict' });
    crash('solo');
    await manager.idle();
    calls.length = 0;

    // The second restart in a row waits twice as long as the first.
    await advance(RESTART_DELAY_MS);
    expect(calls).toEqual([]);
    await advance(RESTART_DELAY_MS);
    expect(calls).toEqual(['start solo']);
  });

  it('leaves a dependent failed, with the reason, when it does not come back after a reload', async () => {
    const { manager, failing, pending, states } = await setup();
    failing.add('app');

    await manager.reload('lib');

    expect(states()).toMatchObject({ lib: 'running', app: 'failed', top: 'failed' });
    expect(manager.get('app')?.errors).toEqual([
      'Restart after the reload of "lib" failed: Extension failed to start: boom',
    ]);
    expect(manager.get('top')?.errors[0]).toMatch(/Restart after the reload of "lib" failed: /);
    expect(pending()).toBe(0);
  });

  it('stops the dependents of a crashed bundle and starts them again once it is back', async () => {
    const { manager, crash, calls, states, advance } = await setup();
    calls.length = 0;

    crash('lib', 'late crash');
    await manager.idle();

    expect(calls).toEqual(['stop top', 'stop app']);
    expect(states()).toMatchObject({
      lib: 'failed',
      app: 'failed',
      top: 'failed',
      solo: 'running',
    });
    expect(manager.get('app')?.errors).toEqual(['Stopped because bundle "lib" crashed']);
    expect(manager.get('top')?.errors).toEqual(['Stopped because bundle "lib" crashed']);

    calls.length = 0;
    await advance(RESTART_DELAY_MS);

    expect(calls).toEqual(['start lib', 'start app', 'start top']);
    expect(states()).toMatchObject({ lib: 'running', app: 'running', top: 'running' });
    expect(manager.get('app')?.errors).toEqual([]);
  });

  it('leaves the dependents failed, naming the bundle, when it is not restarted again', async () => {
    const { manager, crash, failing, states, advance } = await setup();
    failing.add('lib');
    crash('lib');
    await manager.idle();

    await advance(RESTART_DELAY_MS * 100);

    expect(states()).toMatchObject({ lib: 'failed', app: 'failed', top: 'failed' });
    expect(manager.get('app')?.errors).toEqual(['Bundle "lib" crashed and was not restarted']);
  });

  it('starts the stopped dependents when an administrator brings the bundle back', async () => {
    const { manager, crash, calls, states, pending } = await setup();
    crash('lib');
    await manager.idle();
    calls.length = 0;

    await manager.enable('lib');

    expect(calls).toEqual(['start lib', 'start app', 'start top']);
    expect(states()).toMatchObject({ lib: 'running', app: 'running', top: 'running' });
    expect(pending()).toBe(0);
  });
});

describe('published errors', () => {
  it('keep file paths out of the bundle list and in the log', async () => {
    const { manager, dir, lines } = await setup({
      files: {
        'game/mooncg.json': manifest('game', {
          replicants: { score: { schema: 'schemas/score.json' } },
        }),
      },
    });

    const [error] = manager.get('game')?.errors ?? [];

    expect(error).toMatch(/^replicants\.score\.schema: "schemas\/score\.json" could not be read/);
    expect(error).not.toContain(dir);
    expect(error).toContain("'schemas/score.json'");
    expect(manager.get('game')?.lastError).toBe(error);
    expect(lines.join('\n')).toContain(dir);
  });
});
