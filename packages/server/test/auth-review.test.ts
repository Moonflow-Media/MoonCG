import { MoonCGError, type Principal } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Auth,
  createAuth,
  MAX_VERIFICATIONS,
  ThrottledError,
  TOKEN_SESSION_MAX_MS,
  usableLogin,
} from '../src/auth/auth.js';
import { createLimiter, LimiterFull } from '../src/auth/limiter.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { migrate, openSqliteDb } from '../src/storage/db.js';
import { DATABASE_FILE, MIGRATIONS, memoryStorage } from '../src/storage/replicant-store.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const CHEAP = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct horse';

function setup() {
  const storage = memoryStorage();
  cleanup.push(() => storage.close());
  const clock = { now: 1_000_000 };
  const auth = createAuth({ store: storage.auth, now: () => clock.now, scrypt: CHEAP });
  return { auth, clock, store: storage.auth };
}

async function withAdmin() {
  const context = setup();
  const ada = await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  return { ...context, ada };
}

const codeOf = async (work: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    return error instanceof MoonCGError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error';
};
const tally = (results: { ok: boolean; reason?: string }[]) => ({
  ok: results.filter((result) => result.ok).length,
  credentials: results.filter((result) => result.reason === 'credentials').length,
  throttled: results.filter((result) => result.reason === 'throttled').length,
});

describe('first-time setup', () => {
  it('creates exactly one administrator however many requests use the code at once', async () => {
    const { auth } = setup();
    const code = auth.setupCode() as string;
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        codeOf(auth.setup(code, `admin${index}`, PASSWORD)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'no error')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'not_found')).toHaveLength(5);
    expect(auth.listUsers()).toHaveLength(1);
  });

  it('keeps the code usable after input the caller can fix', async () => {
    const { auth } = setup();
    const code = auth.setupCode() as string;
    expect(await codeOf(auth.setup(code, 'ada', 'short'))).toBe('bad_request');
    expect(await codeOf(auth.setup(code, 'not a name', PASSWORD))).toBe('bad_request');
    expect(auth.setupCode()).toBe(code);
    expect(await codeOf(auth.setup(code, 'ada', PASSWORD))).toBe('no error');
  });

  it('creates nobody when a user appeared while the password was being hashed', async () => {
    const { auth, store } = setup();
    const code = auth.setupCode() as string;
    const pending = auth.setup(code, 'ada', PASSWORD);
    // What the command line tool can do at any moment, in another process.
    store.users.create({ id: 'cli', name: 'cli', disabled: false, createdAt: 1 });
    expect(await codeOf(pending)).toBe('not_found');
    expect(auth.listUsers().map((user) => user.name)).toEqual(['cli']);
  });
});

describe('login throttle under concurrency', () => {
  it('admits no more wrong attempts at once than one after another', async () => {
    const { auth } = await withAdmin();
    const results = await Promise.all(
      Array.from({ length: 60 }, () => auth.login('ada', 'wrong password', '10.0.0.9')),
    );
    expect(tally(results)).toEqual({ ok: 0, credentials: 5, throttled: 55 });
  });

  it('does not hold a successful login against the address', async () => {
    const { auth } = await withAdmin();
    for (let i = 0; i < 30; i++) {
      expect((await auth.login('ada', PASSWORD, '10.0.0.9')).ok).toBe(true);
    }
    expect(auth.stats().throttleKeys).toBe(0);
  });

  it('runs only a few password checks at a time and refuses what does not fit the queue', async () => {
    const { auth } = await withAdmin();
    let peak = 0;
    const watch = setInterval(() => {
      peak = Math.max(peak, auth.stats().verifying);
    }, 0);
    // Each from another address and for another name, so no throttle key is hit.
    const results = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        auth.login(`guess${index}`, 'wrong password', `10.1.${index % 250}.${index}`),
      ),
    );
    clearInterval(watch);
    expect(peak).toBeLessThanOrEqual(MAX_VERIFICATIONS);
    const { credentials, throttled } = tally(results);
    expect(throttled).toBeGreaterThan(0);
    expect(credentials + throttled).toBe(200);
    expect(auth.stats()).toMatchObject({ verifying: 0, waiting: 0 });
  });
});

describe('a limiter', () => {
  it('runs at most so many at once, queues some and refuses the rest', async () => {
    const limiter = createLimiter({ max: 2, queue: 1 });
    const gates: (() => void)[] = [];
    const work = () => new Promise<void>((resolve) => gates.push(resolve));
    const first = limiter.run(work);
    const second = limiter.run(work);
    const third = limiter.run(work);
    await expect(limiter.run(work)).rejects.toBeInstanceOf(LimiterFull);
    expect(limiter.stats()).toEqual({ running: 2, waiting: 1 });
    gates[0]?.();
    await first;
    expect(limiter.stats()).toEqual({ running: 2, waiting: 0 });
    for (const open of gates.slice(1)) open();
    await Promise.all([second, third]);
    gates[2]?.();
    expect(limiter.stats()).toEqual({ running: 0, waiting: 0 });
    // A failure frees its place like a success.
    await expect(limiter.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(limiter.stats()).toEqual({ running: 0, waiting: 0 });
  });
});

describe('login input', () => {
  it('answers a name that cannot be a user name like any wrong login, without keeping it', async () => {
    const { auth } = await withAdmin();
    const huge = 'a'.repeat(1024 * 1024);
    const before = auth.stats().throttleKeys;
    expect(await auth.login(huge, PASSWORD, '10.0.0.1')).toEqual({
      ok: false,
      reason: 'credentials',
    });
    expect(await auth.login('not a name', PASSWORD, '10.0.0.1')).toEqual({
      ok: false,
      reason: 'credentials',
    });
    // Only the address was counted: nothing derived from the name is held.
    expect(auth.stats().throttleKeys).toBe(before + 1);
  });

  it('does not hash an over-long password, for a known user either', async () => {
    const { auth } = await withAdmin();
    const started = Date.now();
    const result = await auth.login('ada', 'x'.repeat(900 * 1024), '10.0.0.1');
    expect(result).toEqual({ ok: false, reason: 'credentials' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(usableLogin('ada', 'x'.repeat(1025))).toBe(false);
    expect(usableLogin('ada', PASSWORD)).toBe(true);
    expect(usableLogin('a'.repeat(65), PASSWORD)).toBe(false);
  });

  it('bounds the size of a throttle key whatever it is given', () => {
    const throttle = new LoginThrottle({ now: () => 0, free: 1, baseMs: 1000, maxMs: 4000 });
    const long = 'k'.repeat(100_000);
    throttle.fail(long);
    expect(throttle.blockedFor(long)).toBe(1000);
    expect(throttle.blockedFor(`${long}x`)).toBe(0);
    expect(Math.max(...throttle.keys().map((key) => key.length))).toBeLessThanOrEqual(128);
  });
});

describe('who gets locked out', () => {
  it('blocks the address that guesses, not the user at another address', async () => {
    const { auth } = await withAdmin();
    for (let i = 0; i < 8; i++) await auth.login('ada', 'wrong password', '10.6.6.6');
    expect(await auth.login('ada', PASSWORD, '10.6.6.6')).toMatchObject({ reason: 'throttled' });
    expect((await auth.login('ada', PASSWORD, '10.0.0.1')).ok).toBe(true);
  });

  it('trips a breaker for a name attacked from many addresses, and only briefly', async () => {
    const { auth, clock } = await withAdmin();
    const guess = (i: number) => auth.login('ada', 'wrong password', `10.0.${i}.7`);
    for (let i = 0; i < 50; i++) await guess(i);
    // Far below the breaker: the user is not locked out by guesses from elsewhere.
    expect((await auth.login('ada', PASSWORD, '10.200.0.1')).ok).toBe(true);
    for (let i = 50; i < 100; i++) await guess(i);
    const blocked = await auth.login('ada', PASSWORD, '10.0.0.1');
    expect(blocked).toMatchObject({ ok: false, reason: 'throttled' });
    expect(
      blocked.ok === false && blocked.reason === 'throttled' && blocked.retryAfterSeconds,
    ).toBeLessThanOrEqual(60);
    clock.now += 61_000;
    expect((await auth.login('ada', PASSWORD, '10.0.0.1')).ok).toBe(true);
  });
});

describe('changing the own password', () => {
  it('is throttled like a login', async () => {
    const { auth, ada } = await withAdmin();
    const attempt = () => auth.changeOwnPassword(ada.id, 'wrong password', 'next password');
    for (let i = 0; i < 5; i++) expect(await codeOf(attempt())).toBe('forbidden');
    const blocked = await attempt().catch((error) => error);
    expect(blocked).toBeInstanceOf(ThrottledError);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Also with the right current password, while it is blocked.
    expect(
      await auth.changeOwnPassword(ada.id, PASSWORD, 'next password').catch((error) => error),
    ).toBeInstanceOf(ThrottledError);
  });

  it('counts concurrent guesses too', async () => {
    const { auth, ada } = await withAdmin();
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () =>
        auth.changeOwnPassword(ada.id, 'wrong password', 'next password').catch((error) => error),
      ),
    );
    expect(outcomes.filter((outcome) => outcome instanceof ThrottledError)).toHaveLength(25);
  });

  it('keeps tokens by default and revokes them when asked', async () => {
    const { auth, ada } = await withAdmin();
    const admin: Principal = { id: `user:${ada.id}`, kind: 'user', roles: ['admin'] };
    const { secret } = auth.createToken(admin, { name: 'OBS', grants: ['*'] });
    await auth.changeOwnPassword(ada.id, PASSWORD, 'second password');
    expect(auth.identify({ bearer: secret }).via).toBe('bearer');
    await auth.changeOwnPassword(ada.id, 'second password', 'third password', {
      revokeTokens: true,
    });
    expect(auth.identify({ bearer: secret }).via).toBe('none');
    expect(auth.listTokens()).toEqual([]);
  });

  it('does not bring back a user who was disabled, or undo a reset, meanwhile', async () => {
    const { auth, store } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    const disabledMeanwhile = auth.changeOwnPassword(bob.id, PASSWORD, 'next password');
    store.users.update(bob.id, { disabled: true });
    expect(await codeOf(disabledMeanwhile)).toBe('forbidden');

    store.users.update(bob.id, { disabled: false });
    const resetMeanwhile = auth.changeOwnPassword(bob.id, PASSWORD, 'next password');
    store.identities.put({ provider: 'local', subject: bob.id, userId: bob.id, secret: 'reset' });
    expect(await codeOf(resetMeanwhile)).toBe('forbidden');
    expect(store.identities.get('local', bob.id)?.secret).toBe('reset');
  });
});

describe('resetting a password', () => {
  it('revokes the tokens of that user unless told not to', async () => {
    const { auth, ada } = await withAdmin();
    const admin: Principal = { id: `user:${ada.id}`, kind: 'user', roles: ['admin'] };
    const kept = auth.createToken(admin, { name: 'kept', grants: ['*'] });
    await auth.setPassword(ada.id, 'second password', { revokeTokens: false });
    expect(auth.identify({ bearer: kept.secret }).via).toBe('bearer');
    const session = auth.exchangeToken(kept.secret)?.session;
    await auth.setPassword(ada.id, 'third password');
    expect(auth.identify({ bearer: kept.secret }).via).toBe('none');
    expect(auth.identify({ tokenSession: session }).via).toBe('none');
  });
});

describe('login and a change made meanwhile', () => {
  it('fails if the user was disabled while the password was being checked', async () => {
    const { auth, store, ada } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    const pending = auth.login('bob', PASSWORD, '10.0.0.1');
    store.users.update(bob.id, { disabled: true });
    expect(await pending).toEqual({ ok: false, reason: 'credentials' });
    expect(ada.id).toBeDefined();
  });

  it('fails if the password was replaced while the old one was being checked', async () => {
    const { auth, store } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    const pending = auth.login('bob', PASSWORD, '10.0.0.1');
    store.identities.put({ provider: 'local', subject: bob.id, userId: bob.id, secret: 'reset' });
    expect(await pending).toEqual({ ok: false, reason: 'credentials' });
  });
});

describe('token sessions', () => {
  it('end after a fixed time when the token never expires, and at its expiry when it does', async () => {
    const { auth, ada, clock } = await withAdmin();
    const admin: Principal = { id: `user:${ada.id}`, kind: 'user', roles: ['admin'] };
    const forever = auth.createToken(admin, { name: 'forever', grants: ['*'] });
    const short = auth.createToken(admin, {
      name: 'short',
      grants: ['*'],
      expires: clock.now + 3_600_000,
    });
    const a = auth.exchangeToken(forever.secret);
    const b = auth.exchangeToken(short.secret);
    expect(a?.maxAgeSeconds).toBe(TOKEN_SESSION_MAX_MS / 1000);
    expect(b?.maxAgeSeconds).toBe(3600);
    clock.now += TOKEN_SESSION_MAX_MS - 1000;
    expect(auth.identify({ tokenSession: a?.session }).via).toBe('token-session');
    clock.now += 2000;
    expect(auth.identify({ tokenSession: a?.session }).via).toBe('none');
    // The token itself still works, so the URL with the token simply issues a new session.
    expect(auth.exchangeToken(forever.secret)).toBeDefined();
  });
});

describe('nobody hands out more than they hold', () => {
  async function withManager() {
    const context = await withAdmin();
    const { auth } = context;
    auth.createRole('manager', [
      'system:users.manage',
      'system:dashboard.view',
      'bundle:board:view',
    ]);
    auth.createRole('board-viewer', ['bundle:board:view']);
    auth.createRole('board-operator', ['bundle:board:view', 'bundle:board:operate']);
    const mia = await auth.createUser({ name: 'mia', password: PASSWORD, roles: ['manager'] });
    const vic = await auth.createUser({ name: 'vic', password: PASSWORD, roles: ['board-viewer'] });
    const manager: Principal = { id: `user:${mia.id}`, kind: 'user', roles: ['manager'] };
    const admin: Principal = { id: `user:${context.ada.id}`, kind: 'user', roles: ['admin'] };
    const check = (actor: Principal, change: Parameters<Auth['authorizeChange']>[1]) =>
      codeOf(() => auth.authorizeChange(actor, change));
    return { ...context, mia, vic, manager, admin, check };
  }

  it('allows roles and grants the actor fully holds', async () => {
    const { check, manager, vic } = await withManager();
    expect(await check(manager, { roles: ['board-viewer'] })).toBe('no error');
    expect(await check(manager, { grants: ['bundle:board:view', 'system:users.manage'] })).toBe(
      'no error',
    );
    expect(await check(manager, { users: [vic.id] })).toBe('no error');
  });

  it('refuses a role, a grant or a user beyond the actor', async () => {
    const { check, manager, ada, auth } = await withManager();
    expect(await check(manager, { roles: ['admin'] })).toBe('forbidden');
    expect(await check(manager, { roles: ['board-operator'] })).toBe('forbidden');
    expect(await check(manager, { grants: ['*'] })).toBe('forbidden');
    expect(await check(manager, { grants: ['bundle:*:view'] })).toBe('forbidden');
    expect(await check(manager, { users: [ada.id] })).toBe('forbidden');
    expect(() => auth.authorizeChange(manager, { roles: ['admin'] })).toThrow(/you do not hold/i);
  });

  it('leaves whoever holds everything alone, and ignores what does not exist', async () => {
    const { check, manager, admin, ada } = await withManager();
    expect(await check(admin, { roles: ['admin'], grants: ['*'], users: [ada.id] })).toBe(
      'no error',
    );
    // The operation itself reports what is missing.
    expect(await check(manager, { roles: ['nope'], users: ['nope'] })).toBe('no error');
  });

  it('applies to a token with the token limits', async () => {
    const { auth, check, admin, vic } = await withManager();
    const { secret } = auth.createToken(admin, { name: 't', grants: ['system:users.manage'] });
    const token = auth.identify({ bearer: secret }).principal;
    expect(await check(token, { roles: ['board-viewer'] })).toBe('forbidden');
    expect(await check(token, { users: [vic.id] })).toBe('forbidden');
  });
});

describe('migrating a database two processes open at once', () => {
  it('reads the version and migrates under one write lock', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-migrate-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const first = await openSqliteDb(join(dir, DATABASE_FILE));
    const second = await openSqliteDb(join(dir, DATABASE_FILE));
    cleanup.push(
      () => first.close(),
      () => second.close(),
    );
    migrate(first, MIGRATIONS.slice(0, 2));

    // The second process migrates the moment the first has read the version, if the first
    // read it without holding the lock.
    let locked = false;
    let raced = false;
    const racing = {
      ...first,
      exec(sql: string) {
        if (sql.startsWith('BEGIN')) locked = true;
        if (sql === 'COMMIT' || sql === 'ROLLBACK') locked = false;
        first.exec(sql);
      },
      all: ((sql: string, ...params: (string | number | null)[]) => {
        const rows = first.all(sql, ...params);
        if (sql.includes('user_version') && !locked && !raced) {
          raced = true;
          migrate(second, MIGRATIONS);
        }
        return rows;
      }) as typeof first.all,
    };
    expect(migrate(racing, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(raced).toBe(false);
    expect(migrate(second, MIGRATIONS)).toBe(MIGRATIONS.length);
    expect(second.all('SELECT name FROM roles ORDER BY name')).toHaveLength(4);
  });
});
