import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  createSession,
  encodeMessage,
  MessageBus,
  PROTOCOL_VERSION,
  ReplicantRegistry,
  type ServerMessage,
} from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BundleManager,
  RESTART_ATTEMPTS,
  RESTART_DELAY_MS,
  RESTART_STABLE_MS,
} from '../src/bundles/manager.js';
import type { ExtensionHost, ExtensionSpec } from '../src/extension-host/extension-host.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { createPersistence } from '../src/replicants/persistence.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

function fakeTimers() {
  let now = 0;
  let tasks: { at: number; run: () => void }[] = [];
  const clock = {
    /** Waits for the work a timer started. Set once the manager exists. */
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
    /** Runs what is due, one timer at a time, letting the work each starts finish. */
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

/** A host that records what it is asked to do and can be told to fail or crash. */
function fakeHost() {
  const calls: string[] = [];
  const specs: ExtensionSpec[] = [];
  const failing = new Set<string>();
  let crashed: (bundle: string, error: Error) => void = () => {};
  let active = 0;
  let overlap = 0;
  const work = async (label: string) => {
    active++;
    overlap = Math.max(overlap, active);
    calls.push(label);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  };
  const host: ExtensionHost = {
    async start(spec) {
      specs.push(spec);
      await work(`start ${spec.bundle}`);
      if (failing.has(spec.bundle)) throw new Error('boom');
    },
    stop: (bundle) => work(`stop ${bundle}`),
    onCrash(listener) {
      crashed = listener;
    },
    stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
    close: async () => {},
  };
  return {
    host,
    calls,
    specs,
    failing,
    crash: (bundle: string, message = 'crashed') => crashed(bundle, new Error(message)),
    overlap: () => overlap,
  };
}

const extension = (body = '') => `export default async function start(ctx) {\n${body}\n}`;

/** Three bundles: `lib`, `app` which depends on it, and `solo`. */
const files = () => ({
  'lib/mooncg.json': manifest('lib', {
    extension: 'extension/index.js',
    replicants: { data: { default: { n: 0 }, persistent: true } },
    messages: { changed: {} },
  }),
  'lib/extension/index.js': extension(),
  'app/mooncg.json': manifest('app', {
    extension: 'extension/index.js',
    dependencies: { lib: '^1.0.0' },
    capabilities: ['bundle:lib:read'],
  }),
  'app/extension/index.js': extension(),
  'solo/mooncg.json': manifest('solo', { title: 'Solo', replicants: { value: { default: 1 } } }),
});

async function setup(
  bundleFiles: Record<string, string | object> = files(),
  options: { real?: boolean; disabled?: string[] } = {},
) {
  const dir = await temporary.create(bundleFiles);
  const registry = new ReplicantRegistry();
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  const { logger, lines } = memoryLogger();
  const storage = memoryStorage();
  for (const name of options.disabled ?? []) await storage.bundles.setDisabled(name, true);
  const persistence = createPersistence({ store: storage.replicants, logger });
  const fake = fakeHost();
  const clock = fakeTimers();
  const manager = new BundleManager({
    bundlesDir: dir,
    registry,
    bus,
    host: options.real ? new InlineHost({ registry, bus, logger }) : fake.host,
    logger,
    persistence,
    settings: storage.bundles,
    timers: clock.timers,
  });
  clock.settle = () => manager.idle();
  await manager.start();
  const states = () => Object.fromEntries(manager.list().map(({ name, state }) => [name, state]));
  const edit = (path: string, content: string | object) =>
    writeFile(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  return {
    dir,
    manager,
    registry,
    bus,
    lines,
    storage,
    persistence,
    states,
    edit,
    ...fake,
    ...clock,
  };
}

describe('BundleManager.start', () => {
  it('starts every bundle, dependencies first, and publishes the states', async () => {
    const { manager, registry, bus, calls, specs, states } = await setup();

    expect(calls).toEqual(['start lib', 'start app']);
    expect(states()).toEqual({ app: 'running', lib: 'running', solo: 'running' });
    expect(specs[1]).toMatchObject({ bundle: 'app', capabilities: ['bundle:lib:read'] });
    expect(bus.get('lib:changed')).toBeDefined();
    expect(manager.isRunning('lib')).toBe(true);
    expect(manager.isRunning('nope')).toBe(false);
    expect(registry.get('system:bundles')).toMatchObject({
      readPermission: 'system:bundles.manage',
      readOnly: true,
    });
    // What everyone with the dashboard may follow tells only that something changed.
    expect(registry.get('system:revision')).toMatchObject({
      readPermission: 'system:dashboard.view',
      readOnly: true,
    });
    expect(registry.get('system:revision')?.replicant.value).toEqual({
      bundles: expect.any(Number),
    });
    expect(registry.get('system:bundles')?.replicant.value).toEqual([
      { name: 'app', state: 'running', version: '1.0.0', errors: [] },
      { name: 'lib', state: 'running', version: '1.0.0', errors: [] },
      { name: 'solo', state: 'running', title: 'Solo', version: '1.0.0', errors: [] },
    ]);
  });

  it('leaves a bundle that was disabled before the restart disabled', async () => {
    const { registry, calls, states } = await setup(files(), { disabled: ['solo', 'lib'] });

    expect(states()).toEqual({ app: 'failed', lib: 'disabled', solo: 'disabled' });
    expect(calls).toEqual([]);
    expect(registry.get('solo:value')).toBeUndefined();
  });

  it('fails bundles with dependency problems, with the reason, and starts the rest', async () => {
    const { manager, states } = await setup({
      'a/mooncg.json': manifest('a', { dependencies: { ghost: '*' } }),
      'b/mooncg.json': manifest('b', { dependencies: { c: '^2.0.0' } }),
      'c/mooncg.json': manifest('c'),
      'x/mooncg.json': manifest('x', { dependencies: { y: '*' } }),
      'y/mooncg.json': manifest('y', { dependencies: { x: '*' } }),
      'system/mooncg.json': manifest('system'),
    });

    expect(states()).toEqual({
      a: 'failed',
      b: 'failed',
      c: 'running',
      system: 'failed',
      x: 'failed',
      y: 'failed',
    });
    expect(manager.get('a')?.errors).toEqual([
      'dependencies.ghost: bundle "ghost" is not installed',
    ]);
    expect(manager.get('b')?.errors[0]).toMatch(/needs version \^2\.0\.0, but 1\.0\.0/);
    expect(manager.get('x')?.errors[0]).toMatch(/cycle/);
    expect(manager.get('system')?.errors[0]).toMatch(/reserved/);
  });
});

describe('BundleManager.disable', () => {
  it('stops the extension, saves and removes its replicants and messages, and remembers it', async () => {
    const { manager, registry, bus, storage, calls, states } = await setup();
    await manager.disable('app');
    const data = registry.get('lib:data')?.replicant;
    data?.applyOp({ patches: [{ op: 'replace', path: '/n', value: 5 }] });
    calls.length = 0;

    const record = await manager.disable('lib');

    expect(record).toMatchObject({ name: 'lib', state: 'disabled' });
    expect(calls).toEqual(['stop lib']);
    expect(registry.get('lib:data')).toBeUndefined();
    expect(bus.get('lib:changed')).toBeUndefined();
    expect(await storage.replicants.load('lib', 'data')).toMatchObject({ rev: 1, value: { n: 5 } });
    expect(await storage.bundles.disabled()).toEqual(['app', 'lib']);
    expect(states()).toEqual({ app: 'disabled', lib: 'disabled', solo: 'running' });
  });

  it('tells subscribed clients that the replicants are gone', async () => {
    const { manager, registry } = await setup();
    const sent: ServerMessage[] = [];
    const session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bundleExists: (name) => manager.isRunning(name),
      send: (msg) => sent.push(msg),
    });
    session.receive(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'solo' }));
    session.receive(encodeMessage({ t: 'rep.sub', id: 1, name: 'value' }));
    sent.length = 0;

    await manager.disable('solo');
    const late = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bundleExists: (name) => manager.isRunning(name),
      send: (msg) => sent.push(msg),
    });
    late.receive(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'solo' }));

    expect(sent).toMatchObject([
      { t: 'rep.gone', name: 'solo:value' },
      { t: 'err', code: 'not_found' },
    ]);
  });

  it('refuses while a running bundle depends on it', async () => {
    const { manager, calls, states } = await setup();
    calls.length = 0;

    await expect(manager.disable('lib')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('app'),
    });

    expect(calls).toEqual([]);
    expect(states().lib).toBe('running');
  });

  it('refuses for a bundle that is unknown or already disabled', async () => {
    const { manager } = await setup();
    await manager.disable('solo');
    await expect(manager.disable('solo')).rejects.toMatchObject({ code: 'conflict' });
    await expect(manager.disable('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('BundleManager.enable', () => {
  it('reads the manifest again, restores stored values and starts the extension', async () => {
    const { manager, registry, storage, edit, calls } = await setup();
    await manager.disable('app');
    registry
      .get('lib:data')
      ?.replicant.applyOp({ patches: [{ op: 'replace', path: '/n', value: 9 }] });
    await manager.disable('lib');
    await edit(
      'lib/mooncg.json',
      manifest('lib', {
        title: 'Library',
        extension: 'extension/index.js',
        replicants: { data: { default: { n: 0 }, persistent: true }, added: { default: 'new' } },
      }),
    );
    calls.length = 0;

    const record = await manager.enable('lib');

    expect(record).toMatchObject({ state: 'running', manifest: { title: 'Library' } });
    expect(calls).toEqual(['start lib']);
    expect(registry.get('lib:data')?.replicant).toMatchObject({ rev: 1, value: { n: 9 } });
    expect(registry.get('lib:added')?.replicant.value).toBe('new');
    expect(await storage.bundles.disabled()).toEqual(['app']);
  });

  it('refuses for a running or unknown bundle, and needs its dependencies running', async () => {
    const { manager, states } = await setup();
    await expect(manager.enable('solo')).rejects.toMatchObject({ code: 'conflict' });
    await expect(manager.enable('nope')).rejects.toMatchObject({ code: 'not_found' });

    await manager.disable('app');
    await manager.disable('lib');
    const app = await manager.enable('app');

    expect(app.state).toBe('failed');
    expect(app.errors).toEqual(['dependencies.lib: bundle "lib" is not running']);
    expect(states().lib).toBe('disabled');
  });

  it('picks up a bundle folder that appeared after the server started', async () => {
    const { manager, dir } = await setup();
    await temporary.add(dir, { 'late/mooncg.json': manifest('late') });

    const record = await manager.enable('late');

    expect(record.state).toBe('running');
    expect(manager.list().map((bundle) => bundle.name)).toContain('late');
  });
});

describe('BundleManager.reload', () => {
  it('restarts the bundle with what is on disk now', async () => {
    const { manager, registry, edit, calls } = await setup();
    await edit('solo/mooncg.json', manifest('solo', { replicants: { other: { default: 2 } } }));

    const record = await manager.reload('solo');

    expect(record.state).toBe('running');
    expect(registry.get('solo:value')).toBeUndefined();
    expect(registry.get('solo:other')?.replicant.value).toBe(2);
    expect(calls).toEqual(['start lib', 'start app', 'stop solo']);
  });

  it('leaves the bundle failed when the new manifest is broken, and recovers once it is fixed', async () => {
    const { manager, edit, states } = await setup();
    await edit('solo/mooncg.json', '{ "manifest": 1, "kind": "bundle", "name": "solo" }');

    const broken = await manager.reload('solo');
    expect(broken.state).toBe('failed');
    expect(broken.errors[0]).toMatch(/^version: /);
    expect(states()).toMatchObject({ app: 'running', lib: 'running' });

    await edit('solo/mooncg.json', manifest('solo'));
    expect((await manager.reload('solo')).state).toBe('running');
  });

  it('leaves the bundle failed when its extension fails to start', async () => {
    const { manager, registry, failing } = await setup();
    failing.add('lib');

    const record = await manager.reload('lib');

    expect(record).toMatchObject({
      state: 'failed',
      errors: ['Extension failed to start: boom'],
      lastError: 'Extension failed to start: boom',
    });
    expect(registry.get('lib:data')).toBeUndefined();
    expect(manager.get('app')?.state).toBe('failed');
  });

  it('stops dependents first and starts them again afterwards', async () => {
    const { manager, calls, states } = await setup();
    calls.length = 0;

    await manager.reload('lib');

    expect(calls).toEqual(['stop app', 'stop lib', 'start lib', 'start app']);
    expect(states()).toEqual({ app: 'running', lib: 'running', solo: 'running' });
  });

  it('refuses for a disabled or unknown bundle', async () => {
    const { manager } = await setup();
    await manager.disable('solo');
    await expect(manager.reload('solo')).rejects.toMatchObject({ code: 'conflict' });
    await expect(manager.reload('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails a bundle whose folder was removed', async () => {
    const { manager, dir } = await setup();
    await rm(join(dir, 'solo'), { recursive: true });
    const record = await manager.reload('solo');
    expect(record).toMatchObject({ state: 'failed', errors: ['mooncg.json not found'] });
  });
});

describe('crashes', () => {
  it('marks the bundle failed with the error and removes what it exposed', async () => {
    const { manager, registry, bus, crash, states, lines } = await setup();

    crash('lib', 'late crash');
    await manager.idle();

    expect(manager.get('lib')).toMatchObject({
      state: 'failed',
      errors: ['Extension crashed: late crash'],
      lastError: 'Extension crashed: late crash',
    });
    expect(registry.get('lib:data')).toBeUndefined();
    expect(bus.get('lib:changed')).toBeUndefined();
    expect(states()).toMatchObject({ app: 'failed', solo: 'running' });
    expect(lines).toContain('ERROR [bundle:lib] Extension crashed: late crash');
  });

  it('restarts the bundle after a delay', async () => {
    const { manager, crash, calls, advance } = await setup();
    crash('lib');
    await manager.idle();
    calls.length = 0;

    await advance(RESTART_DELAY_MS - 1);
    expect(calls).toEqual([]);
    await advance(1);

    expect(calls).toEqual(['start lib', 'start app']);
    expect(manager.get('lib')).toMatchObject({ state: 'running', errors: [] });
  });

  it('gives up after three attempts with growing delays', async () => {
    const { manager, crash, failing, calls, advance, lines } = await setup();
    failing.add('lib');
    crash('lib');
    await manager.idle();
    calls.length = 0;

    await advance(RESTART_DELAY_MS);
    await advance(RESTART_DELAY_MS * 2);
    await advance(RESTART_DELAY_MS * 4);
    await advance(RESTART_DELAY_MS * 100);

    expect(RESTART_ATTEMPTS).toBe(3);
    expect(calls).toEqual(['start lib', 'start lib', 'start lib']);
    expect(manager.get('lib')?.state).toBe('failed');
    expect(lines.at(-1)).toMatch(/\[bundle:lib\] .*not restarted again/);
  });

  it('counts attempts anew once the bundle has run for a while', async () => {
    const { manager, crash, calls, advance } = await setup();
    const crashAndRestart = async (delay: number) => {
      crash('lib');
      await manager.idle();
      await advance(delay);
    };
    await crashAndRestart(RESTART_DELAY_MS);
    await crashAndRestart(RESTART_DELAY_MS * 2);
    await advance(RESTART_STABLE_MS);
    calls.length = 0;

    // A fresh count: the first delay again, not the third.
    await crashAndRestart(RESTART_DELAY_MS);

    expect(calls).toEqual(['stop app', 'start lib', 'start app']);
    expect(manager.get('lib')?.state).toBe('running');
  });

  it('does not restart a bundle that was disabled in the meantime', async () => {
    const { manager, crash, calls, advance, pending } = await setup();
    await manager.disable('app');
    crash('lib');
    await manager.idle();
    await manager.disable('lib');
    calls.length = 0;

    await advance(RESTART_DELAY_MS * 10);

    expect(calls).toEqual([]);
    expect(pending()).toBe(0);
    expect(manager.get('lib')?.state).toBe('disabled');
  });
});

describe('BundleManager with real extensions', () => {
  it('lets an extension use a dependency it has the capability for', async () => {
    const { registry, states } = await setup(
      {
        'lib/mooncg.json': manifest('lib', { replicants: { data: { default: 'from lib' } } }),
        'app/mooncg.json': manifest('app', {
          extension: 'extension/index.js',
          dependencies: { lib: '*' },
          capabilities: ['bundle:lib:read'],
          replicants: { seen: {}, denied: {} },
        }),
        'app/extension/index.js': extension(`
          const data = ctx.replicant('lib:data');
          await data.ready;
          await ctx.replicant('seen').set(data.value);
          await ctx.replicant('denied').set(
            await data.set('changed').then(() => 'written', (error) => error.code),
          );`),
      },
      { real: true },
    );

    expect(states()).toEqual({ app: 'running', lib: 'running' });
    expect(registry.get('app:seen')?.replicant.value).toBe('from lib');
    expect(registry.get('app:denied')?.replicant.value).toBe('forbidden');
    expect(registry.get('lib:data')?.replicant.value).toBe('from lib');
  });

  it('stops everything on close', async () => {
    const { manager, registry } = await setup(
      {
        'solo/mooncg.json': manifest('solo', {
          extension: 'extension/index.js',
          replicants: { stopped: { default: false } },
        }),
        'solo/extension/index.js': extension(
          "ctx.onDispose(() => ctx.replicant('stopped').set(true));",
        ),
      },
      { real: true },
    );
    const stopped = registry.get('solo:stopped')?.replicant;

    await manager.close();

    expect(stopped?.value).toBe(true);
  });
});
