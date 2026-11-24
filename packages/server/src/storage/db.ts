import { errorMessage } from '../kernel/logger.js';

export type SqlValue = string | number | null;

/** The few database operations the server needs. Everything SQL-specific stays behind it. */
export interface Db {
  /** Runs one or more statements without parameters. */
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  all<Row = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Row[];
  close(): void;
}

/**
 * How long a statement waits for a database file another connection has locked, such as the
 * `mooncg` command line tool or a backup tool, before it fails.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** The module is loaded once per process, so its warning is dealt with exactly once. */
let sqlite: typeof import('node:sqlite') | undefined;

/**
 * Opens a SQLite database with Node's built-in `node:sqlite`. `file` is a path or `:memory:`.
 * Foreign keys are enforced, so what belongs to a deleted row goes with it.
 */
export function openSqliteDbSync(file: string): Db {
  sqlite ??= loadSqlite();
  const database = new sqlite.DatabaseSync(file);
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.exec('PRAGMA foreign_keys = ON');
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, ...params) => {
      database.prepare(sql).run(...params);
    },
    all: <Row>(sql: string, ...params: SqlValue[]) =>
      database
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row }) as Row),
    close: () => database.close(),
  };
}

export async function openSqliteDb(file: string): Promise<Db> {
  return openSqliteDbSync(file);
}

/**
 * `node:sqlite` works without a flag on Node 22 but announces itself with an
 * `ExperimentalWarning` when it is first loaded. Only that one warning is held back, and only
 * while the module loads; every other warning passes through.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.startsWith('SQLite is an experimental feature')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Brings a database up to date. `migrations[n]` moves it from version `n` to `n + 1`; the
 * version is kept in `PRAGMA user_version`. Each migration runs in its own transaction.
 * Never edit a migration that has shipped: add a new one.
 */
export function migrate(db: Db, migrations: readonly string[]): number {
  for (;;) {
    // The write lock is taken before the version is read, for every step: two processes
    // that open an old database at the same moment migrate it one after the other, and the
    // second finds nothing left to do.
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = db.all<{ user_version: number }>('PRAGMA user_version')[0]?.user_version ?? 0;
      if (version > migrations.length) {
        throw new Error(
          `The database is at version ${version}, which is newer than this server (${migrations.length})`,
        );
      }
      if (version < migrations.length) {
        try {
          db.exec(migrations[version] as string);
        } catch (error) {
          throw new Error(`Database migration ${version + 1} failed: ${errorMessage(error)}`);
        }
        db.exec(`PRAGMA user_version = ${version + 1}`);
      }
      db.exec('COMMIT');
      if (version >= migrations.length) return migrations.length;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
