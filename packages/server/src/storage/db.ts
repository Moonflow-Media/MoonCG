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
 * How long a statement waits for a database file another connection has locked, such as a
 * backup tool reading it, before it fails.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** The module is loaded once per process, so its warning is dealt with exactly once. */
let sqlite: Promise<typeof import('node:sqlite')> | undefined;

/**
 * Opens a SQLite database with Node's built-in `node:sqlite`. `file` is a path or `:memory:`.
 */
export async function openSqliteDb(file: string): Promise<Db> {
  sqlite ??= importSqlite();
  const { DatabaseSync } = await sqlite;
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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

/**
 * `node:sqlite` works without a flag on Node 22 but announces itself with an
 * `ExperimentalWarning` when it is first loaded. Only that one warning is held back, and only
 * while the module loads; every other warning passes through.
 */
async function importSqlite(): Promise<typeof import('node:sqlite')> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.startsWith('SQLite is an experimental feature')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
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
  const current = db.all<{ user_version: number }>('PRAGMA user_version')[0]?.user_version ?? 0;
  if (current > migrations.length) {
    throw new Error(
      `The database is at version ${current}, which is newer than this server (${migrations.length})`,
    );
  }
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${version + 1} failed: ${errorMessage(error)}`);
    }
  }
  return migrations.length;
}
