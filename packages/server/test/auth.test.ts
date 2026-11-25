import { authorize, MoonCGError, type Principal } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Auth,
  createAuth,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  TOKEN_PREFIX,
} from '../src/auth/auth.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../src/auth/password.js';
import { redactSecrets } from '../src/auth/secrets.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { memoryStorage, type Storage } from '../src/storage/replicant-store.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const CHEAP = { N: 16, r: 1, p: 1 };
const PASSWORD = 'correct horse';

function setup() {
  const storage: Storage = memoryStorage();
  cleanup.push(() => storage.close());
  const clock = { now: 1_000_000 };
  const auth = createAuth({ store: storage.auth, now: () => clock.now, scrypt: CHEAP });
  return { auth, clock, store: storage.auth };
}

/** An auth service that already has the admin "ada". */
async function withAdmin() {
  const context = setup();
  const ada = await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  return { ...context, ada };
}

async function loginAs(auth: Auth, name: string, password = PASSWORD, address = '10.0.0.1') {
  const result = await auth.login(name, password, address);
  if (!result.ok) throw new Error(`login failed: ${result.reason}`);
  return result;
}

const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return error instanceof MoonCGError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'no error';
};
const codeOf = async (work: Promise<unknown>) =>
  work.then(
    () => 'no error',
    (error) => (error instanceof MoonCGError ? error.code : `unexpected: ${String(error)}`),
  );

describe('password hashing', () => {
  it('verifies the right password and no other', async () => {
    const hash = await hashPassword(PASSWORD, CHEAP);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('correct horsf', hash)).toBe(false);
  });

  it('salts every hash and stores its parameters with it', async () => {
    const [a, b] = await Promise.all([
      hashPassword(PASSWORD, CHEAP),
      hashPassword(PASSWORD, CHEAP),
    ]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16\$1\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    // A hash made with other parameters still verifies: they are read from the hash.
    const stronger = await hashPassword(PASSWORD, { N: 64, r: 2, p: 1 });
    expect(await verifyPassword(PASSWORD, stronger)).toBe(true);
  });

  it('answers no for a hash it cannot read', async () => {
    expect(await verifyPassword(PASSWORD, 'plain')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$x$1$1$aa$bb')).toBe(false);
  });

  it('requires a minimum length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
});

describe('login throttle', () => {
  it('allows a few failures, then blocks for longer each time', () => {
    let now = 0;
    const throttle = new LoginThrottle({ now: () => now, free: 3, baseMs: 1000, maxMs: 8000 });
    throttle.fail('k');
    throttle.fail('k');
    expect(throttle.blockedFor('k')).toBe(0);
    throttle.fail('k');
    expect(throttle.blockedFor('k')).toBe(1000);
    now += 1000;
    expect(throttle.blockedFor('k')).toBe(0);
    throttle.fail('k');
    expect(throttle.blockedFor('k')).toBe(2000);
    for (let i = 0; i < 10; i++) throttle.fail('k');
    expect(throttle.blockedFor('k')).toBe(8000);
    expect(throttle.blockedFor('other')).toBe(0);
  });

  it('forgets a key on success and after a quiet time', () => {
    let now = 0;
    const throttle = new LoginThrottle({ now: () => now, free: 1, baseMs: 1000, maxMs: 4000 });
    throttle.fail('a');
    throttle.succeed('a');
    expect(throttle.blockedFor('a')).toBe(0);
    throttle.fail('b');
    now += 4000 * 2 + 1;
    throttle.fail('b');
    expect(throttle.blockedFor('b')).toBe(1000);
  });

  it('never tracks more keys than its limit', () => {
    const throttle = new LoginThrottle({
      now: () => 0,
      free: 1,
      baseMs: 1000,
      maxMs: 4000,
      maxKeys: 3,
    });
    for (const key of ['a', 'b', 'c', 'd', 'e']) throttle.fail(key);
    expect(throttle.size).toBe(3);
    expect(throttle.blockedFor('a')).toBe(0);
    expect(throttle.blockedFor('e')).toBe(1000);
  });
});

describe('redactSecrets', () => {
  it('replaces every API token in a text', () => {
    expect(redactSecrets('GET /b/x/graphics/a.html?token=mcg_AbC-12_x&y=1 and mcg_zzz')).toBe(
      'GET /b/x/graphics/a.html?token=mcg_***&y=1 and mcg_***',
    );
    expect(redactSecrets('nothing here')).toBe('nothing here');
  });
});

describe('local accounts', () => {
  it('signs a user in with the right password', async () => {
    const { auth, ada } = await withAdmin();
    const result = await loginAs(auth, 'ADA');
    expect(result.user).toEqual({ id: ada.id, name: 'ada', disabled: false, roles: ['admin'] });
    const identity = auth.identify({ session: result.session });
    expect(identity.via).toBe('session');
    expect(identity.principal).toEqual({ id: `user:${ada.id}`, kind: 'user', roles: ['admin'] });
    expect(authorize(identity.principal, 'system:users.manage', identity.policy)).toBe(true);
  });

  it('answers the same for a wrong password, an unknown user and a disabled user', async () => {
    const { auth } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    auth.updateUser(bob.id, { disabled: true });
    const wrong = await auth.login('ada', 'wrong password', '10.0.0.1');
    const unknown = await auth.login('nobody', PASSWORD, '10.0.0.2');
    const disabled = await auth.login('bob', PASSWORD, '10.0.0.3');
    expect(wrong).toEqual({ ok: false, reason: 'credentials' });
    expect(unknown).toEqual(wrong);
    expect(disabled).toEqual(wrong);
  });

  it('never stores or returns a password or its plain hash input', async () => {
    const { auth, store, ada } = await withAdmin();
    const secret = store.identities.get('local', ada.id)?.secret ?? '';
    expect(secret).toMatch(/^scrypt\$/);
    expect(secret).not.toContain(PASSWORD);
    expect(JSON.stringify(auth.listUsers())).not.toContain('scrypt');
  });

  it('refuses short passwords and unusable names', async () => {
    const { auth } = setup();
    expect(await codeOf(auth.createUser({ name: 'ada', password: 'short' }))).toBe('bad_request');
    expect(await codeOf(auth.createUser({ name: '', password: PASSWORD }))).toBe('bad_request');
    expect(await codeOf(auth.createUser({ name: 'a b', password: PASSWORD }))).toBe('bad_request');
    await auth.createUser({ name: 'ada', password: PASSWORD });
    expect(await codeOf(auth.createUser({ name: 'Ada', password: PASSWORD }))).toBe('conflict');
    expect(
      await codeOf(auth.createUser({ name: 'bob', password: PASSWORD, roles: ['nope'] })),
    ).toBe('not_found');
  });

  it('throttles a user name at an address after repeated failures, even for the right password', async () => {
    const { auth, clock } = await withAdmin();
    for (let i = 0; i < 5; i++) {
      expect(await auth.login('ada', 'wrong password', '10.0.2.1')).toEqual({
        ok: false,
        reason: 'credentials',
      });
    }
    const blocked = await auth.login('ada', PASSWORD, '10.0.2.1');
    expect(blocked).toMatchObject({ ok: false, reason: 'throttled' });
    expect(blocked).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    clock.now += 60 * 60 * 1000;
    expect((await auth.login('ada', PASSWORD, '10.0.2.1')).ok).toBe(true);
  });

  it('throttles an address that tries many names, and unknown names like known ones', async () => {
    const { auth } = await withAdmin();
    for (let i = 0; i < 20; i++) await auth.login(`guess${i}`, 'wrong password', '10.9.9.9');
    expect(await auth.login('ada', PASSWORD, '10.9.9.9')).toMatchObject({
      ok: false,
      reason: 'throttled',
    });
    expect((await auth.login('ada', PASSWORD, '10.0.0.1')).ok).toBe(true);
    for (let i = 0; i < 5; i++) await auth.login('ghost', 'wrong password', '10.4.0.1');
    expect(await auth.login('ghost', 'wrong password', '10.4.0.1')).toMatchObject({
      reason: 'throttled',
    });
  });
});

describe('sessions', () => {
  it('stores only a hash of the session secret', async () => {
    const { auth, store } = await withAdmin();
    const { session } = await loginAs(auth, 'ada');
    expect(session.length).toBeGreaterThanOrEqual(40);
    expect(store.sessions.get(session)).toBeUndefined();
  });

  it('slides while in use and ends after the idle time', async () => {
    const { auth, clock } = await withAdmin();
    const { session } = await loginAs(auth, 'ada');
    clock.now += SESSION_IDLE_MS - 1000;
    expect(auth.identify({ session }).via).toBe('session');
    clock.now += SESSION_IDLE_MS - 1000;
    expect(auth.identify({ session }).via).toBe('session');
    clock.now += SESSION_IDLE_MS + 1;
    expect(auth.identify({ session }).via).toBe('none');
    expect(auth.identify({ session }).principal.kind).toBe('anonymous');
  });

  it('ends at the absolute maximum however much it is used', async () => {
    const { auth, clock } = await withAdmin();
    const { session } = await loginAs(auth, 'ada');
    const step = SESSION_IDLE_MS / 2;
    for (let age = step; age < SESSION_MAX_MS; age += step) {
      clock.now += step;
      expect(auth.identify({ session }).via).toBe('session');
    }
    clock.now += step;
    expect(auth.identify({ session }).via).toBe('none');
  });

  it('is gone after logout', async () => {
    const { auth } = await withAdmin();
    const { session } = await loginAs(auth, 'ada');
    auth.logout(session);
    expect(auth.identify({ session }).via).toBe('none');
  });

  it('is revoked when the password changes or the user is disabled or deleted', async () => {
    const { auth, ada } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    const first = (await loginAs(auth, 'bob')).session;
    await auth.setPassword(bob.id, 'another password');
    expect(auth.identify({ session: first }).via).toBe('none');

    const second = (await loginAs(auth, 'bob', 'another password')).session;
    auth.updateUser(bob.id, { disabled: true });
    expect(auth.identify({ session: second }).via).toBe('none');
    auth.updateUser(bob.id, { disabled: false });
    expect(auth.identify({ session: second }).via).toBe('none');

    const third = (await loginAs(auth, 'bob', 'another password')).session;
    auth.deleteUser(bob.id);
    expect(auth.identify({ session: third }).via).toBe('none');
    expect(ada.id).toBeDefined();
  });

  it('lets a user change the own password with the old one, replacing the sessions', async () => {
    const { auth, ada } = await withAdmin();
    const { session } = await loginAs(auth, 'ada');
    expect(await codeOf(auth.changeOwnPassword(ada.id, 'wrong password', 'next password'))).toBe(
      'forbidden',
    );
    expect(await codeOf(auth.changeOwnPassword(ada.id, PASSWORD, 'short'))).toBe('bad_request');
    const fresh = await auth.changeOwnPassword(ada.id, PASSWORD, 'next password');
    expect(auth.identify({ session }).via).toBe('none');
    expect(auth.identify({ session: fresh }).via).toBe('session');
    expect((await auth.login('ada', 'next password', '10.0.0.1')).ok).toBe(true);
  });
});

describe('users and roles', () => {
  it('renames, lists and deletes users', async () => {
    const { auth, ada } = await withAdmin();
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD, roles: ['viewer'] });
    auth.updateUser(bob.id, { name: 'robert' });
    expect(auth.listUsers()).toEqual([
      { id: ada.id, name: 'ada', disabled: false, roles: ['admin'] },
      { id: bob.id, name: 'robert', disabled: false, roles: ['viewer'] },
    ]);
    expect(code(() => auth.updateUser(bob.id, { name: 'ADA' }))).toBe('conflict');
    expect(code(() => auth.updateUser('nope', { name: 'x' }))).toBe('not_found');
    auth.deleteUser(bob.id);
    expect(code(() => auth.deleteUser(bob.id))).toBe('not_found');
  });

  it('never leaves the server without an enabled admin', async () => {
    const { auth, ada } = await withAdmin();
    expect(code(() => auth.deleteUser(ada.id))).toBe('conflict');
    expect(code(() => auth.updateUser(ada.id, { disabled: true }))).toBe('conflict');
    expect(code(() => auth.unassignRole(ada.id, 'admin'))).toBe('conflict');
    expect(auth.listUsers()[0]).toMatchObject({ disabled: false, roles: ['admin'] });

    const bob = await auth.createUser({ name: 'bob', password: PASSWORD, roles: ['admin'] });
    auth.unassignRole(ada.id, 'admin');
    expect(code(() => auth.deleteUser(bob.id))).toBe('conflict');
  });

  it('creates, changes and deletes roles, but protects the built-in ones', async () => {
    const { auth, ada } = await withAdmin();
    auth.createRole('replay', ['bundle:replay:operate']);
    auth.grant('replay', 'bundle:replay:view');
    auth.revoke('replay', 'bundle:replay:operate');
    expect(auth.listRoles().find((role) => role.name === 'replay')).toEqual({
      name: 'replay',
      builtin: false,
      grants: ['bundle:replay:view'],
    });
    auth.assignRole(ada.id, 'replay');
    expect(code(() => auth.createRole('replay'))).toBe('conflict');
    expect(code(() => auth.createRole('Not Valid'))).toBe('bad_request');
    expect(code(() => auth.grant('replay', 'bundle:x:?'))).toBe('bad_request');
    expect(code(() => auth.grant('nope', 'bundle:x:view'))).toBe('not_found');
    expect(code(() => auth.assignRole(ada.id, 'nope'))).toBe('not_found');
    auth.deleteRole('replay');
    expect(auth.listUsers()[0]?.roles).toEqual(['admin']);

    expect(code(() => auth.deleteRole('viewer'))).toBe('conflict');
    expect(code(() => auth.revoke('admin', '*'))).toBe('conflict');
    auth.grant('viewer', 'bundle:*:view');
    auth.revoke('viewer', 'system:dashboard.view');
    expect(auth.policy().roles.viewer).toEqual(['bundle:*:view']);
  });

  it('tells listeners about every change of access', async () => {
    const { auth, ada } = await withAdmin();
    let changes = 0;
    const stop = auth.onChange(() => changes++);
    auth.createRole('replay');
    auth.grant('replay', 'bundle:replay:view');
    auth.assignRole(ada.id, 'replay');
    expect(changes).toBe(3);
    stop();
    auth.deleteRole('replay');
    expect(changes).toBe(3);
  });

  it('describes a principal with its roles and effective permissions', async () => {
    const { auth, ada } = await withAdmin();
    const { session } = await loginAs(auth, 'ada');
    expect(auth.describe(auth.identify({ session }))).toEqual({
      id: `user:${ada.id}`,
      kind: 'user',
      name: 'ada',
      roles: ['admin'],
      permissions: ['*'],
    });
    expect(auth.describe(auth.identify({}))).toEqual({
      id: 'anonymous',
      kind: 'anonymous',
      name: null,
      roles: [],
      permissions: [],
    });
  });
});

describe('API tokens', () => {
  async function withOperator() {
    const context = await withAdmin();
    const { auth } = context;
    auth.grant('operator', 'bundle:scoreboard:view');
    auth.grant('operator', 'bundle:scoreboard:operate');
    auth.grant('operator', 'system:tokens.manage');
    const olga = await auth.createUser({ name: 'olga', password: PASSWORD, roles: ['operator'] });
    const principal: Principal = { id: `user:${olga.id}`, kind: 'user', roles: ['operator'] };
    return { ...context, olga, principal };
  }

  it('shows the secret once and stores only its hash', async () => {
    const { auth, store, principal, olga } = await withOperator();
    const { secret, token } = auth.createToken(principal, {
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
    });
    expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatchObject({
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
      createdBy: olga.id,
    });
    expect(JSON.stringify(auth.listTokens())).not.toContain(secret);
    expect(store.tokens.byHash(secret)).toBeUndefined();
  });

  it('acts with its own grants only', async () => {
    const { auth, principal } = await withOperator();
    const { secret, token } = auth.createToken(principal, {
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
    });
    const identity = auth.identify({ bearer: secret });
    expect(identity.via).toBe('bearer');
    expect(identity.principal).toEqual({
      id: `token:${token.id}`,
      kind: 'token',
      roles: ['operator'],
      only: ['bundle:scoreboard:view'],
    });
    expect(authorize(identity.principal, 'bundle:scoreboard:view', identity.policy)).toBe(true);
    expect(authorize(identity.principal, 'bundle:scoreboard:operate', identity.policy)).toBe(false);
    expect(auth.identify({ bearer: `${secret}x` }).via).toBe('none');
    expect(auth.identify({ bearer: 'not-a-token' }).via).toBe('none');
  });

  it('cannot be created with more than its creator holds', async () => {
    const { auth, principal } = await withOperator();
    const create = (grants: string[]) => () => auth.createToken(principal, { name: 'x', grants });
    expect(code(create(['system:users.manage']))).toBe('forbidden');
    expect(code(create(['bundle:*:view']))).toBe('forbidden');
    expect(code(create(['*']))).toBe('forbidden');
    expect(code(create(['bundle:scoreboard:?']))).toBe('bad_request');
    expect(code(create([]))).toBe('bad_request');
    expect(
      code(() => auth.createToken(principal, { name: ' ', grants: ['bundle:scoreboard:view'] })),
    ).toBe('bad_request');
    // A token cannot hand out more than it holds itself.
    const { secret } = auth.createToken(principal, {
      name: 'manager',
      grants: ['system:tokens.manage', 'bundle:scoreboard:view'],
    });
    const viaToken = auth.identify({ bearer: secret }).principal;
    expect(
      code(() => auth.createToken(viaToken, { name: 'y', grants: ['bundle:scoreboard:operate'] })),
    ).toBe('forbidden');
    expect(
      auth.createToken(viaToken, { name: 'y', grants: ['bundle:scoreboard:view'] }).token.createdBy,
    ).toBe(principal.id.slice('user:'.length));
  });

  it('shrinks when its creator loses a permission and stops when the creator is disabled', async () => {
    const { auth, principal, olga } = await withOperator();
    const { secret } = auth.createToken(principal, {
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
    });
    auth.revoke('operator', 'bundle:scoreboard:view');
    const shrunk = auth.identify({ bearer: secret });
    expect(shrunk.via).toBe('bearer');
    expect(authorize(shrunk.principal, 'bundle:scoreboard:view', shrunk.policy)).toBe(false);
    auth.grant('operator', 'bundle:scoreboard:view');
    auth.updateUser(olga.id, { disabled: true });
    expect(auth.identify({ bearer: secret }).via).toBe('none');
    auth.updateUser(olga.id, { disabled: false });
    expect(auth.identify({ bearer: secret }).via).toBe('bearer');
    auth.deleteUser(olga.id);
    expect(auth.identify({ bearer: secret }).via).toBe('none');
    expect(auth.listTokens()).toEqual([]);
  });

  it('expires, and can be revoked', async () => {
    const { auth, principal, clock } = await withOperator();
    const grants = ['bundle:scoreboard:view'];
    const short = auth.createToken(principal, { name: 'short', grants, expires: clock.now + 1000 });
    const kept = auth.createToken(principal, { name: 'kept', grants });
    expect(
      code(() => auth.createToken(principal, { name: 'past', grants, expires: clock.now })),
    ).toBe('bad_request');
    clock.now += 1001;
    expect(auth.identify({ bearer: short.secret }).via).toBe('none');
    expect(auth.identify({ bearer: kept.secret }).via).toBe('bearer');
    auth.revokeToken(kept.token.id);
    expect(auth.identify({ bearer: kept.secret }).via).toBe('none');
    expect(code(() => auth.revokeToken(kept.token.id))).toBe('not_found');
  });

  it('records when it was last used, at most once a minute', async () => {
    const { auth, principal, clock } = await withOperator();
    const { secret, token } = auth.createToken(principal, {
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
    });
    const lastUsed = () => auth.listTokens().find((entry) => entry.id === token.id)?.lastUsed;
    expect(lastUsed()).toBeNull();
    auth.identify({ bearer: secret });
    const first = clock.now;
    expect(lastUsed()).toBe(first);
    clock.now += 30_000;
    auth.identify({ bearer: secret });
    expect(lastUsed()).toBe(first);
    clock.now += 31_000;
    auth.identify({ bearer: secret });
    expect(lastUsed()).toBe(clock.now);
  });

  it('exchanges for a browser session that lives and dies with the token', async () => {
    const { auth, principal, clock } = await withOperator();
    const { secret, token } = auth.createToken(principal, {
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
    });
    const session = auth.exchangeToken(secret)?.session;
    expect(session).toBeDefined();
    expect(auth.exchangeToken('mcg_wrong')).toBeUndefined();
    const identity = auth.identify({ tokenSession: session });
    expect(identity.via).toBe('token-session');
    expect(identity.principal.id).toBe(`token:${token.id}`);
    // No idle limit: a graphic in OBS may run for weeks without anyone touching it.
    clock.now += SESSION_MAX_MS * 2;
    expect(auth.identify({ tokenSession: session }).via).toBe('token-session');
    // A user's session wins over a token's when a browser has both.
    const mine = (await loginAs(auth, 'ada')).session;
    expect(auth.identify({ session: mine, tokenSession: session }).via).toBe('session');
    auth.revokeToken(token.id);
    expect(auth.identify({ tokenSession: session }).via).toBe('none');
  });

  it('keeps only the newest sessions of a token', async () => {
    const { auth, principal, clock } = await withOperator();
    const { secret } = auth.createToken(principal, {
      name: 'OBS',
      grants: ['bundle:scoreboard:view'],
    });
    const sessions: string[] = [];
    for (let i = 0; i < 25; i++) {
      clock.now += 1000;
      sessions.push(auth.exchangeToken(secret)?.session as string);
    }
    expect(auth.identify({ tokenSession: sessions[0] }).via).toBe('none');
    expect(auth.identify({ tokenSession: sessions[24] }).via).toBe('token-session');
    expect(auth.identify({ tokenSession: sessions[5] }).via).toBe('token-session');
  });
});

describe('looking principals up by id', () => {
  it('answers whether a user, a token or an extension holds a permission', async () => {
    const { auth, ada } = await withAdmin();
    auth.grant('viewer', 'bundle:scoreboard:view');
    const vera = await auth.createUser({ name: 'vera', password: PASSWORD, roles: ['viewer'] });
    const admin: Principal = { id: `user:${ada.id}`, kind: 'user', roles: ['admin'] };
    const { token } = auth.createToken(admin, { name: 't', grants: ['bundle:scoreboard:operate'] });

    expect(auth.check(`user:${vera.id}`, 'bundle:scoreboard:view')).toBe(true);
    expect(auth.check(`user:${vera.id}`, 'bundle:scoreboard:operate')).toBe(false);
    expect(auth.check(`token:${token.id}`, 'bundle:scoreboard:operate')).toBe(true);
    expect(auth.check(`token:${token.id}`, 'bundle:scoreboard:view')).toBe(false);
    // Extensions are trusted code.
    expect(auth.check('extension:other', 'bundle:scoreboard:operate')).toBe(true);
    expect(auth.check('anonymous', 'bundle:scoreboard:view')).toBe(false);
    expect(auth.check('user:nope', 'bundle:scoreboard:view')).toBe(false);
    auth.updateUser(vera.id, { disabled: true });
    expect(auth.check(`user:${vera.id}`, 'bundle:scoreboard:view')).toBe(false);
  });
});

describe('first-time setup', () => {
  it('offers a setup code only while there is no user', async () => {
    const { auth } = setup();
    const first = auth.setupCode();
    expect(first).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(auth.setupCode()).toBe(first);
    await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    expect(auth.setupCode()).toBeUndefined();
  });

  it('creates the first admin with the right code, once', async () => {
    const { auth } = setup();
    const setupCode = auth.setupCode() as string;
    expect(await codeOf(auth.setup('wrong', 'ada', PASSWORD))).toBe('forbidden');
    expect(await codeOf(auth.setup(setupCode, 'ada', 'short'))).toBe('bad_request');
    const user = await auth.setup(setupCode, 'ada', PASSWORD);
    expect(user).toMatchObject({ name: 'ada', roles: ['admin'] });
    expect(await codeOf(auth.setup(setupCode, 'eve', PASSWORD))).toBe('not_found');
    expect(auth.listUsers()).toHaveLength(1);
  });

  it('refuses setup once any user exists, however it was created', async () => {
    const { auth } = setup();
    const setupCode = auth.setupCode() as string;
    await auth.createUser({ name: 'cli', password: PASSWORD });
    expect(await codeOf(auth.setup(setupCode, 'ada', PASSWORD))).toBe('not_found');
  });
});

describe('bundle default roles', () => {
  const scoreboard = {
    name: 'scoreboard',
    defaultRoles: {
      operator: ['view', 'operate'],
      viewer: ['view'],
      admin: ['view'],
      custom: ['view'],
    },
  };

  it('grants them to the built-in roles when a bundle is first seen', async () => {
    const { auth } = setup();
    auth.applyBundleDefaults([scoreboard]);
    const { roles } = auth.policy();
    expect(roles.operator).toEqual([
      'bundle:scoreboard:operate',
      'bundle:scoreboard:view',
      'system:dashboard.view',
    ]);
    expect(roles.viewer).toEqual(['bundle:scoreboard:view', 'system:dashboard.view']);
    expect(roles.admin).toEqual(['*']);
    expect(roles.custom).toBeUndefined();
  });

  it('does not bring back a grant an admin removed', async () => {
    const { auth } = setup();
    auth.applyBundleDefaults([scoreboard]);
    auth.revoke('viewer', 'bundle:scoreboard:view');
    auth.applyBundleDefaults([scoreboard]);
    expect(auth.policy().roles.viewer).toEqual(['system:dashboard.view']);
    // Another bundle is new and gets its defaults.
    auth.applyBundleDefaults([scoreboard, { name: 'timer', defaultRoles: { viewer: ['view'] } }]);
    expect(auth.policy().roles.viewer).toEqual(['bundle:timer:view', 'system:dashboard.view']);
  });
});

describe('what a bundle proposes for the roles, and forgetting a bundle', () => {
  const defaults = {
    operator: ['view', 'operate'],
    viewer: ['view'],
    admin: ['view'],
    custom: ['view'],
  };

  it('says which grants a bundle would bring, and that a new name gets them', () => {
    const { auth } = setup();
    expect(auth.bundleDefaults('scoreboard', defaults)).toEqual({
      grants: { operator: ['view', 'operate'], viewer: ['view'] },
      applies: true,
    });
    // Asking changes nothing.
    expect(auth.policy().roles.viewer).toEqual(['system:dashboard.view']);
  });

  it('says that a name that was seen before gets none', () => {
    const { auth } = setup();
    auth.applyBundleDefaults([{ name: 'scoreboard', defaultRoles: defaults }]);
    expect(auth.bundleDefaults('scoreboard', defaults)).toMatchObject({ applies: false });
    expect(auth.bundleDefaults('other', {})).toEqual({ grants: {}, applies: true });
  });

  it('takes the grants of a bundle away again, and lets a new one of that name start over', () => {
    const { auth } = setup();
    auth.createRole('crew', ['bundle:scoreboard:view', 'bundle:scoreboard-two:view']);
    auth.applyBundleDefaults([
      { name: 'scoreboard', defaultRoles: defaults },
      { name: 'scoreboard-two', defaultRoles: { viewer: ['view'] } },
    ]);
    let changes = 0;
    auth.onChange(() => changes++);

    auth.forgetBundle('scoreboard');

    const { roles } = auth.policy();
    expect(roles.operator).toEqual(['system:dashboard.view']);
    expect(roles.viewer).toEqual(['bundle:scoreboard-two:view', 'system:dashboard.view']);
    expect(roles.crew).toEqual(['bundle:scoreboard-two:view']);
    expect(roles.admin).toEqual(['*']);
    expect(changes).toBeGreaterThan(0);
    expect(auth.bundleDefaults('scoreboard', defaults).applies).toBe(true);
    auth.applyBundleDefaults([{ name: 'scoreboard', defaultRoles: defaults }]);
    expect(auth.policy().roles.viewer).toContain('bundle:scoreboard:view');
  });

  it('forgets nothing for what is no bundle name', () => {
    const { auth } = setup();
    auth.createRole('crew', ['bundle:*:view', 'system:logs.view']);
    for (const name of ['*', '', 'a:b', '%', 'system']) auth.forgetBundle(name);
    expect(auth.policy().roles.crew).toEqual(['bundle:*:view', 'system:logs.view']);
  });
});
