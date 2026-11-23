import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, migrate, openSqliteDb } from '../src/storage/db.js';
import {
  MemoryReplicantStore,
  openSqliteStore,
  type ReplicantStore,
  SqliteReplicantStore,
} from '../src/storage/replicant-store.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function memoryDb(): Promise<Db> {
  const db = await openSqliteDb(':memory:');
  cleanup.push(() => db.close());
  return db;
}

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-data-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const version = (db: Db) =>
  db.all<{ user_version: number }>('PRAGMA user_version')[0]?.user_version;

describe('openSqliteDb', () => {
  it('runs statements with parameters and returns rows', async () => {
    const db = await memoryDb();
    db.exec('CREATE TABLE t (id INTEGER, label TEXT)');
    db.run('INSERT INTO t VALUES (?, ?)', 1, 'one');
    db.run('INSERT INTO t VALUES (?, ?)', 2, 'two');

    expect(db.all('SELECT id, label FROM t WHERE id > ? ORDER BY id', 0)).toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
  });
});

describe('migrate', () => {
  const migrations = ['CREATE TABLE a (x)', 'CREATE TABLE b (y); INSERT INTO b VALUES (1)'];

  it('applies every migration in order and records the version', async () => {
    const db = await memoryDb();
    expect(migrate(db, migrations)).toBe(2);
    expect(version(db)).toBe(2);
    expect(db.all('SELECT y FROM b')).toEqual([{ y: 1 }]);
  });

  it('applies only the migrations a database has not seen yet', async () => {
    const db = await memoryDb();
    migrate(db, migrations.slice(0, 1));
    db.run('INSERT INTO a VALUES (?)', 7);

    migrate(db, migrations);
    migrate(db, migrations);

    expect(version(db)).toBe(2);
    expect(db.all('SELECT x FROM a')).toEqual([{ x: 7 }]);
    expect(db.all('SELECT y FROM b')).toEqual([{ y: 1 }]);
  });

  it('rolls a failing migration back and keeps the version before it', async () => {
    const db = await memoryDb();
    const broken = ['CREATE TABLE a (x)', 'CREATE TABLE b (y); INSERT INTO missing VALUES (1)'];

    expect(() => migrate(db, broken)).toThrow(/migration 2/i);

    expect(version(db)).toBe(1);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'b'")).toEqual([]);
  });

  it('refuses a database written by a newer version', async () => {
    const db = await memoryDb();
    migrate(db, migrations);
    expect(() => migrate(db, migrations.slice(0, 1))).toThrow(/newer/);
  });
});

describe.each([
  ['MemoryReplicantStore', async (): Promise<ReplicantStore> => new MemoryReplicantStore()],
  [
    'SqliteReplicantStore',
    async (): Promise<ReplicantStore> => {
      const db = await memoryDb();
      return SqliteReplicantStore.create(db);
    },
  ],
])('%s', (_name, create) => {
  it('finds nothing for a replicant that was never saved', async () => {
    const store = await create();
    expect(await store.load('scoreboard', 'score')).toBeUndefined();
  });

  it('returns what was saved, per bundle and name', async () => {
    const store = await create();
    await store.save([
      { bundle: 'scoreboard', name: 'score', rev: 3, value: { home: 1, away: [1, null] } },
      { bundle: 'other', name: 'score', rev: 1, value: 'text' },
    ]);

    expect(await store.load('scoreboard', 'score')).toEqual({
      bundle: 'scoreboard',
      name: 'score',
      rev: 3,
      value: { home: 1, away: [1, null] },
    });
    expect(await store.load('other', 'score')).toMatchObject({ rev: 1, value: 'text' });
    expect(await store.load('scoreboard', 'other')).toBeUndefined();
  });

  it('keeps one row per replicant: a later save replaces the earlier one', async () => {
    const store = await create();
    await store.save([{ bundle: 'b', name: 'n', rev: 1, value: 1 }]);
    await store.save([{ bundle: 'b', name: 'n', rev: 2, value: null }]);
    expect(await store.load('b', 'n')).toEqual({ bundle: 'b', name: 'n', rev: 2, value: null });
  });

  it('does not hand out the object it was given', async () => {
    const store = await create();
    const value = { home: 1 };
    await store.save([{ bundle: 'b', name: 'n', rev: 1, value }]);
    value.home = 99;
    expect((await store.load('b', 'n'))?.value).toEqual({ home: 1 });
  });
});

describe('openSqliteStore', () => {
  it('creates the data directory and keeps values across reopening', async () => {
    const dataDir = join(await temporaryDir(), 'nested', 'data');

    const first = await openSqliteStore(dataDir);
    await first.save([{ bundle: 'scoreboard', name: 'score', rev: 5, value: { home: 2 } }]);
    await first.close();
    const second = await openSqliteStore(dataDir);
    cleanup.push(() => second.close());

    expect((await stat(join(dataDir, 'mooncg.db'))).isFile()).toBe(true);
    expect(await second.load('scoreboard', 'score')).toMatchObject({ rev: 5, value: { home: 2 } });
  });

  it('fails to load a row whose JSON is damaged', async () => {
    const db = await memoryDb();
    const store = SqliteReplicantStore.create(db);
    db.run(
      'INSERT INTO replicants (bundle, name, rev, json) VALUES (?, ?, ?, ?)',
      'b',
      'n',
      1,
      '{',
    );
    await expect(store.load('b', 'n')).rejects.toThrow();
  });
});

describe('experimental warning', () => {
  it('does not let the SQLite experimental warning through, but keeps other warnings', async () => {
    const seen: string[] = [];
    const listener = (warning: Error) => seen.push(warning.message);
    process.on('warning', listener);
    cleanup.push(() => process.off('warning', listener));

    await memoryDb();
    process.emitWarning('still delivered');
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual(['still delivered']);
  });
});
