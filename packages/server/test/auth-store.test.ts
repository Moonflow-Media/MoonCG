import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthStore } from '../src/storage/auth-store.js';
import { migrate, openSqliteDb } from '../src/storage/db.js';
import {
  DATABASE_FILE,
  MIGRATIONS,
  memoryStorage,
  openSqliteStorage,
} from '../src/storage/replicant-store.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-auth-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const stores: Record<string, () => Promise<AuthStore>> = {
  memory: async () => {
    const storage = memoryStorage();
    cleanup.push(() => storage.close());
    return storage.auth;
  },
  sqlite: async () => {
    const storage = await openSqliteStorage(await temporaryDir());
    cleanup.push(() => storage.close());
    return storage.auth;
  },
};

const user = (id: string, name: string) => ({ id, name, disabled: false, createdAt: 1000 });
const token = (id: string, createdBy: string) => ({
  id,
  name: `token ${id}`,
  grants: ['bundle:scoreboard:view'],
  expires: null,
  lastUsed: null,
  createdBy,
  createdAt: 1000,
});

describe.each(Object.entries(stores))('the %s auth store', (_name, open) => {
  it('starts with the built-in roles and their grants', async () => {
    const { roles } = await open();
    expect(roles.list()).toEqual([
      { name: 'admin', builtin: true, grants: ['*'] },
      { name: 'graphics', builtin: true, grants: [] },
      { name: 'operator', builtin: true, grants: ['system:dashboard.view'] },
      { name: 'viewer', builtin: true, grants: ['system:dashboard.view'] },
    ]);
    expect(roles.policy()).toEqual({
      roles: {
        admin: ['*'],
        graphics: [],
        operator: ['system:dashboard.view'],
        viewer: ['system:dashboard.view'],
      },
    });
  });

  it('keeps users, finds them by name whatever the case, and refuses a taken name', async () => {
    const { users } = await open();
    expect(users.count()).toBe(0);
    users.create(user('u1', 'Ada'));
    users.create(user('u2', 'bob'));
    expect(users.count()).toBe(2);
    expect(users.byName('ADA')).toEqual(user('u1', 'Ada'));
    expect(users.get('u2')).toEqual(user('u2', 'bob'));
    expect(users.get('nope')).toBeUndefined();
    expect(users.list().map((entry) => entry.name)).toEqual(['Ada', 'bob']);
    expect(() => users.create(user('u3', 'ada'))).toThrow();

    users.update('u2', { name: 'Robert', disabled: true });
    expect(users.get('u2')).toEqual({ ...user('u2', 'Robert'), disabled: true });
  });

  it('keeps the users dev mode created apart: they count neither as users nor as admins', async () => {
    const { users } = await open();
    users.create({ ...user('d1', 'dev'), devMode: true });
    users.addRole('d1', 'admin');

    expect(users.count()).toBe(0);
    expect(users.admins()).toBe(0);
    expect(users.devMode()).toEqual([{ ...user('d1', 'dev'), devMode: true }]);
    expect(users.get('d1')).toEqual({ ...user('d1', 'dev'), devMode: true });
    expect(users.list().map((entry) => entry.name)).toEqual(['dev']);

    users.create(user('u1', 'ada'));
    users.addRole('u1', 'admin');
    expect(users.count()).toBe(1);
    expect(users.admins()).toBe(1);
    expect(users.get('u1')).toEqual(user('u1', 'ada'));
    // Nothing takes the mark away.
    users.update('d1', { name: 'dominik', disabled: false });
    expect(users.devMode().map((entry) => entry.name)).toEqual(['dominik']);
  });

  it('assigns roles and counts the enabled admins', async () => {
    const { users } = await open();
    users.create(user('u1', 'ada'));
    users.create(user('u2', 'bob'));
    users.addRole('u1', 'admin');
    users.addRole('u1', 'operator');
    users.addRole('u1', 'admin');
    users.addRole('u2', 'admin');
    expect(users.roles('u1')).toEqual(['admin', 'operator']);
    expect(users.admins()).toBe(2);
    users.update('u2', { disabled: true });
    expect(users.admins()).toBe(1);
    users.removeRole('u1', 'admin');
    expect(users.roles('u1')).toEqual(['operator']);
    expect(users.admins()).toBe(0);
    expect(() => users.addRole('u1', 'no-such-role')).toThrow();
  });

  it('keeps identities with their secret', async () => {
    const { users, identities } = await open();
    users.create(user('u1', 'ada'));
    identities.put({ provider: 'local', subject: 'u1', userId: 'u1', secret: 'hash-1' });
    identities.put({ provider: 'local', subject: 'u1', userId: 'u1', secret: 'hash-2' });
    expect(identities.get('local', 'u1')).toEqual({
      provider: 'local',
      subject: 'u1',
      userId: 'u1',
      secret: 'hash-2',
    });
    expect(identities.get('local', 'u2')).toBeUndefined();
  });

  it('creates and deletes roles, and grants and revokes permissions', async () => {
    const { roles, users } = await open();
    roles.create('replay');
    roles.grant('replay', 'bundle:replay:operate');
    roles.grant('replay', 'bundle:replay:operate');
    roles.grant('replay', 'bundle:replay:view');
    expect(roles.get('replay')).toEqual({
      name: 'replay',
      builtin: false,
      grants: ['bundle:replay:operate', 'bundle:replay:view'],
    });
    roles.revoke('replay', 'bundle:replay:view');
    expect(roles.get('replay')?.grants).toEqual(['bundle:replay:operate']);
    expect(() => roles.create('replay')).toThrow();

    users.create(user('u1', 'ada'));
    users.addRole('u1', 'replay');
    roles.delete('replay');
    expect(roles.get('replay')).toBeUndefined();
    expect(users.roles('u1')).toEqual([]);
  });

  it('keeps tokens by id and by hash, without ever storing a secret', async () => {
    const { users, tokens } = await open();
    users.create(user('u1', 'ada'));
    tokens.create(token('t1', 'u1'), 'hash-t1');
    tokens.create({ ...token('t2', 'u1'), expires: 5000 }, 'hash-t2');
    expect(tokens.byHash('hash-t1')).toEqual(token('t1', 'u1'));
    expect(tokens.byHash('nope')).toBeUndefined();
    expect(tokens.get('t2')?.expires).toBe(5000);
    expect(tokens.list().map((entry) => entry.id)).toEqual(['t1', 't2']);
    tokens.touch('t1', 2000);
    expect(tokens.get('t1')?.lastUsed).toBe(2000);
    tokens.delete('t1');
    expect(tokens.byHash('hash-t1')).toBeUndefined();
  });

  it('keeps sessions of users and of tokens', async () => {
    const { users, tokens, sessions } = await open();
    users.create(user('u1', 'ada'));
    tokens.create(token('t1', 'u1'), 'hash-t1');
    const mine = { hash: 's1', userId: 'u1', tokenId: null, createdAt: 10, lastSeen: 10 };
    const bound = { hash: 's2', userId: null, tokenId: 't1', createdAt: 10, lastSeen: 10 };
    sessions.create(mine);
    sessions.create(bound);
    expect(sessions.get('s1')).toEqual(mine);
    expect(sessions.get('s2')).toEqual(bound);
    sessions.touch('s1', 99);
    expect(sessions.get('s1')?.lastSeen).toBe(99);
    sessions.delete('s1');
    expect(sessions.get('s1')).toBeUndefined();

    sessions.create(mine);
    sessions.create({ ...mine, hash: 's3' });
    sessions.deleteForUser('u1');
    expect(sessions.get('s1')).toBeUndefined();
    expect(sessions.get('s3')).toBeUndefined();
    expect(sessions.get('s2')).toEqual(bound);

    sessions.create({ ...mine, hash: 'old', lastSeen: 5 });
    sessions.create({ ...mine, hash: 'new', lastSeen: 50 });
    sessions.deleteUserSessionsBefore({ lastSeen: 20, createdAt: 0 });
    expect(sessions.get('old')).toBeUndefined();
    expect(sessions.get('new')).toBeDefined();
    // A session bound to a token lives as long as the token.
    expect(sessions.get('s2')).toEqual(bound);
  });

  it('removes everything that belonged to a deleted user or token', async () => {
    const { users, identities, tokens, sessions } = await open();
    users.create(user('u1', 'ada'));
    users.addRole('u1', 'admin');
    identities.put({ provider: 'local', subject: 'u1', userId: 'u1', secret: 'x' });
    tokens.create(token('t1', 'u1'), 'hash-t1');
    tokens.create(token('t2', 'u1'), 'hash-t2');
    sessions.create({ hash: 's1', userId: 'u1', tokenId: null, createdAt: 1, lastSeen: 1 });
    sessions.create({ hash: 's2', userId: null, tokenId: 't1', createdAt: 1, lastSeen: 1 });
    sessions.create({ hash: 's3', userId: null, tokenId: 't2', createdAt: 1, lastSeen: 1 });

    tokens.delete('t2');
    expect(sessions.get('s3')).toBeUndefined();
    users.delete('u1');
    expect(identities.get('local', 'u1')).toBeUndefined();
    expect(tokens.list()).toEqual([]);
    expect(sessions.get('s1')).toBeUndefined();
    expect(sessions.get('s2')).toBeUndefined();
    expect(users.admins()).toBe(0);
  });

  it('remembers which bundles had their default roles applied', async () => {
    const { bundleDefaults } = await open();
    expect(bundleDefaults.applied('scoreboard')).toBe(false);
    bundleDefaults.markApplied('scoreboard');
    bundleDefaults.markApplied('scoreboard');
    expect(bundleDefaults.applied('scoreboard')).toBe(true);
  });

  it('undoes everything a failed transaction did', async () => {
    const store = await open();
    expect(() =>
      store.transaction(() => {
        store.users.create(user('u1', 'ada'));
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(store.users.count()).toBe(0);
    expect(store.transaction(() => 7)).toBe(7);
  });
});

describe('the auth migration', () => {
  it('adds the auth tables to a database of the previous version, keeping its data', async () => {
    const dir = await temporaryDir();
    const db = await openSqliteDb(join(dir, DATABASE_FILE));
    migrate(db, MIGRATIONS.slice(0, 2));
    db.run('INSERT INTO disabled_bundles (name) VALUES (?)', 'old');
    db.close();

    const storage = await openSqliteStorage(dir);
    cleanup.push(() => storage.close());
    expect(await storage.bundles.disabled()).toEqual(['old']);
    expect(storage.auth.roles.list().map((role) => role.name)).toEqual([
      'admin',
      'graphics',
      'operator',
      'viewer',
    ]);
  });

  it('marks no user of an earlier version as created by dev mode', async () => {
    const dir = await temporaryDir();
    const db = await openSqliteDb(join(dir, DATABASE_FILE));
    // The version before users could be marked.
    migrate(db, MIGRATIONS.slice(0, 5));
    db.run('INSERT INTO users (id, name, disabled, created_at) VALUES (?, ?, 0, 1)', 'u1', 'dev');
    db.close();

    const storage = await openSqliteStorage(dir);
    cleanup.push(() => storage.close());
    expect(storage.auth.users.byName('dev')).toEqual({
      id: 'u1',
      name: 'dev',
      disabled: false,
      createdAt: 1,
    });
    expect(storage.auth.users.count()).toBe(1);
    expect(storage.auth.users.devMode()).toEqual([]);
  });

  it('keeps users across a restart', async () => {
    const dir = await temporaryDir();
    const first = await openSqliteStorage(dir);
    first.auth.users.create(user('u1', 'ada'));
    await first.close();
    const second = await openSqliteStorage(dir);
    cleanup.push(() => second.close());
    expect(second.auth.users.byName('ada')?.id).toBe('u1');
  });
});
