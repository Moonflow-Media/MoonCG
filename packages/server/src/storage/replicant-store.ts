import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '@mooncg/core';
import { AUTH_MIGRATION, type AuthStore, PREFS_MIGRATION, sqlAuthStore } from './auth-store.js';
import { type Db, migrate, openSqliteDb, openSqliteDbSync } from './db.js';

export const DATABASE_FILE = 'mooncg.db';

/** The schema of `mooncg.db`, one entry per version. See `migrate`. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE replicants (
     bundle TEXT NOT NULL,
     name TEXT NOT NULL,
     rev INTEGER NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (bundle, name)
   )`,
  // Bundles are enabled unless listed here.
  'CREATE TABLE disabled_bundles (name TEXT NOT NULL PRIMARY KEY)',
  AUTH_MIGRATION,
  PREFS_MIGRATION,
];

export interface StoredReplicant {
  readonly bundle: string;
  readonly name: string;
  readonly rev: number;
  readonly value: Json;
}

/**
 * Where persistent replicants are kept: one record per replicant. This is the seam for other
 * storage backends, which is why it is asynchronous although SQLite is not.
 */
export interface ReplicantStore {
  /** Rejects if the record exists but cannot be read. */
  load(bundle: string, name: string): Promise<StoredReplicant | undefined>;
  /** Writes all records or none. A record replaces the earlier one of the same replicant. */
  save(records: readonly StoredReplicant[]): Promise<void>;
  close(): Promise<void>;
}

/** Keeps records in memory. For tests and for running without a data directory. */
export class MemoryReplicantStore implements ReplicantStore {
  readonly #records = new Map<string, { rev: number; json: string }>();

  async load(bundle: string, name: string): Promise<StoredReplicant | undefined> {
    const record = this.#records.get(`${bundle}\n${name}`);
    return record && { bundle, name, rev: record.rev, value: JSON.parse(record.json) };
  }

  async save(records: readonly StoredReplicant[]): Promise<void> {
    for (const { bundle, name, rev, value } of records) {
      this.#records.set(`${bundle}\n${name}`, { rev, json: JSON.stringify(value) });
    }
  }

  async close(): Promise<void> {}
}

export class SqliteReplicantStore implements ReplicantStore {
  readonly #db: Db;

  private constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Migrates the database if needed. The store owns the database from here on: closing the
   * store closes it, and so does a failed migration, so its file is not left locked.
   */
  static create(db: Db): SqliteReplicantStore {
    try {
      migrate(db, MIGRATIONS);
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteReplicantStore(db);
  }

  async load(bundle: string, name: string): Promise<StoredReplicant | undefined> {
    const row = this.#db.all<{ rev: number; json: string }>(
      'SELECT rev, json FROM replicants WHERE bundle = ? AND name = ?',
      bundle,
      name,
    )[0];
    return row && { bundle, name, rev: row.rev, value: JSON.parse(row.json) };
  }

  async save(records: readonly StoredReplicant[]): Promise<void> {
    this.#db.exec('BEGIN');
    try {
      for (const { bundle, name, rev, value } of records) {
        this.#db.run(
          `INSERT INTO replicants (bundle, name, rev, json) VALUES (?, ?, ?, ?)
           ON CONFLICT (bundle, name) DO UPDATE SET rev = excluded.rev, json = excluded.json`,
          bundle,
          name,
          rev,
          JSON.stringify(value),
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

/** Which bundles an administrator has disabled. That choice survives a restart. */
export interface BundleSettingsStore {
  /** The names of the disabled bundles, sorted. */
  disabled(): Promise<string[]>;
  setDisabled(bundle: string, disabled: boolean): Promise<void>;
}

/** Everything the server keeps across restarts. */
export interface Storage {
  readonly replicants: ReplicantStore;
  readonly bundles: BundleSettingsStore;
  /** Users, roles, tokens and sessions. */
  readonly auth: AuthStore;
  close(): Promise<void>;
}

/**
 * Keeps everything in memory. For tests. Accounts and permissions live in an in-memory SQLite
 * database with the real schema, so the tests run the same statements as production.
 */
export function memoryStorage(): Storage {
  const disabled = new Set<string>();
  const db = openSqliteDbSync(':memory:');
  migrate(db, MIGRATIONS);
  return {
    replicants: new MemoryReplicantStore(),
    auth: sqlAuthStore(db),
    bundles: {
      disabled: async () => [...disabled].sort(),
      async setDisabled(bundle, value) {
        if (value) disabled.add(bundle);
        else disabled.delete(bundle);
      },
    },
    close: async () => db.close(),
  };
}

/** Opens `<dataDir>/mooncg.db`, creating the directory and the database on first use. */
export async function openSqliteStorage(dataDir: string): Promise<Storage> {
  await mkdir(dataDir, { recursive: true });
  const db = await openSqliteDb(join(dataDir, DATABASE_FILE));
  const replicants = SqliteReplicantStore.create(db);
  return {
    replicants,
    auth: sqlAuthStore(db),
    bundles: {
      disabled: async () =>
        db
          .all<{ name: string }>('SELECT name FROM disabled_bundles ORDER BY name')
          .map((row) => row.name),
      async setDisabled(bundle, value) {
        if (value) db.run('INSERT OR IGNORE INTO disabled_bundles (name) VALUES (?)', bundle);
        else db.run('DELETE FROM disabled_bundles WHERE name = ?', bundle);
      },
    },
    close: () => replicants.close(),
  };
}

/** Opens only the replicant store of `<dataDir>/mooncg.db`. */
export async function openSqliteStore(dataDir: string): Promise<ReplicantStore> {
  await mkdir(dataDir, { recursive: true });
  return SqliteReplicantStore.create(await openSqliteDb(join(dataDir, DATABASE_FILE)));
}
