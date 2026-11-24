import type { Policy } from '@mooncg/core';
import type { Db } from './db.js';

/**
 * The schema for accounts and permissions, added as one migration. The built-in roles are
 * created with it: `admin` holds everything, `operator` and `viewer` may open the dashboard,
 * `graphics` holds nothing of the system. What they may do with a bundle comes from the
 * bundle's `defaultRoles`.
 */
export const AUTH_MIGRATION = `
  CREATE TABLE users (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    secret TEXT,
    PRIMARY KEY (provider, subject)
  );
  CREATE TABLE roles (
    name TEXT NOT NULL PRIMARY KEY,
    builtin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE role_grants (
    role TEXT NOT NULL REFERENCES roles (name) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role, permission)
  );
  CREATE TABLE user_roles (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role TEXT NOT NULL REFERENCES roles (name) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role)
  );
  CREATE TABLE tokens (
    id TEXT NOT NULL PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    grants TEXT NOT NULL,
    expires INTEGER,
    last_used INTEGER,
    created_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    hash TEXT NOT NULL PRIMARY KEY,
    user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
    token_id TEXT REFERENCES tokens (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE bundle_defaults (bundle TEXT NOT NULL PRIMARY KEY);
  INSERT INTO roles (name, builtin) VALUES
    ('admin', 1), ('operator', 1), ('viewer', 1), ('graphics', 1);
  INSERT INTO role_grants (role, permission) VALUES
    ('admin', '*'),
    ('operator', 'system:dashboard.view'),
    ('viewer', 'system:dashboard.view');
`;

/** Times are milliseconds since the epoch. */
export interface UserRecord {
  readonly id: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly createdAt: number;
}

/** Ties a user to a way of signing in. For `local`, the subject is the user id and the secret the password hash. */
export interface IdentityRecord {
  readonly provider: string;
  readonly subject: string;
  readonly userId: string;
  readonly secret: string | null;
}

export interface RoleRecord {
  readonly name: string;
  readonly builtin: boolean;
  readonly grants: readonly string[];
}

export interface TokenRecord {
  readonly id: string;
  readonly name: string;
  readonly grants: readonly string[];
  readonly expires: number | null;
  readonly lastUsed: number | null;
  /** The id of the user who created it. */
  readonly createdBy: string;
  readonly createdAt: number;
}

/** A signed-in browser. Exactly one of `userId` and `tokenId` is set. */
export interface SessionRecord {
  /** The hash of the secret in the cookie. The secret itself is never stored. */
  readonly hash: string;
  readonly userId: string | null;
  readonly tokenId: string | null;
  readonly createdAt: number;
  readonly lastSeen: number;
}

export interface UserRepository {
  list(): UserRecord[];
  get(id: string): UserRecord | undefined;
  /** Names are compared without regard to case. */
  byName(name: string): UserRecord | undefined;
  count(): number;
  create(user: UserRecord): void;
  update(id: string, change: { readonly name?: string; readonly disabled?: boolean }): void;
  delete(id: string): void;
  roles(id: string): string[];
  addRole(id: string, role: string): void;
  removeRole(id: string, role: string): void;
  /** How many enabled users hold the `admin` role. */
  admins(): number;
}

export interface IdentityRepository {
  get(provider: string, subject: string): IdentityRecord | undefined;
  /** Creates the identity or replaces it. */
  put(identity: IdentityRecord): void;
}

export interface RoleRepository {
  list(): RoleRecord[];
  get(name: string): RoleRecord | undefined;
  create(name: string): void;
  delete(name: string): void;
  grant(name: string, permission: string): void;
  revoke(name: string, permission: string): void;
  /** Every role with its grants, as `authorize()` takes it. */
  policy(): Policy;
}

export interface TokenRepository {
  list(): TokenRecord[];
  get(id: string): TokenRecord | undefined;
  byHash(hash: string): TokenRecord | undefined;
  create(token: TokenRecord, hash: string): void;
  delete(id: string): void;
  /** Deletes every token the user created. */
  deleteForUser(userId: string): void;
  touch(id: string, lastUsed: number): void;
}

export interface SessionRepository {
  get(hash: string): SessionRecord | undefined;
  create(session: SessionRecord): void;
  touch(hash: string, lastSeen: number): void;
  delete(hash: string): void;
  deleteForUser(userId: string): void;
  /** Keeps the newest `keep` sessions of a token and removes its older ones. */
  trimForToken(tokenId: string, keep: number): void;
  /** Removes the sessions of users last seen, or created, before the given times. */
  deleteUserSessionsBefore(limits: { readonly lastSeen: number; readonly createdAt: number }): void;
}

export interface BundleDefaultsRepository {
  /** Whether the bundle's `defaultRoles` were turned into grants already. */
  applied(bundle: string): boolean;
  markApplied(bundle: string): void;
}

/** Everything about accounts and permissions the server keeps. All of it is synchronous. */
export interface AuthStore {
  readonly users: UserRepository;
  readonly identities: IdentityRepository;
  readonly roles: RoleRepository;
  readonly tokens: TokenRepository;
  readonly sessions: SessionRepository;
  readonly bundleDefaults: BundleDefaultsRepository;
  /** Runs `work` so that all of its changes are kept, or none if it throws. */
  transaction<T>(work: () => T): T;
}

interface UserRow {
  id: string;
  name: string;
  disabled: number;
  created_at: number;
}
interface TokenRow {
  id: string;
  name: string;
  grants: string;
  expires: number | null;
  last_used: number | null;
  created_by: string;
  created_at: number;
}
interface SessionRow {
  hash: string;
  user_id: string | null;
  token_id: string | null;
  created_at: number;
  last_seen: number;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  name: row.name,
  disabled: row.disabled !== 0,
  createdAt: row.created_at,
});
const toToken = (row: TokenRow): TokenRecord => ({
  id: row.id,
  name: row.name,
  grants: JSON.parse(row.grants) as string[],
  expires: row.expires,
  lastUsed: row.last_used,
  createdBy: row.created_by,
  createdAt: row.created_at,
});
const toSession = (row: SessionRow): SessionRecord => ({
  hash: row.hash,
  userId: row.user_id,
  tokenId: row.token_id,
  createdAt: row.created_at,
  lastSeen: row.last_seen,
});

/** The auth store on a migrated database. It does not own the database. */
export function sqlAuthStore(db: Db): AuthStore {
  let depth = 0;
  const grantsByRole = () => {
    const grants = new Map<string, string[]>();
    for (const { name } of db.all<{ name: string }>('SELECT name FROM roles')) grants.set(name, []);
    const rows = db.all<{ role: string; permission: string }>(
      'SELECT role, permission FROM role_grants ORDER BY permission',
    );
    for (const { role, permission } of rows) grants.get(role)?.push(permission);
    return grants;
  };
  const roleList = (): RoleRecord[] => {
    const grants = grantsByRole();
    return db
      .all<{ name: string; builtin: number }>('SELECT name, builtin FROM roles ORDER BY name')
      .map(({ name, builtin }) => ({
        name,
        builtin: builtin !== 0,
        grants: grants.get(name) ?? [],
      }));
  };

  return {
    users: {
      list: () => db.all<UserRow>('SELECT * FROM users ORDER BY name').map(toUser),
      get: (id) => db.all<UserRow>('SELECT * FROM users WHERE id = ?', id).map(toUser)[0],
      byName: (name) => db.all<UserRow>('SELECT * FROM users WHERE name = ?', name).map(toUser)[0],
      count: () => db.all<{ n: number }>('SELECT COUNT(*) AS n FROM users')[0]?.n ?? 0,
      create: ({ id, name, disabled, createdAt }) =>
        db.run(
          'INSERT INTO users (id, name, disabled, created_at) VALUES (?, ?, ?, ?)',
          id,
          name,
          disabled ? 1 : 0,
          createdAt,
        ),
      update(id, { name, disabled }) {
        if (name !== undefined) db.run('UPDATE users SET name = ? WHERE id = ?', name, id);
        if (disabled !== undefined) {
          db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
        }
      },
      delete: (id) => db.run('DELETE FROM users WHERE id = ?', id),
      roles: (id) =>
        db
          .all<{ role: string }>('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', id)
          .map((row) => row.role),
      addRole: (id, role) =>
        db.run('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)', id, role),
      removeRole: (id, role) =>
        db.run('DELETE FROM user_roles WHERE user_id = ? AND role = ?', id, role),
      admins: () =>
        db.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM users JOIN user_roles ON user_roles.user_id = users.id
           WHERE user_roles.role = 'admin' AND users.disabled = 0`,
        )[0]?.n ?? 0,
    },
    identities: {
      get: (provider, subject) =>
        db
          .all<{ user_id: string; secret: string | null }>(
            'SELECT user_id, secret FROM identities WHERE provider = ? AND subject = ?',
            provider,
            subject,
          )
          .map((row) => ({ provider, subject, userId: row.user_id, secret: row.secret }))[0],
      put: ({ provider, subject, userId, secret }) =>
        db.run(
          `INSERT INTO identities (provider, subject, user_id, secret) VALUES (?, ?, ?, ?)
           ON CONFLICT (provider, subject)
           DO UPDATE SET user_id = excluded.user_id, secret = excluded.secret`,
          provider,
          subject,
          userId,
          secret,
        ),
    },
    roles: {
      list: roleList,
      get: (name) => roleList().find((role) => role.name === name),
      create: (name) => db.run('INSERT INTO roles (name, builtin) VALUES (?, 0)', name),
      delete: (name) => db.run('DELETE FROM roles WHERE name = ?', name),
      grant: (name, permission) =>
        db.run(
          'INSERT OR IGNORE INTO role_grants (role, permission) VALUES (?, ?)',
          name,
          permission,
        ),
      revoke: (name, permission) =>
        db.run('DELETE FROM role_grants WHERE role = ? AND permission = ?', name, permission),
      policy: () => ({ roles: Object.fromEntries([...grantsByRole()].sort()) }),
    },
    tokens: {
      list: () => db.all<TokenRow>('SELECT * FROM tokens ORDER BY created_at, id').map(toToken),
      get: (id) => db.all<TokenRow>('SELECT * FROM tokens WHERE id = ?', id).map(toToken)[0],
      byHash: (hash) =>
        db.all<TokenRow>('SELECT * FROM tokens WHERE hash = ?', hash).map(toToken)[0],
      create: (token, hash) =>
        db.run(
          `INSERT INTO tokens (id, hash, name, grants, expires, last_used, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          token.id,
          hash,
          token.name,
          JSON.stringify(token.grants),
          token.expires,
          token.lastUsed,
          token.createdBy,
          token.createdAt,
        ),
      delete: (id) => db.run('DELETE FROM tokens WHERE id = ?', id),
      deleteForUser: (userId) => db.run('DELETE FROM tokens WHERE created_by = ?', userId),
      touch: (id, lastUsed) => db.run('UPDATE tokens SET last_used = ? WHERE id = ?', lastUsed, id),
    },
    sessions: {
      get: (hash) =>
        db.all<SessionRow>('SELECT * FROM sessions WHERE hash = ?', hash).map(toSession)[0],
      create: ({ hash, userId, tokenId, createdAt, lastSeen }) =>
        db.run(
          'INSERT INTO sessions (hash, user_id, token_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
          hash,
          userId,
          tokenId,
          createdAt,
          lastSeen,
        ),
      touch: (hash, lastSeen) =>
        db.run('UPDATE sessions SET last_seen = ? WHERE hash = ?', lastSeen, hash),
      delete: (hash) => db.run('DELETE FROM sessions WHERE hash = ?', hash),
      deleteForUser: (userId) => db.run('DELETE FROM sessions WHERE user_id = ?', userId),
      trimForToken: (tokenId, keep) =>
        db.run(
          `DELETE FROM sessions WHERE token_id = ? AND hash NOT IN (
             SELECT hash FROM sessions WHERE token_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`,
          tokenId,
          tokenId,
          keep,
        ),
      deleteUserSessionsBefore: ({ lastSeen, createdAt }) =>
        db.run(
          'DELETE FROM sessions WHERE user_id IS NOT NULL AND (last_seen < ? OR created_at < ?)',
          lastSeen,
          createdAt,
        ),
    },
    bundleDefaults: {
      applied: (bundle) =>
        db.all('SELECT 1 FROM bundle_defaults WHERE bundle = ?', bundle).length > 0,
      markApplied: (bundle) =>
        db.run('INSERT OR IGNORE INTO bundle_defaults (bundle) VALUES (?)', bundle),
    },
    transaction(work) {
      // A transaction inside another is part of it.
      if (depth > 0) return work();
      // Takes the write lock at once, so two processes cannot both read and then both write.
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        depth--;
      }
    },
  };
}
