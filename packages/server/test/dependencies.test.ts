import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dependentsOf, planStart } from '../src/bundles/dependencies.js';
import { openSqliteDb } from '../src/storage/db.js';
import {
  DATABASE_FILE,
  memoryStorage,
  openSqliteStorage,
  type Storage,
} from '../src/storage/replicant-store.js';

const bundle = (name: string, dependencies: Record<string, string> = {}, version = '1.0.0') => ({
  name,
  version,
  dependencies,
});

describe('planStart', () => {
  it('starts bundles without dependencies in name order', () => {
    expect(planStart([bundle('b'), bundle('c'), bundle('a')])).toEqual({
      order: ['a', 'b', 'c'],
      problems: new Map(),
    });
  });

  it('starts a dependency before what depends on it, whatever the names', () => {
    const plan = planStart([
      bundle('alpha', { zeta: '^1.0.0' }),
      bundle('middle', { alpha: '*' }),
      bundle('zeta'),
    ]);
    expect(plan.order).toEqual(['zeta', 'alpha', 'middle']);
    expect(plan.problems.size).toBe(0);
  });

  it('reports a dependency that is not installed', () => {
    const plan = planStart([bundle('a', { ghost: '^1.0.0' }), bundle('b')]);
    expect(plan.order).toEqual(['b']);
    expect(plan.problems).toEqual(
      new Map([['a', 'dependencies.ghost: bundle "ghost" is not installed']]),
    );
  });

  it('reports a version that does not satisfy the range', () => {
    const plan = planStart([bundle('a', { b: '^2.0.0' }), bundle('b', {}, '1.4.0')]);
    expect(plan.order).toEqual(['b']);
    expect(plan.problems.get('a')).toBe(
      'dependencies.b: needs version ^2.0.0, but 1.4.0 is installed',
    );
  });

  it('accepts ranges the usual way and rejects text that is not a range', () => {
    const versions = bundle('b', {}, '1.4.0');
    const satisfied = ['^1.0.0', '~1.4.0', '>=1.2.0 <2', '1.4.0', '*', '1.x'];
    for (const range of satisfied) {
      expect(planStart([bundle('a', { b: range }), versions]).problems.size).toBe(0);
    }
    expect(planStart([bundle('a', { b: 'latest' }), versions]).problems.get('a')).toBe(
      'dependencies.b: "latest" is not a version range',
    );
  });

  it('reports every bundle of a dependency cycle', () => {
    const plan = planStart([
      bundle('a', { b: '*' }),
      bundle('b', { c: '*' }),
      bundle('c', { a: '*' }),
      bundle('free'),
    ]);
    expect(plan.order).toEqual(['free']);
    expect([...plan.problems.keys()]).toEqual(['a', 'b', 'c']);
    expect(plan.problems.get('a')).toMatch(/cycle.*a → b → c → a/);
  });

  it('does not start what depends on a bundle that cannot start', () => {
    const plan = planStart([
      bundle('app', { lib: '*' }),
      bundle('lib', { ghost: '*' }),
      bundle('top', { app: '*' }),
    ]);
    expect(plan.order).toEqual([]);
    expect(plan.problems.get('app')).toBe('dependencies.lib: bundle "lib" cannot start');
    expect(plan.problems.get('top')).toBe('dependencies.app: bundle "app" cannot start');
  });
});

describe('dependentsOf', () => {
  it('lists everything that depends on a bundle, directly or not, nearest first', () => {
    const bundles = [
      bundle('lib'),
      bundle('app', { lib: '*' }),
      bundle('top', { app: '*' }),
      bundle('other', { lib: '*' }),
      bundle('free'),
    ];
    expect(dependentsOf('lib', bundles)).toEqual(['app', 'other', 'top']);
    expect(dependentsOf('app', bundles)).toEqual(['top']);
    expect(dependentsOf('free', bundles)).toEqual([]);
  });
});

describe('bundle settings', () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function temporaryDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-data-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it.each([
    ['memory', async (): Promise<Storage> => memoryStorage()],
    [
      'SQLite',
      async (): Promise<Storage> => {
        const storage = await openSqliteStorage(await temporaryDir());
        cleanup.push(() => storage.close());
        return storage;
      },
    ],
  ])('remembers which bundles are disabled (%s)', async (_name, create) => {
    const { bundles } = await create();
    expect(await bundles.disabled()).toEqual([]);

    await bundles.setDisabled('scoreboard', true);
    await bundles.setDisabled('timer', true);
    await bundles.setDisabled('timer', true);
    await bundles.setDisabled('scoreboard', false);
    await bundles.setDisabled('never-disabled', false);

    expect(await bundles.disabled()).toEqual(['timer']);
  });

  it('keeps disabled bundles and replicants across reopening', async () => {
    const dataDir = await temporaryDir();
    const first = await openSqliteStorage(dataDir);
    await first.bundles.setDisabled('timer', true);
    await first.replicants.save([{ bundle: 'b', name: 'n', rev: 2, value: 1 }]);
    await first.close();

    const second = await openSqliteStorage(dataDir);
    cleanup.push(() => second.close());

    expect(await second.bundles.disabled()).toEqual(['timer']);
    expect(await second.replicants.load('b', 'n')).toMatchObject({ rev: 2, value: 1 });
  });

  it('upgrades a database from before bundles could be disabled, keeping its replicants', async () => {
    const dataDir = await temporaryDir();
    const old = await openSqliteDb(join(dataDir, DATABASE_FILE));
    old.exec(
      'CREATE TABLE replicants (bundle TEXT NOT NULL, name TEXT NOT NULL, rev INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (bundle, name))',
    );
    old.run('INSERT INTO replicants VALUES (?, ?, ?, ?)', 'b', 'n', 7, '{"home":1}');
    old.exec('PRAGMA user_version = 1');
    old.close();

    const storage = await openSqliteStorage(dataDir);
    cleanup.push(() => storage.close());

    expect(await storage.replicants.load('b', 'n')).toMatchObject({ rev: 7, value: { home: 1 } });
    expect(await storage.bundles.disabled()).toEqual([]);
  });
});
