import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelfLinking } from '../src/modules/self-linking.js';
import { cookiePair, type HttpAnswer, PASSWORD } from './auth-helpers.js';
import { FAKE_IDP, fakeIdpCalls, type ModuleServer, startModuleServer } from './module-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: ModuleServer | undefined;

beforeEach(() => {
  const calls = fakeIdpCalls();
  calls.authorize.length = 0;
  calls.callback.length = 0;
});
afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

const start = async () => {
  context = await startModuleServer(temporary, FAKE_IDP, ['fake-idp']);
  return context;
};
const cookieOf = (answer: HttpAnswer, name: string) => {
  const found = answer.setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found === undefined ? undefined : cookiePair(found);
};
const userId = (server: ModuleServer, name: string) =>
  server.auth.listUsers().find((user) => user.name === name)?.id as string;

/** Starts a link as the user with `session`, and comes back from the provider as `code`. */
async function link(server: ModuleServer, session: string, code: string, body: object = {}) {
  const started = await server.http('POST', '/api/v1/me/identities/fake/link', {
    cookie: session,
    json: { password: PASSWORD, ...body },
  });
  if (started.status !== 200) return { started };
  const url = new URL(started.json.url);
  const oauth = cookieOf(started, 'mooncg_oauth') as string;
  const back = await server.http(
    'GET',
    `/auth/fake/callback?state=${encodeURIComponent(url.searchParams.get('state') as string)}&code=${encodeURIComponent(code)}`,
    { cookie: `${session}; ${oauth}` },
  );
  return { started, back, oauth, state: url.searchParams.get('state') as string };
}
/** Runs `work` while `Date.now` says `at`. */
async function withClock<T>(at: number, work: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at;
  try {
    return await work();
  } finally {
    Date.now = real;
  }
}
const locationOf = (answer: HttpAnswer | undefined) =>
  new URL(answer?.headers.get('location') as string, 'http://x');

describe('linking an account to oneself', () => {
  it('links the account the provider vouches for, after the password, and stays signed in', async () => {
    const server = await start();
    const { started, back } = await link(server, server.admin, 'sub-1|Ada at Fake');
    expect(started.status).toBe(200);
    expect(locationOf(back).pathname).toBe('/account');
    expect(locationOf(back).searchParams.get('linked')).toBe('fake');
    // No new session: the browser goes on as it was.
    expect(cookieOf(back as HttpAnswer, 'mooncg_session')).toBeUndefined();
    const mine = await server.http('GET', '/api/v1/me/identities', { cookie: server.admin });
    expect(mine.json).toMatchObject({
      identities: [{ provider: 'fake', subject: 'sub-1' }],
      password: true,
    });
    expect(mine.json.providers).toContainEqual({
      id: 'fake',
      name: 'Fake <b>&"ID"',
      selfLink: true,
    });
    // The account signs in as the user now.
    expect(server.auth.externalLogin('fake', { subject: 'sub-1' })).toMatchObject({ ok: true });
  });

  it('takes the password first, and a wrong one starts nothing', async () => {
    const server = await start();
    const { started } = await link(server, server.admin, 'sub-1', { password: 'wrong' });
    expect(started.status).toBe(403);
    expect(started.json.error.message).toMatch(/password is wrong/);
    expect(fakeIdpCalls().authorize).toEqual([]);
  });

  it('is finished only by the session that started it', async () => {
    const server = await start();
    await server.auth.createUser({ name: 'bob', password: PASSWORD, roles: [] });
    const bob = await server.login('bob');
    const started = await server.http('POST', '/api/v1/me/identities/fake/link', {
      cookie: server.admin,
      json: { password: PASSWORD },
    });
    const url = new URL(started.json.url);
    const oauth = cookieOf(started, 'mooncg_oauth') as string;
    // Bob's browser comes back with ada's flow: nothing is linked to either.
    const back = await server.http(
      'GET',
      `/auth/fake/callback?state=${url.searchParams.get('state')}&code=sub-1`,
      { cookie: `${bob}; ${oauth}` },
    );
    expect(locationOf(back).pathname).toBe('/account');
    expect(locationOf(back).searchParams.get('error')).toBe('session');
    expect(server.auth.listIdentities()).toEqual([]);
    expect(fakeIdpCalls().callback).toEqual([]);
  });

  it('never moves an account that another user has', async () => {
    const server = await start();
    await server.auth.createUser({ name: 'bob', password: PASSWORD, roles: [] });
    server.auth.linkIdentity(userId(server, 'bob'), 'fake', 'sub-1');
    const { back } = await link(server, server.admin, 'sub-1');
    expect(locationOf(back).searchParams.get('error')).toBe('elsewhere');
    expect(server.auth.listIdentities()).toEqual([
      { userId: userId(server, 'bob'), provider: 'fake', subject: 'sub-1' },
    ]);
  });

  it('keeps to the realm a link is bound to', async () => {
    const server = await start();
    server.auth.linkIdentity(userId(server, 'ada'), 'fake', 'sub-1', 'realm-a');
    const { back } = await link(server, server.admin, 'sub-1|ada|realm-b');
    expect(locationOf(back).searchParams.get('error')).toBe('realm');
    expect(server.auth.listIdentities()[0]?.realm).toBe('realm-a');
    // A new link takes the realm the provider reports.
    const second = await link(server, server.admin, 'sub-2|ada|realm-c');
    expect(locationOf(second.back).searchParams.get('linked')).toBe('fake');
    expect(server.auth.listIdentities().find((one) => one.subject === 'sub-2')?.realm).toBe(
      'realm-c',
    );
  });

  it('asks a user without a password for a fresh sign-in', async () => {
    const server = await start();
    // Signed up through the provider: a user without a password.
    const signedIn = server.auth.externalLogin('open', { subject: 'eve-1' }, { signup: true });
    if (!signedIn.ok) throw new Error('refused');
    const session = `mooncg_session=${signedIn.session}`;
    const fresh = await server.http('POST', '/api/v1/me/identities/fake/link', {
      cookie: session,
      json: {},
    });
    expect(fresh.status).toBe(200);
    // Five minutes later the session is no fresh sign-in any more.
    const now = Date.now();
    const later = await withClock(now + 6 * 60 * 1000, () =>
      server.http('POST', '/api/v1/me/identities/fake/link', { cookie: session, json: {} }),
    );
    expect(later.status).toBe(403);
    expect(later.json.error.message).toMatch(/sign in again/);
  });

  it('is not there for tokens, for anonymous callers and where it is switched off', async () => {
    const server = await start();
    expect(
      (await server.http('POST', '/api/v1/me/identities/fake/link', { json: {} })).status,
    ).toBe(401);
    const off = await server.http('PUT', '/api/v1/self-linking', {
      cookie: server.admin,
      json: { enabled: true, disabledProviders: ['fake'] },
    });
    expect(off.json).toEqual({ enabled: true, disabledProviders: ['fake'] });
    const refused = await link(server, server.admin, 'sub-1');
    expect(refused.started.status).toBe(403);
    expect(refused.started.json.error.message).toMatch(/switched off/);
    const mine = await server.http('GET', '/api/v1/me/identities', { cookie: server.admin });
    expect(mine.json.providers.find((one: { id: string }) => one.id === 'fake').selfLink).toBe(
      false,
    );
    await server.http('PUT', '/api/v1/self-linking', {
      cookie: server.admin,
      json: { enabled: false },
    });
    const open = await server.http('POST', '/api/v1/me/identities/open/link', {
      cookie: server.admin,
      json: { password: PASSWORD },
    });
    expect(open.status).toBe(403);
    // A setting nobody sent as such is refused.
    const wrong = await server.http('PUT', '/api/v1/self-linking', {
      cookie: server.admin,
      json: { enabled: 'yes' },
    });
    expect(wrong.status).toBe(400);
  });

  it('lets only who manages users switch it', async () => {
    const server = await start();
    await server.auth.createUser({ name: 'bob', password: PASSWORD, roles: ['operator'] });
    const bob = await server.login('bob');
    expect((await server.http('GET', '/api/v1/self-linking', { cookie: bob })).status).toBe(403);
    const put = await server.http('PUT', '/api/v1/self-linking', {
      cookie: bob,
      json: { enabled: false },
    });
    expect(put.status).toBe(403);
  });
});

describe('unlinking an account from oneself', () => {
  it('unlinks, which signs the user out everywhere', async () => {
    const server = await start();
    server.auth.linkIdentity(userId(server, 'ada'), 'fake', 'sub-1');
    const answer = await server.http('DELETE', '/api/v1/me/identities/fake/sub-1', {
      cookie: server.admin,
      json: { password: PASSWORD },
    });
    expect(answer.status).toBe(204);
    expect(server.auth.listIdentities()).toEqual([]);
    expect((await server.http('GET', '/api/v1/me', { cookie: server.admin })).status).toBe(401);
  });

  it('refuses to take away the only way a user signs in', async () => {
    const server = await start();
    // Signed up through the provider: a user without a password.
    const signedIn = server.auth.externalLogin('open', { subject: 'eve-1' }, { signup: true });
    if (!signedIn.ok) throw new Error('refused');
    const answer = await server.http('DELETE', '/api/v1/me/identities/open/eve-1', {
      cookie: `mooncg_session=${signedIn.session}`,
      json: {},
    });
    expect(answer.status).toBe(409);
    expect(answer.json.error.message).toMatch(/only way you can sign in/);
    expect(server.auth.listIdentities()).toHaveLength(1);
  });

  it('does not unlink the account of someone else', async () => {
    const server = await start();
    await server.auth.createUser({ name: 'bob', password: PASSWORD, roles: [] });
    server.auth.linkIdentity(userId(server, 'bob'), 'fake', 'sub-1');
    const answer = await server.http('DELETE', '/api/v1/me/identities/fake/sub-1', {
      cookie: server.admin,
      json: { password: PASSWORD },
    });
    expect(answer.status).toBe(404);
    expect(server.auth.listIdentities()).toHaveLength(1);
  });

  it('takes the password first, as linking does, and a wrong one unlinks nothing', async () => {
    const server = await start();
    server.auth.linkIdentity(userId(server, 'ada'), 'fake', 'sub-1');
    const path = '/api/v1/me/identities/fake/sub-1';

    const missing = await server.http('DELETE', path, { cookie: server.admin, json: {} });
    expect(missing.status).toBe(400);
    const wrong = await server.http('DELETE', path, {
      cookie: server.admin,
      json: { password: 'wrong' },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.message).toMatch(/password is wrong/);
    expect(server.auth.listIdentities()).toHaveLength(1);
  });

  it('asks a user without a password for a sign-in of the last five minutes', async () => {
    const server = await start();
    const signedIn = server.auth.externalLogin('open', { subject: 'eve-1' }, { signup: true });
    if (!signedIn.ok) throw new Error('refused');
    const eve = signedIn.user.id;
    server.auth.linkIdentity(eve, 'fake', 'eve-2');
    const session = `mooncg_session=${signedIn.session}`;
    const path = '/api/v1/me/identities/fake/eve-2';

    const later = await withClock(Date.now() + 6 * 60 * 1000, () =>
      server.http('DELETE', path, { cookie: session, json: {} }),
    );
    expect(later.status).toBe(403);
    expect(later.json.error.message).toMatch(/sign in again/);
    expect(server.auth.listIdentities()).toHaveLength(2);

    const fresh = await server.http('DELETE', path, { cookie: session, json: {} });
    expect(fresh.status).toBe(204);
    expect(server.auth.listIdentities()).toHaveLength(1);
  });
});

describe('confirming the password', () => {
  it('answers 400 to a request without one, and does not count it as a wrong password', async () => {
    const server = await start();
    for (let attempt = 0; attempt < 12; attempt++) {
      const answer = await server.http('POST', '/api/v1/me/identities/fake/link', {
        cookie: server.admin,
        json: {},
      });
      expect(answer.status).toBe(400);
      expect(answer.json.error.message).toMatch(/current password/);
    }
    const { started } = await link(server, server.admin, 'sub-1');
    expect(started.status).toBe(200);
  });
});

describe('the self-linking setting', () => {
  const broken = {
    get: async () => {
      throw new Error('SQLITE_CORRUPT');
    },
    set: async () => {
      throw new Error('SQLITE_CORRUPT');
    },
  };

  it('is off when it cannot be read, even when the fallback cannot be written either', async () => {
    const linking = new SelfLinking(broken);

    // What the server does at the start.
    await linking
      .load()
      .catch(() => linking.set({ enabled: false, disabledProviders: [] }).catch(() => {}));

    expect(linking.state.enabled).toBe(false);
    expect(linking.allows('fake')).toBe(false);
  });

  it('stays off when it is read again and cannot be', async () => {
    const linking = new SelfLinking(broken);
    await expect(linking.load()).rejects.toThrow(/SQLITE_CORRUPT/);
    expect(linking.allows('fake')).toBe(false);
  });
});
