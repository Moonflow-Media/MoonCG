import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Json, type Manifest, parseManifest, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { OnAirLock } from '../src/dev/on-air.js';
import { ConnectedPages } from '../src/dev/pages.js';
import { GraphicInstances } from '../src/graphics/instances.js';
import { memoryStorage, openSqliteStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest } from './temp-bundles.js';

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

const parsed = (input: object): Manifest => {
  const result = parseManifest(input);
  if (!result.ok) throw new Error('The test manifest is invalid');
  return result.manifest;
};

describe('graphic instances that are out of date', () => {
  function setup() {
    const registry = new ReplicantRegistry();
    const instances = new GraphicInstances(registry);
    const declare = () =>
      instances.declare(
        'board',
        parsed(
          manifest('board', {
            graphics: [
              { id: 'overlay', file: 'graphics/overlay.html', width: 1, height: 1 },
              { id: 'lower', file: 'graphics/lower.html', width: 1, height: 1 },
            ],
          }),
        ),
      );
    declare();
    const enter = (file = 'graphics/overlay.html') =>
      instances.enter('board', file, {
        principal: { id: 'user:1', roles: [] },
        reload: () => {},
        end: () => {},
      });
    const list = (graphic = 'overlay') =>
      registry.get(`board:$instances.${graphic}`)?.replicant.value as {
        id: string;
        outOfDate?: boolean;
      }[];
    return { instances, registry, declare, enter, list };
  }

  it('lists a fresh instance without the mark', () => {
    const { enter, list } = setup();
    enter();
    expect(list()[0]).not.toHaveProperty('outOfDate');
  });

  it('marks every connected page of the bundle and says how many', () => {
    const { instances, enter, list } = setup();
    enter();
    enter('graphics/lower.html');

    expect(instances.markOutOfDate('board')).toBe(2);

    expect(list()).toMatchObject([{ outOfDate: true }]);
    expect(list('lower')).toMatchObject([{ outOfDate: true }]);
  });

  it('marks nothing of another bundle and nothing twice', () => {
    const { instances, enter } = setup();
    enter();
    expect(instances.markOutOfDate('other')).toBe(0);
    expect(instances.markOutOfDate('board')).toBe(1);
    expect(instances.markOutOfDate('board')).toBe(0);
  });

  it('lists the page that connects after a reload as up to date', () => {
    const { instances, enter, list } = setup();
    const leave = enter();
    instances.markOutOfDate('board');

    leave?.();
    enter();

    expect(list()).toHaveLength(1);
    expect(list()[0]).not.toHaveProperty('outOfDate');
  });

  it('keeps the mark through a restart of the bundle', () => {
    const { instances, registry, declare, enter, list } = setup();
    enter();
    instances.markOutOfDate('board');

    // The page stays connected while the bundle goes and comes back.
    instances.retract('board');
    registry.undeclare('board');
    declare();

    expect(list()).toMatchObject([{ outOfDate: true }]);
  });
});

describe('ConnectedPages', () => {
  function setup() {
    const pages = new ConnectedPages();
    const reloaded: string[] = [];
    const join = (bundle: string, name: string, graphic: boolean) =>
      pages.join(bundle, {
        graphic,
        reload: () => void reloaded.push(name),
        restyle: (styles) =>
          void reloaded.push(`${name} ${styles.map((style) => style.file).join(' ')}`),
      });
    return { pages, reloaded, join };
  }

  it('tells the panels of one bundle which stylesheets changed', () => {
    const { pages, reloaded, join } = setup();
    join('board', 'panel', false);
    join('board', 'overlay', true);
    join('other', 'other panel', false);
    const style = (file: string) => ({ file, permission: 'bundle:board:?' });
    expect(pages.restyle('board', 'panels', [style('dashboard/a.css')])).toBe(1);
    expect(pages.restyle('board', 'graphics', [style('graphics/b.css')])).toBe(1);
    expect(reloaded).toEqual(['panel dashboard/a.css', 'overlay graphics/b.css']);
  });

  it('reloads the panels of one bundle and nothing else', () => {
    const { pages, reloaded, join } = setup();
    join('board', 'panel', false);
    join('board', 'graphic', true);
    join('other', 'other-panel', false);

    expect(pages.reload('board', 'panels')).toBe(1);

    expect(reloaded).toEqual(['panel']);
  });

  it('reloads the graphics of one bundle and nothing else', () => {
    const { pages, reloaded, join } = setup();
    join('board', 'panel', false);
    join('board', 'graphic', true);
    join('board', 'graphic-2', true);

    expect(pages.reload('board', 'graphics')).toBe(2);

    expect(reloaded).toEqual(['graphic', 'graphic-2']);
  });

  it('forgets a page that left, and holds nothing once all have', () => {
    const { pages, reloaded, join } = setup();
    const leave = join('board', 'panel', false);
    leave();
    leave();

    expect(pages.reload('board', 'panels')).toBe(0);
    expect(reloaded).toEqual([]);
    expect(pages.count()).toBe(0);
  });

  it('goes on when one page cannot be told', () => {
    const { pages, reloaded, join } = setup();
    pages.join('board', {
      graphic: false,
      reload: () => {
        throw new Error('socket is gone');
      },
      restyle: () => {
        throw new Error('socket is gone');
      },
    });
    join('board', 'panel', false);

    expect(pages.reload('board', 'panels')).toBe(1);
    expect(reloaded).toEqual(['panel']);
  });
});

describe('OnAirLock', () => {
  function setup(storage = memoryStorage()) {
    const registry = new ReplicantRegistry();
    const { logger, lines } = memoryLogger();
    let time = Date.parse('2026-11-25T10:00:00.000Z');
    const lock = new OnAirLock({
      registry,
      store: storage.settings,
      logger,
      now: () => time++,
    });
    const published = () => registry.get('system:onAir')?.replicant.value;
    return { lock, registry, lines, storage, published };
  }

  it('is off at first and publishes that to whoever sees the dashboard', async () => {
    const { lock, registry, published } = setup();
    await lock.load();

    expect(lock.state).toEqual({ onAir: false });
    expect(published()).toEqual({ onAir: false });
    expect(registry.get('system:onAir')).toMatchObject({
      readPermission: 'system:dashboard.view',
      readOnly: true,
    });
    expect(lock.reason('board', 'reload')).toBeUndefined();
  });

  it('refuses every change with a reason once it is on', async () => {
    const { lock, published, lines } = setup();
    await lock.load();

    const state = await lock.set(true, 'ada');

    expect(state).toEqual({ onAir: true, since: '2026-11-25T10:00:00.000Z', by: 'ada' });
    expect(published()).toEqual({ onAir: true, since: '2026-11-25T10:00:00.000Z' });
    const reason = lock.reason('board', 'reload');
    expect(reason).toContain('on air');
    expect(reason).toContain('board');
    expect(lock.reason('board', 'update')).toContain('updat');
    expect(lines.some((line) => line.includes('ada') && line.includes('On Air'))).toBe(true);
  });

  it('lets everything through again once it is off, and tells those who wait', async () => {
    const { lock, published } = setup();
    await lock.load();
    await lock.set(true, 'ada');
    const released: number[] = [];
    const stop = lock.onRelease(() => void released.push(1));

    await lock.set(false, 'ada');
    await lock.set(false, 'ada');

    expect(lock.reason('board', 'reload')).toBeUndefined();
    expect(published()).toEqual({ onAir: false });
    expect(released).toEqual([1]);
    stop();
    await lock.set(true, 'ada');
    await lock.set(false, 'ada');
    expect(released).toEqual([1]);
  });

  it('keeps the time it went on air when it is switched on twice', async () => {
    const { lock } = setup();
    await lock.load();
    const first = await lock.set(true, 'ada');
    expect(await lock.set(true, 'olga')).toEqual(first);
  });

  it('is still on after a restart of the server', async () => {
    const storage = memoryStorage();
    const first = setup(storage);
    await first.lock.load();
    await first.lock.set(true, 'ada');

    const second = setup(storage);
    await second.lock.load();

    expect(second.lock.state).toMatchObject({ onAir: true, by: 'ada' });
    expect(second.lock.reason('board', 'disable')).toBeDefined();
  });

  it('is on air when what was stored cannot be understood, and says how to switch it off', async () => {
    const storage = memoryStorage();
    await storage.settings.set('onAir', 'yes please');
    const { lock, lines, published } = setup(storage);

    await lock.load();

    expect(lock.state).toEqual({ onAir: true });
    expect(published()).toEqual({ onAir: true });
    expect(lock.reason('board', 'reload')).toContain('on air');
    const said = lines.find((line) => line.includes('On Air state'));
    expect(said).toContain('ERROR');
    expect(said).toMatch(/switch.*off/i);
  });

  it('is on air when the store cannot be read, and the switch still works', async () => {
    const storage = memoryStorage();
    let broken = true;
    const settings = {
      get: async (key: string) => {
        if (broken) throw new Error('database disk image is malformed');
        return storage.settings.get(key);
      },
      set: (key: string, value: Json) => storage.settings.set(key, value),
    };
    const { lock, lines } = setup({ ...storage, settings });

    await lock.load();

    expect(lock.state).toEqual({ onAir: true });
    const said = lines.find((line) => line.includes('malformed'));
    expect(said).toContain('ERROR');
    expect(said).toMatch(/switch.*off/i);

    // Switching it off writes a fresh value, which the next start reads.
    expect(await lock.set(false, 'ada')).toEqual({ onAir: false });
    expect(lock.reason('board', 'reload')).toBeUndefined();
    broken = false;
    const next = setup({ ...storage, settings });
    await next.lock.load();
    expect(next.lock.state).toEqual({ onAir: false });
  });

  it('is off when nothing was ever stored', async () => {
    const { lock, lines } = setup();
    await lock.load();
    expect(lock.state).toEqual({ onAir: false });
    expect(lines.filter((line) => line.includes('ERROR'))).toEqual([]);
  });

  it('works without a store, and forgets', async () => {
    const registry = new ReplicantRegistry();
    const lock = new OnAirLock({ registry, logger: memoryLogger().logger });
    await lock.load();
    await lock.set(true, 'ada');
    expect(lock.state.onAir).toBe(true);
  });
});

describe('the settings store', () => {
  it('keeps values in memory', async () => {
    const { settings } = memoryStorage();
    expect(await settings.get('onAir')).toBeUndefined();
    await settings.set('onAir', { onAir: true });
    await settings.set('onAir', { onAir: false });
    expect(await settings.get('onAir')).toEqual({ onAir: false });
  });

  it('keeps values in the database across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-settings-'));
    created.push(dir);
    const first = await openSqliteStorage(dir);
    await first.settings.set('onAir', { onAir: true, since: 'then' });
    await first.settings.set('other', [1, 2]);
    await first.close();

    const second = await openSqliteStorage(dir);
    expect(await second.settings.get('onAir')).toEqual({ onAir: true, since: 'then' });
    expect(await second.settings.get('other')).toEqual([1, 2]);
    expect(await second.settings.get('missing')).toBeUndefined();
    await second.close();
  });
});
