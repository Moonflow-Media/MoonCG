import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Json, MessageBus, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleManager, type BundleManagerOptions } from '../src/bundles/manager.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

/** A host that records what it is asked to do; `failing` holds the `name@version` that fail. */
function fakeHost() {
  const calls: string[] = [];
  const failing = new Set<string>();
  const host: ExtensionHost = {
    async start(spec) {
      calls.push(`start ${spec.bundle}@${spec.version}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (failing.has(`${spec.bundle}@${spec.version}`)) throw new Error('boom');
    },
    async stop(bundle) {
      calls.push(`stop ${bundle}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    onCrash() {},
    stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
    close: async () => {},
  };
  return { host, calls, failing };
}

const withExtension = (name: string, version: string, extra: object = {}) =>
  manifest(name, { version, extension: 'extension/index.js', ...extra });

/** `lib`, `app` which depends on it, and `solo` which has no extension. */
const files = () => ({
  'lib/mooncg.json': withExtension('lib', '1.0.0'),
  'app/mooncg.json': withExtension('app', '1.0.0', { dependencies: { lib: '>=1.0.0' } }),
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
  const states = () => Object.fromEntries(manager.list().map(({ name, state }) => [name, state]));
  const write = async (path: string, content: string | object) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };
  /** What `system:bundles` says about a bundle right now. */
  const published = (name: string) =>
    (
      (registry.get('system:bundles')?.replicant.value ?? []) as { name: string; state: string }[]
    ).find((bundle) => bundle.name === name)?.state;
  /** A swap that writes `next` as the manifest of `name`, and the old one back on revert. */
  const swapTo = (name: string, next: object, log: string[] = []) => {
    const before = manager.get(name)?.manifest;
    const previous = withExtension(name, before?.version ?? '1.0.0', {
      dependencies: before?.dependencies ?? {},
    });
    return {
      log,
      apply: async () => {
        log.push(`apply while ${published(name)}`);
        await write(`${name}/mooncg.json`, next);
      },
      revert: async () => {
        log.push(`revert while ${published(name)}`);
        await write(`${name}/mooncg.json`, previous);
      },
    };
  };
  return { dir, manager, storage, registry, lines, states, write, published, swapTo, ...fake };
}

describe('BundleManager.install', () => {
  it('puts the bundle in place while it is "installing", then starts it', async () => {
    const { manager, write, published, calls } = await setup();
    const seen: (string | undefined)[] = [];

    const record = await manager.install('fresh', [], async () => {
      seen.push(published('fresh'));
      await write('fresh/mooncg.json', withExtension('fresh', '0.3.0'));
    });

    expect(seen).toEqual(['installing']);
    expect(record).toMatchObject({ name: 'fresh', state: 'running', errors: [] });
    expect(record.manifest?.version).toBe('0.3.0');
    expect(calls).toEqual(['start fresh@0.3.0']);
    expect(published('fresh')).toBe('running');
  });

  it('refuses a name that is installed, and puts nothing in place', async () => {
    const { manager, states } = await setup();
    let placed = false;
    const installed = manager.install('lib', [], async () => {
      placed = true;
    });
    await expect(installed).rejects.toMatchObject({ code: 'conflict' });
    expect(placed).toBe(false);
    expect(states().lib).toBe('running');
  });

  it('refuses what cannot be the name of a bundle', async () => {
    const { manager } = await setup();
    for (const name of ['../evil', 'UPPER', '', 'system']) {
      await expect(manager.install(name, [], async () => {})).rejects.toMatchObject({
        code: expect.stringMatching(/invalid|not_found/),
      });
    }
  });

  it('forgets a bundle that could not be put in place', async () => {
    const { manager, states, published } = await setup();
    const installed = manager.install('fresh', [], async () => {
      throw new Error('disk full');
    });
    await expect(installed).rejects.toThrow('disk full');
    expect(states().fresh).toBeUndefined();
    expect(published('fresh')).toBeUndefined();
    // The name is free again.
    await expect(manager.install('fresh', [], async () => {})).resolves.toMatchObject({
      state: 'failed',
    });
  });

  it('leaves a bundle that does not start as failed, with its error', async () => {
    const { manager, write, failing, states } = await setup();
    failing.add('fresh@1.0.0');
    const record = await manager.install('fresh', [], () =>
      write('fresh/mooncg.json', withExtension('fresh', '1.0.0')),
    );
    expect(record.state).toBe('failed');
    expect(record.errors).toEqual(['Extension failed to start: boom']);
    expect(states()).toMatchObject({ lib: 'running', app: 'running', solo: 'running' });
  });

  it('starts a bundle whose name was disabled when it was last removed', async () => {
    const { manager, write, storage } = await setup();
    await storage.bundles.setDisabled('fresh', true);
    const record = await manager.install('fresh', [], () =>
      write('fresh/mooncg.json', manifest('fresh')),
    );
    expect(record.state).toBe('running');
    expect(await storage.bundles.disabled()).toEqual([]);
  });
});

describe('BundleManager.replace', () => {
  it('stops the bundle, swaps the files while it is "updating" and starts the new version', async () => {
    const { manager, swapTo, calls, published } = await setup();
    const swap = swapTo('solo', manifest('solo', { version: '2.0.0', title: 'Solo two' }));

    const result = await manager.replace('solo', swap);

    expect(result.outcome).toBe('replaced');
    expect(result.record).toMatchObject({ state: 'running', errors: [] });
    expect(result.record.manifest).toMatchObject({ version: '2.0.0', title: 'Solo two' });
    expect(swap.log).toEqual(['apply while updating']);
    expect(calls).toEqual(['stop solo']);
    expect(published('solo')).toBe('running');
  });

  it('stops the bundles that depend on it first and starts them again afterwards', async () => {
    const { manager, swapTo, calls, states } = await setup();
    const result = await manager.replace('lib', swapTo('lib', withExtension('lib', '1.1.0')));
    expect(result.outcome).toBe('replaced');
    expect(calls).toEqual(['stop app', 'stop lib', 'start lib@1.1.0', 'start app@1.0.0']);
    expect(states()).toMatchObject({ lib: 'running', app: 'running' });
  });

  it('brings the old version back when the new one does not start', async () => {
    const { manager, swapTo, calls, failing, states, lines } = await setup();
    failing.add('lib@2.0.0');
    const swap = swapTo('lib', withExtension('lib', '2.0.0'));

    const result = await manager.replace('lib', swap);

    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toBe('Extension failed to start: boom');
    expect(result.rollbackError).toBeUndefined();
    expect(result.record).toMatchObject({ state: 'running', errors: [] });
    expect(result.record.manifest?.version).toBe('1.0.0');
    expect(swap.log).toEqual(['apply while updating', 'revert while updating']);
    expect(calls).toEqual([
      'stop app',
      'stop lib',
      'start lib@2.0.0',
      'start lib@1.0.0',
      'start app@1.0.0',
    ]);
    expect(states()).toMatchObject({ lib: 'running', app: 'running' });
    expect(lines.join('\n')).toContain('Extension failed to start: boom');
  });

  it('brings the old version back when the new one has no usable manifest', async () => {
    const { manager, swapTo } = await setup();
    const result = await manager.replace('solo', swapTo('solo', { manifest: 1, name: 'solo' }));
    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toMatch(/kind|version/);
    expect(result.record).toMatchObject({ state: 'running' });
  });

  it('brings the old version back when the files cannot be swapped', async () => {
    const { manager, swapTo, calls } = await setup();
    const swap = swapTo('lib', withExtension('lib', '2.0.0'));
    const result = await manager.replace('lib', {
      ...swap,
      apply: async () => {
        throw new Error('EBUSY: the folder is locked');
      },
    });
    expect(result.outcome).toBe('rolled-back');
    expect(result.error).toBe('EBUSY: the folder is locked');
    expect(swap.log).toEqual(['revert while updating']);
    expect(calls).toEqual(['stop app', 'stop lib', 'start lib@1.0.0', 'start app@1.0.0']);
  });

  it('reports both errors when the old version cannot be brought back either', async () => {
    const { manager, swapTo, failing, states } = await setup();
    failing.add('lib@2.0.0');
    const swap = swapTo('lib', withExtension('lib', '2.0.0'));
    const result = await manager.replace('lib', {
      ...swap,
      revert: async () => {
        throw new Error('the backup is gone');
      },
    });
    expect(result.outcome).toBe('broken');
    expect(result.error).toBe('Extension failed to start: boom');
    expect(result.rollbackError).toBe('the backup is gone');
    expect(result.record.state).toBe('failed');
    expect(result.record.errors.join(' ')).toContain('the backup is gone');
    // What depended on it cannot run, and says why.
    expect(states().app).toBe('failed');
  });

  it('reports both errors when the old version does not start any more', async () => {
    const { manager, swapTo, failing } = await setup();
    failing.add('lib@2.0.0');
    failing.add('lib@1.0.0');
    const result = await manager.replace('lib', swapTo('lib', withExtension('lib', '2.0.0')));
    expect(result.outcome).toBe('broken');
    expect(result.error).toBe('Extension failed to start: boom');
    expect(result.rollbackError).toBe('Extension failed to start: boom');
    expect(result.record).toMatchObject({ state: 'failed' });
    expect(result.record.manifest?.version).toBe('1.0.0');
  });

  it('swaps a disabled bundle without starting it', async () => {
    const { manager, swapTo, calls, storage } = await setup({}, ['lib']);
    const result = await manager.replace('lib', swapTo('lib', withExtension('lib', '2.0.0')));
    expect(result.outcome).toBe('replaced');
    expect(result.record).toMatchObject({ state: 'disabled' });
    expect(result.record.manifest?.version).toBe('2.0.0');
    expect(calls).toEqual([]);
    expect(await storage.bundles.disabled()).toEqual(['lib']);
  });

  it('replaces a bundle that had failed', async () => {
    const { manager, swapTo, write } = await setup();
    await write('solo/mooncg.json', '{ broken');
    await manager.reload('solo');
    expect(manager.get('solo')?.state).toBe('failed');
    const result = await manager.replace(
      'solo',
      swapTo('solo', manifest('solo', { version: '1.0.1' })),
    );
    expect(result.outcome).toBe('replaced');
    expect(result.record).toMatchObject({ state: 'running' });
  });

  it('refuses a bundle that is not there', async () => {
    const { manager, swapTo } = await setup();
    await expect(manager.replace('nope', swapTo('nope', {}))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('does not interleave with a reload of the same bundle', async () => {
    const { manager, swapTo, calls } = await setup();
    const both = Promise.all([
      manager.replace('solo', swapTo('solo', withExtension('solo', '2.0.0'))),
      manager.reload('solo'),
      manager.disable('solo'),
    ]);
    await both;
    // Each change ran to its end before the next began.
    expect(calls).toEqual([
      'stop solo',
      'start solo@2.0.0',
      'stop solo',
      'start solo@2.0.0',
      'stop solo',
    ]);
    expect(manager.get('solo')?.state).toBe('disabled');
  });

  it('asks the on-air lock before it touches anything', async () => {
    const asked: string[] = [];
    const { manager, swapTo, calls, states } = await setup({
      onAirLock: (bundle, operation) => {
        asked.push(`${operation} ${bundle}`);
        return bundle === 'lib' ? 'Bundle "lib" is on air' : undefined;
      },
    });
    const swap = swapTo('lib', withExtension('lib', '2.0.0'));
    await expect(manager.replace('lib', swap)).rejects.toMatchObject({
      code: 'conflict',
      message: 'Bundle "lib" is on air',
    });
    await expect(manager.remove('lib', { force: true }, async () => {})).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(asked).toEqual(['update lib', 'remove lib']);
    expect(swap.log).toEqual([]);
    expect(calls).toEqual([]);
    expect(states().lib).toBe('running');
    // Other bundles are not held.
    expect((await manager.replace('solo', swapTo('solo', manifest('solo')))).outcome).toBe(
      'replaced',
    );
  });
});

describe('BundleManager.remove', () => {
  it('stops the bundle, erases it while it is "removing" and forgets it', async () => {
    const { manager, dir, calls, states, published, registry } = await setup();
    const seen: (string | undefined)[] = [];

    await manager.remove('app', {}, async () => {
      seen.push(published('app'));
      await rm(join(dir, 'app'), { recursive: true });
    });

    expect(seen).toEqual(['removing']);
    expect(calls).toEqual(['stop app']);
    expect(states()).toEqual({ lib: 'running', solo: 'running' });
    expect(manager.get('app')).toBeUndefined();
    const listed = registry.get('system:bundles')?.replicant.value as Json[];
    expect(listed).toHaveLength(2);
  });

  it('refuses while an enabled bundle depends on it', async () => {
    const { manager, states, calls } = await setup();
    let erased = false;
    const removed = manager.remove('lib', {}, async () => {
      erased = true;
    });
    await expect(removed).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('app'),
    });
    expect(erased).toBe(false);
    expect(calls).toEqual([]);
    expect(states()).toMatchObject({ lib: 'running', app: 'running' });
  });

  it('removes it once the bundle that depends on it is disabled', async () => {
    const { manager, states } = await setup();
    await manager.disable('app');
    await manager.remove('lib', {}, async () => {});
    expect(states()).toEqual({ app: 'disabled', solo: 'running' });
  });

  it('removes it anyway when forced, and says so on what depended on it', async () => {
    const { manager, calls } = await setup();
    await manager.remove('lib', { force: true }, async () => {});
    expect(calls).toEqual(['stop app', 'stop lib']);
    expect(manager.get('lib')).toBeUndefined();
    expect(manager.get('app')).toMatchObject({
      state: 'failed',
      errors: ['Stopped because bundle "lib" was removed'],
    });
  });

  it('keeps a bundle whose files could not be taken away, as failed', async () => {
    const { manager, states } = await setup();
    const removed = manager.remove('solo', {}, async () => {
      throw new Error('EPERM: the folder is locked');
    });
    await expect(removed).rejects.toThrow('EPERM: the folder is locked');
    expect(states().solo).toBe('failed');
    expect(manager.get('solo')?.errors).toEqual([
      'Could not be removed: EPERM: the folder is locked',
    ]);
    // It can be started again from what is still there.
    expect(await manager.enable('solo')).toMatchObject({ state: 'running' });
  });

  it('removes a disabled bundle and forgets that it was disabled', async () => {
    const { manager, storage, calls } = await setup({}, ['solo']);
    await manager.remove('solo', {}, async () => {});
    expect(calls).toEqual([]);
    expect(await storage.bundles.disabled()).toEqual([]);
  });

  it('refuses a bundle that is not there', async () => {
    const { manager } = await setup();
    await expect(manager.remove('nope', {}, async () => {})).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
