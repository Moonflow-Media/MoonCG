import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MessageBus, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleManager, type BundleManagerOptions } from '../src/bundles/manager.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

function fakeHost() {
  const calls: string[] = [];
  const host: ExtensionHost = {
    async start(spec) {
      calls.push(`start ${spec.bundle}`);
    },
    async stop(bundle) {
      calls.push(`stop ${bundle}`);
    },
    onCrash() {},
    stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
    close: async () => {},
  };
  return { host, calls };
}

const withExtension = (name: string, extra: object = {}) =>
  manifest(name, { extension: 'extension/index.js', ...extra });

const files = () => ({
  'lib/mooncg.json': withExtension('lib', {
    replicants: { data: { default: { n: 0 }, schema: 'schemas/data.json' } },
  }),
  'lib/extension/index.js': 'export default async () => {}',
  'lib/schemas/data.json': { type: 'object' },
  'app/mooncg.json': withExtension('app', { dependencies: { lib: '^1.0.0' } }),
  'app/extension/index.js': 'export default async () => {}',
  'solo/mooncg.json': manifest('solo'),
});

async function setup(options: Partial<BundleManagerOptions> = {}, disabled: string[] = []) {
  const dir = await temporary.create(files());
  const registry = new ReplicantRegistry();
  const { logger, lines } = memoryLogger();
  const storage = memoryStorage();
  for (const name of disabled) await storage.bundles.setDisabled(name, true);
  const fake = fakeHost();
  const manager = new BundleManager({
    bundlesDir: dir,
    registry,
    bus: new MessageBus({ timers: { setTimeout, clearTimeout } }),
    host: fake.host,
    logger,
    settings: storage.bundles,
    ...options,
  });
  await manager.start();
  fake.calls.length = 0;
  const write = async (path: string, content: string | object) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };
  const published = (name: string) =>
    ((registry.get('system:bundles')?.replicant.value ?? []) as Record<string, unknown>[]).find(
      (bundle) => bundle.name === name,
    );
  const revision = () =>
    (registry.get('system:revision')?.replicant.value as { bundles: number } | undefined)
      ?.bundles ?? 0;
  return { dir, manager, registry, lines, write, published, revision, ...fake };
}

describe('the on-air lock', () => {
  const locked = () => {
    const asked: string[] = [];
    return {
      asked,
      onAirLock: (bundle: string, operation: string) => {
        asked.push(`${operation} ${bundle}`);
        return `MoonCG is on air: ${operation} of "${bundle}" is blocked`;
      },
    };
  };

  it('refuses to disable, reload or restart a bundle, before anything is touched', async () => {
    const lock = locked();
    const { manager, calls } = await setup({ onAirLock: lock.onAirLock });

    await expect(manager.disable('solo')).rejects.toMatchObject({ code: 'conflict' });
    await expect(manager.reload('lib')).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('on air'),
    });
    await expect(manager.restartExtension('lib')).rejects.toMatchObject({ code: 'conflict' });
    await expect(manager.reloadIfValid('lib')).rejects.toMatchObject({ code: 'conflict' });

    expect(lock.asked).toEqual(['disable solo', 'reload lib', 'restart lib', 'reload lib']);
    expect(calls).toEqual([]);
    expect(manager.get('solo')?.state).toBe('running');
  });

  it('lets a change through without asking when the lock is overridden', async () => {
    const lock = locked();
    const { manager, calls } = await setup({ onAirLock: lock.onAirLock });

    await manager.restartExtension('lib', { forceOnAir: true });
    await manager.reload('solo', { forceOnAir: true });
    await manager.disable('solo', { forceOnAir: true });
    await manager.remove('solo', { forceOnAir: true }, async () => {});
    const swap = { apply: async () => {}, revert: async () => {} };
    expect((await manager.replace('app', swap, { forceOnAir: true })).outcome).toBe('replaced');

    expect(lock.asked).toEqual([]);
    expect(calls).toContain('stop lib');
    expect(manager.get('solo')).toBeUndefined();
  });

  it('still refuses an update and a removal that are not forced', async () => {
    const lock = locked();
    const { manager } = await setup({ onAirLock: lock.onAirLock });
    const swap = { apply: async () => {}, revert: async () => {} };

    await expect(manager.replace('solo', swap)).rejects.toMatchObject({ code: 'conflict' });
    // Forcing past the bundles that need it is not forcing past the lock.
    await expect(manager.remove('solo', { force: true }, async () => {})).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('does not keep a bundle from being enabled', async () => {
    const lock = locked();
    const { manager } = await setup({ onAirLock: lock.onAirLock }, ['solo']);
    expect((await manager.enable('solo')).state).toBe('running');
  });
});

describe('BundleManager.reloadIfValid', () => {
  it('reloads a bundle whose manifest on disk is valid', async () => {
    const { manager, write, calls } = await setup();
    await write('lib/mooncg.json', withExtension('lib', { version: '1.1.0' }));

    const record = await manager.reloadIfValid('lib');

    expect(record).toMatchObject({ state: 'running', manifest: { version: '1.1.0' } });
    expect(record.reloadErrors).toBeUndefined();
    // The bundle that needs it was stopped first and started again after.
    expect(calls).toEqual(['stop app', 'stop lib', 'start lib', 'start app']);
  });

  it('keeps the last good manifest running when the one on disk is invalid', async () => {
    const { manager, write, calls, published, revision, lines } = await setup();
    const before = revision();
    await write('lib/mooncg.json', '{ "manifest": 1, ');

    const record = await manager.reloadIfValid('lib');

    expect(calls).toEqual([]);
    expect(record.state).toBe('running');
    expect(record.manifest?.version).toBe('1.0.0');
    expect(record.reloadErrors?.[0]).toContain('mooncg.json is not valid JSON');
    expect(published('lib')).toMatchObject({
      state: 'running',
      reloadErrors: [expect.any(String)],
    });
    expect(revision()).toBeGreaterThan(before);
    expect(lines.some((line) => line.includes('keeps running'))).toBe(true);
  });

  it('keeps the bundle running when a schema on disk is unusable', async () => {
    const { manager, write, calls } = await setup();
    await write('lib/schemas/data.json', { type: 'no-such-type' });

    const record = await manager.reloadIfValid('lib');

    expect(calls).toEqual([]);
    expect(record.state).toBe('running');
    expect(record.reloadErrors?.[0]).toContain('replicants.data.schema');
  });

  it('keeps the bundle running when the default no longer fits the schema', async () => {
    const { manager, write, calls } = await setup();
    await write('lib/schemas/data.json', { type: 'string' });

    const record = await manager.reloadIfValid('lib');

    expect(calls).toEqual([]);
    expect(record.reloadErrors?.[0]).toContain('replicants.data.default');
  });

  it('runs the manifest it checked, also when the file changes again before it is loaded', async () => {
    const { manager, write, calls, host, registry } = await setup();
    await write(
      'lib/mooncg.json',
      withExtension('lib', {
        version: '1.1.0',
        replicants: { data: { default: { n: 1 }, schema: 'schemas/data.json' } },
      }),
    );
    // An editor that saves in two steps: the file is cut short again while the old version
    // is being stopped, after it was found valid and before it would be read to start.
    const stop = host.stop.bind(host);
    host.stop = async (bundle) => {
      if (bundle === 'lib') {
        await write('lib/mooncg.json', '{ "manifest": 1, ');
        await write('lib/schemas/data.json', '{ "type": ');
      }
      return stop(bundle);
    };

    const record = await manager.reloadIfValid('lib');

    // Not `failed` with nothing running: what was checked is what runs.
    expect(record).toMatchObject({ state: 'running', manifest: { version: '1.1.0' }, errors: [] });
    expect(registry.get('lib:data')?.replicant.value).toEqual({ n: 1 });
    expect(manager.get('app')?.state).toBe('running');
    expect(calls).toEqual(['stop app', 'stop lib', 'start lib', 'start app']);

    // The change that cut the file short is seen too, and then nothing is stopped for it.
    calls.length = 0;
    const next = await manager.reloadIfValid('lib');
    expect(calls).toEqual([]);
    expect(next).toMatchObject({ state: 'running', manifest: { version: '1.1.0' } });
    expect(next.reloadErrors?.[0]).toContain('mooncg.json is not valid JSON');
  });

  it('takes the error away once the files are right again', async () => {
    const { manager, write, published } = await setup();
    await write('lib/mooncg.json', 'nonsense');
    await manager.reloadIfValid('lib');
    await write('lib/mooncg.json', withExtension('lib', { version: '1.2.0' }));

    const record = await manager.reloadIfValid('lib');

    expect(record.reloadErrors).toBeUndefined();
    expect(published('lib')).not.toHaveProperty('reloadErrors');
    expect(record.manifest?.version).toBe('1.2.0');
  });

  it('does not publish file paths of the server in the error', async () => {
    const { manager, write, dir } = await setup();
    await write('lib/schemas/data.json', '{');
    const record = await manager.reloadIfValid('lib');
    expect(record.reloadErrors?.join(' ')).not.toContain(dir);
  });

  it('gives a failed bundle another try', async () => {
    const { manager, write } = await setup();
    await write('solo/mooncg.json', 'nonsense');
    await manager.reload('solo');
    expect(manager.get('solo')?.state).toBe('failed');
    await write('solo/mooncg.json', manifest('solo', { version: '2.0.0' }));

    const record = await manager.reloadIfValid('solo');

    expect(record).toMatchObject({ state: 'running', manifest: { version: '2.0.0' } });
  });

  it('leaves a disabled bundle alone', async () => {
    const { manager } = await setup({}, ['solo']);
    await expect(manager.reloadIfValid('solo')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('changes that wait', () => {
  it('are published with the bundle and taken away again', async () => {
    const { manager, published, revision } = await setup();
    const before = revision();

    manager.notePending('lib', ['extension', 'dashboard']);
    expect(manager.get('lib')?.pendingChanges).toEqual(['dashboard', 'extension']);
    expect(published('lib')).toMatchObject({ pendingChanges: ['dashboard', 'extension'] });
    expect(revision()).toBeGreaterThan(before);

    manager.notePending('lib', []);
    expect(manager.get('lib')?.pendingChanges).toBeUndefined();
    expect(published('lib')).not.toHaveProperty('pendingChanges');
  });

  it('are nothing to note for a bundle that is not there', async () => {
    const { manager } = await setup();
    expect(() => manager.notePending('nope', ['extension'])).not.toThrow();
  });
});

describe('the file watch hooks', () => {
  function recorder() {
    const events: string[] = [];
    return {
      events,
      watch: {
        open: (name: string) => void events.push(`open ${name}`),
        close: async (name: string) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`close ${name}`);
        },
      },
    };
  }

  it('opens a watch for every bundle that is not disabled', async () => {
    const { events, watch } = recorder();
    await setup({ watch }, ['solo']);
    expect(events.sort()).toEqual(['open app', 'open lib']);
  });

  it('closes the watch of a bundle that is disabled and opens it when it is enabled', async () => {
    const { events, watch } = recorder();
    const { manager } = await setup({ watch });
    events.length = 0;

    await manager.disable('solo');
    await manager.enable('solo');

    expect(events).toEqual(['close solo', 'open solo']);
  });

  it('keeps watching through a reload', async () => {
    const { events, watch } = recorder();
    const { manager } = await setup({ watch });
    events.length = 0;
    await manager.reload('solo');
    expect(events).toEqual([]);
  });

  it('has closed the watch before the files of an update are swapped, and opens it after', async () => {
    const { events, watch } = recorder();
    const { manager } = await setup({ watch });
    events.length = 0;

    await manager.replace('solo', {
      apply: async () => void events.push('apply'),
      revert: async () => void events.push('revert'),
    });

    expect(events).toEqual(['close solo', 'apply', 'open solo']);
  });

  it('opens the watch again when an update is rolled back', async () => {
    const { events, watch } = recorder();
    const { manager } = await setup({ watch });
    events.length = 0;

    const result = await manager.replace('solo', {
      apply: async () => {
        throw new Error('no');
      },
      revert: async () => void events.push('revert'),
    });

    expect(result.outcome).toBe('rolled-back');
    expect(events).toEqual(['close solo', 'revert', 'open solo']);
  });

  it('has closed the watch before a bundle is erased, and does not open it again', async () => {
    const { events, watch } = recorder();
    const { manager } = await setup({ watch });
    events.length = 0;

    await manager.remove('solo', {}, async () => void events.push('erase'));

    expect(events).toEqual(['close solo', 'erase']);
  });

  it('watches a bundle again whose files could not be erased', async () => {
    const { events, watch } = recorder();
    const { manager } = await setup({ watch });
    events.length = 0;

    await expect(
      manager.remove('solo', {}, async () => {
        throw new Error('locked');
      }),
    ).rejects.toThrow('locked');

    expect(events).toEqual(['close solo', 'open solo']);
  });

  it('opens a watch for a bundle once it is installed', async () => {
    const { events, watch } = recorder();
    const { manager, write } = await setup({ watch });
    events.length = 0;

    await manager.install('extra', [], () => write('extra/mooncg.json', manifest('extra')));

    expect(events).toEqual(['open extra']);
  });
});
