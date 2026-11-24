import { type Auth, createAuth } from './auth/auth.js';
import type { ScryptParams } from './auth/password.js';
import { openSqliteStorage } from './storage/replicant-store.js';

export type { Auth, PrincipalInfo, UserInfo } from './auth/auth.js';
export type { ScryptParams } from './auth/password.js';
export type { RoleRecord, TokenRecord } from './storage/auth-store.js';

export interface Accounts {
  readonly auth: Auth;
  close(): Promise<void>;
}

/**
 * Opens the accounts of a data directory without starting a server: what the `mooncg` command
 * line tool works with. The database is created and brought up to date if needed.
 *
 * A server may have the same directory open. SQLite serializes the writers: a statement
 * waits up to five seconds for the other process, and a change of several steps holds the
 * write lock from its first step. The server reads accounts and roles for every request, so
 * it acts on a change at its next request, and on open sockets within a few seconds.
 */
export async function openAccounts(
  dataDir: string,
  options: { readonly passwordCost?: ScryptParams } = {},
): Promise<Accounts> {
  const storage = await openSqliteStorage(dataDir);
  const auth = createAuth({
    store: storage.auth,
    ...(options.passwordCost === undefined ? {} : { scrypt: options.passwordCost }),
  });
  return { auth, close: () => storage.close() };
}
