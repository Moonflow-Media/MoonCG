import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, openSqliteDb } from '../src/storage/db.js';
import {
  DATABASE_FILE,
  openSqliteStore,
  SqliteReplicantStore,
} from '../src/storage/replicant-store.js';
import { fixture } from './helpers.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('SQLite experimental warning', () => {
  it('is held back in a fresh process, also for overlapping opens, and nothing else is', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fixture('sqlite-warning-probe.mjs'),
    ]);
    const result = JSON.parse(stdout.trim().split('\n').at(-1) as string) as {
      warnings: string[];
      restored: boolean;
    };

    expect(result.warnings.filter((message) => /sqlite/i.test(message))).toEqual([]);
    expect(result.warnings).toContain('still delivered');
    expect(result.restored).toBe(true);
  });
});

describe('opening the database', () => {
  it('waits for a briefly locked file instead of failing at once', async () => {
    const db = await openSqliteDb(':memory:');
    cleanup.push(() => db.close());
    expect(db.all('PRAGMA busy_timeout')).toEqual([{ timeout: 5000 }]);
  });

  it('closes the database when it cannot be migrated', async () => {
    const real = await openSqliteDb(':memory:');
    real.exec('PRAGMA user_version = 99');
    let closed = 0;
    const db: Db = {
      ...real,
      close() {
        closed++;
        real.close();
      },
    };

    expect(() => SqliteReplicantStore.create(db)).toThrow(/newer/);
    expect(closed).toBe(1);
  });

  it('leaves no lock on the file of a database it refused', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mooncg-data-'));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const newer = await openSqliteDb(join(dataDir, DATABASE_FILE));
    newer.exec('PRAGMA user_version = 99');
    newer.close();

    await expect(openSqliteStore(dataDir)).rejects.toThrow(
      /version 99, which is newer than this server/,
    );

    // On Windows an open handle would make this fail with EBUSY.
    await rm(dataDir, { recursive: true });
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
