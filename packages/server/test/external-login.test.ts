import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { cookiePair, type HttpAnswer, PASSWORD, startAuthServer } from './auth-helpers.js';
import {
  FAKE_IDP,
  fakeIdpCalls,
  type ModuleServer,
  moduleManifest,
  startModuleServer,
} from './module-helpers.js';
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

const start = async (config = {}, options = {}) => {
  context = await startModuleServer(temporary, FAKE_IDP, ['fake-idp'], config, options);
  return context;
};

/** The cookie a `Set-Cookie` list sets under a name, as `name=value`; `undefined` if none. */
const cookieOf = (answer: HttpAnswer, name: string) => {
  const found = answer.setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found === undefined ? undefined : cookiePair(found);
};

/** Starts a sign-in: what the browser would hold and where it would be sent. */
async function begin(server: ModuleServer, provider = 'fake', query = '') {
  const answer = await server.http('GET', `/auth/${provider}/start${query}`);
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers.get('location') as string);
  return {
    answer,
    location,
    state: location.searchParams.get('state') as string,
    cookie: cookieOf(answer, 'mooncg_oauth') as string,
  };
}

/** Comes back from the provider as the account `code` stands for. */
const finish = (
  server: ModuleServer,
  flow: { state: string; cookie: string | undefined },
  code: string,
  provider = 'fake',
) =>
  server.http(
    'GET',
    `/auth/${provider}/callback?state=${encodeURIComponent(flow.state)}&code=${encodeURIComponent(code)}`,
    { cookie: flow.cookie },
  );

const errorOf = (answer: HttpAnswer) => {
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers.get('location') as string, 'http://x');
  expect(location.pathname).toBe('/login');
  return location.searchParams.get('error');
};

describe('the login page', () => {
  it('has a plain link per provider, with the name escaped and the icon served here', async () => {
    const server = await start();
    const page = await server.http('GET', '/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('href="/auth/fake/start"');
    expect(page.text).toContain('href="/auth/open/start"');
    expect(page.text).toContain('Fake &lt;b&gt;&amp;&quot;ID&quot;');
    expect(page.text).not.toContain('<b>&');
    expect(page.text).toContain('src="/auth/fake/icon"');
    // Links, not forms: the policy lets forms post back here only, and a provider is elsewhere.
    expect(page.text.match(/<form/g)).toHaveLength(1);
    expect(page.headers.get('content-security-policy')).toBe(
      "default-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    // The password form is still there.
    expect(page.text).toContain('data-action="/api/v1/auth/login"');
  });

  it('has none without a provider', async () => {
    context = await startModuleServer(temporary, FAKE_IDP);
    const page = await context.http('GET', '/login');
    expect(page.text).not.toContain('href="/auth/');
    expect(page.text).not.toContain('class="providers"');
  });

  it('serves the icon of a provider from the folder of its module, as an image and nothing else', async () => {
    const server = await start();
    const icon = await server.http('GET', '/auth/fake/icon');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(icon.headers.get('content-security-policy')).toContain('sandbox');
    expect((await server.http('GET', '/auth/nope/icon')).status).toBe(404);
  });

  it('tells who can sign in how', async () => {
    const server = await start();
    const answer = await server.http('GET', '/api/v1/auth/providers');
    expect(answer.json).toEqual({
      providers: [
        { id: 'local', kind: 'password', name: 'Password' },
        { id: 'fake', kind: 'redirect', name: 'Fake <b>&"ID"', icon: '/auth/fake/icon' },
        { id: 'open', kind: 'redirect', name: 'Open', icon: '/auth/open/icon' },
      ],
    });
  });
});

describe('starting an external sign-in', () => {
  it('sends the browser to the provider with a state bound to a cookie of this browser', async () => {
    const server = await start();
    const { answer, location, state } = await begin(server);
    expect(location.origin).toBe('https://idp.example');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [cookie] = answer.setCookies;
    expect(cookie).toMatch(
      /^mooncg_oauth=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    // The cookie is not the state: whoever sees the address has not seen the cookie.
    expect(cookie).not.toContain(state);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const [asked] = fakeIdpCalls().authorize;
    expect(asked?.state).toBe(state);
    expect(asked?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(asked?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(asked?.redirectUri).toBe(`http://127.0.0.1:${server.server.port}/auth/fake/callback`);
  });

  it('answers 404 for a provider that is not there', async () => {
    const server = await start();
    expect((await server.http('GET', '/auth/nope/start')).status).toBe(404);
    expect((await server.http('GET', '/auth/local/start')).status).toBe(404);
    expect((await server.http('GET', '/auth/nope/callback?state=x&code=y')).status).toBe(404);
  });

  it('never builds the address to come back to from what a request says', async () => {
    const server = await start();
    for (const host of ['evil.example', `evil.example:${server.server.port}`, '127.0.0.1:1']) {
      const answer = await server.raw('/auth/fake/start', { host });
      expect(answer.status, host).toBe(302);
      expect(answer.headers.location, host).toBe('/login?error=address');
    }
    const forwarded = await server.raw('/auth/fake/start', {
      host: `127.0.0.1:${server.server.port}`,
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(forwarded.status).toBe(302);
    expect(fakeIdpCalls().authorize.map((call) => call.redirectUri)).toEqual([
      `http://127.0.0.1:${server.server.port}/auth/fake/callback`,
    ]);
  });

  it('uses the configured public address, and only for requests that came to it', async () => {
    const server = await start({ publicUrl: 'https://show.example', trustProxy: true });
    const there = await server.raw('/auth/fake/start', {
      host: 'show.example',
      'x-forwarded-proto': 'https',
    });
    expect(there.status).toBe(302);
    expect(fakeIdpCalls().authorize[0]?.redirectUri).toBe(
      'https://show.example/auth/fake/callback',
    );
    // Over HTTPS the cookie is Secure and carries the prefix, like the session cookie.
    expect(String(there.headers['set-cookie'])).toMatch(/^__Host-mooncg_oauth=.*; Secure$/);
    // Asked for under another name, the cookie would be set for that name and never come back.
    const elsewhere = await server.raw('/auth/fake/start', { host: 'other.example' });
    expect(elsewhere.headers.location).toBe('/login?error=address');
    expect(fakeIdpCalls().authorize).toHaveLength(1);
  });
});

describe('coming back from the provider', () => {
  it('signs in the user the account is linked to, with the session a password gives', async () => {
    const server = await start();
    const ada = server.auth.findUser('ada');
    server.auth.linkIdentity(ada?.id as string, 'fake', 'sub-1');
    const flow = await begin(server);
    const answer = await finish(server, flow, 'sub-1|whoever');
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe('/');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const local = await server.http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: PASSWORD },
    });
    const flags = (cookie: string | undefined) => cookie?.replace(/=[^;]*/, '=…');
    const session = answer.setCookies.find((cookie) => cookie.startsWith('mooncg_session='));
    expect(flags(session)).toBe(flags(local.setCookies[0]));
    // The cookie of the flow is used up and taken away.
    expect(answer.setCookies).toContainEqual(
      'mooncg_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
    const me = await server.http('GET', '/api/v1/me', { cookie: cookiePair(session as string) });
    expect(me.json.user.name).toBe('ada');
    expect(me.json.roles).toEqual(['admin']);
    // What the provider got: the code, the nonce, and the verifier of the challenge.
    const [asked] = fakeIdpCalls().authorize;
    const [redeemed] = fakeIdpCalls().callback;
    expect(redeemed?.query).toEqual({ code: 'sub-1|whoever' });
    expect(redeemed?.nonce).toBe(asked?.nonce);
    expect(redeemed?.redirectUri).toBe(asked?.redirectUri);
    expect(
      createHash('sha256')
        .update(redeemed?.codeVerifier as string)
        .digest('base64url'),
    ).toBe(asked?.codeChallenge);
  });

  it('refuses a state that is not the one this browser was given', async () => {
    const server = await start();
    const flow = await begin(server);
    const other = await begin(server);
    for (const attempt of [
      { state: 'x'.repeat(43), cookie: flow.cookie },
      { state: other.state, cookie: flow.cookie },
      { state: '', cookie: other.cookie },
    ]) {
      expect(errorOf(await finish(server, attempt, 'sub-1|x'))).toBe('state');
    }
    expect(fakeIdpCalls().callback).toEqual([]);
  });

  it('refuses a state without the cookie it belongs to, and the cookie of another flow', async () => {
    const server = await start();
    const flow = await begin(server);
    expect(errorOf(await finish(server, { state: flow.state, cookie: undefined }, 'a|b'))).toBe(
      'state',
    );
    const again = await begin(server);
    expect(
      errorOf(await finish(server, { state: again.state, cookie: 'mooncg_oauth=made-up' }, 'a|b')),
    ).toBe('state');
    expect(fakeIdpCalls().callback).toEqual([]);
  });

  it('accepts a state once', async () => {
    const server = await start();
    const ada = server.auth.findUser('ada');
    server.auth.linkIdentity(ada?.id as string, 'fake', 'sub-1');
    const flow = await begin(server);
    expect((await finish(server, flow, 'sub-1|x')).headers.get('location')).toBe('/');
    expect(errorOf(await finish(server, flow, 'sub-1|x'))).toBe('state');
    expect(fakeIdpCalls().callback).toHaveLength(1);
  });

  it('uses a state up even when the attempt with it fails', async () => {
    const server = await start();
    const flow = await begin(server);
    expect(errorOf(await finish(server, { ...flow, state: 'wrong' }, 'sub-1|x'))).toBe('state');
    expect(errorOf(await finish(server, flow, 'sub-1|x'))).toBe('state');
  });

  it('does not take the state of one provider for another', async () => {
    const server = await start();
    const flow = await begin(server, 'fake');
    expect(errorOf(await finish(server, flow, 'sub-9|eve', 'open'))).toBe('state');
    expect(server.auth.listUsers()).toHaveLength(1);
  });

  it('refuses an account nobody linked, and lets an administrator see who tried', async () => {
    const server = await start();
    const answer = await finish(server, await begin(server), 'sub-7|ada');
    expect(errorOf(answer)).toBe('not_linked');
    expect(answer.setCookies.some((cookie) => cookie.startsWith('mooncg_session='))).toBe(false);
    expect(server.auth.listUsers().map((user) => user.name)).toEqual(['ada']);
    const listed = await server.http('GET', '/api/v1/identities', { cookie: server.admin });
    expect(listed.json.unlinked).toEqual([
      { provider: 'fake', subject: 'sub-7', name: 'ada', at: expect.any(String) },
    ]);
  });

  it('creates a user without any role where the provider allows signing up', async () => {
    const server = await start();
    const answer = await finish(server, await begin(server, 'open'), 'sub-7|ada', 'open');
    expect(answer.headers.get('location')).toBe('/');
    const session = cookieOf(answer, 'mooncg_session');
    const me = await server.http('GET', '/api/v1/me', { cookie: session });
    // Not the administrator of that name: a user of its own, who holds nothing.
    expect(me.json.user.name).toBe('ada-2');
    expect(me.json.roles).toEqual([]);
    expect(me.json.permissions).toEqual([]);
    expect((await server.http('GET', '/api/v1/bundles', { cookie: session })).status).toBe(403);
  });

  it('refuses a disabled user', async () => {
    const server = await start();
    const bob = await server.auth.createUser({ name: 'bob', password: PASSWORD });
    server.auth.linkIdentity(bob.id, 'fake', 'sub-2');
    server.auth.updateUser(bob.id, { disabled: true });
    expect(errorOf(await finish(server, await begin(server), 'sub-2|bob'))).toBe('disabled');
  });

  it('refuses when the provider does, and tells the browser nothing of why', async () => {
    const server = await start();
    const answer = await finish(server, await begin(server), 'boom');
    expect(errorOf(answer)).toBe('provider');
    expect(answer.headers.get('location')).not.toContain('hunter2');
    expect(server.lines.some((line) => /fake.*The provider said no/.test(line))).toBe(true);
    // The server is still there.
    expect((await server.http('GET', '/login')).status).toBe(200);
  });

  it('refuses when the provider answers with no subject', async () => {
    const server = await start();
    expect(errorOf(await finish(server, await begin(server, 'open'), '|name', 'open'))).toBe(
      'provider',
    );
    expect(server.auth.listUsers()).toHaveLength(1);
  });

  it('is a GET the state protects; nothing else is taken', async () => {
    const server = await start();
    const flow = await begin(server);
    const posted = await server.http('POST', `/auth/fake/callback?state=${flow.state}&code=a`, {
      cookie: flow.cookie,
      json: {},
    });
    expect(posted.status).toBe(404);
  });

  it('slows down whoever keeps coming back with states that are none', async () => {
    const server = await start();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      const answer = await finish(server, { state: 'x', cookie: 'mooncg_oauth=y' }, 'a|b');
      statuses.push(answer.status);
    }
    expect(statuses.slice(0, 19).every((status) => status === 302)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const last = await finish(server, { state: 'x', cookie: 'mooncg_oauth=y' }, 'a|b');
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('where the browser goes afterwards', () => {
  it('goes to a path of this server that was asked for, and nowhere else', async () => {
    const server = await start();
    const ada = server.auth.findUser('ada');
    server.auth.linkIdentity(ada?.id as string, 'fake', 'sub-1');
    const landing = async (returnTo: string) => {
      const flow = await begin(server, 'fake', `?returnTo=${encodeURIComponent(returnTo)}`);
      return (await finish(server, flow, 'sub-1|x')).headers.get('location');
    };
    expect(await landing('/w/Show?tab=1#top')).toBe('/w/Show?tab=1#top');
    for (const abuse of [
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example',
      '\\\\evil.example',
      '/..//evil.example',
      '/%2e%2e//evil.example',
      'javascript:alert(1)',
      ' /x',
      '/x\n//evil.example',
      'w/Show',
    ]) {
      const location = await landing(abuse);
      expect(new URL(location as string, 'http://mooncg.test').origin, abuse).toBe(
        'http://mooncg.test',
      );
      expect(location?.startsWith('//'), abuse).toBe(false);
    }
    expect(await landing('https://evil.example/')).toBe('/');
  });
});

describe('linking accounts through the API', () => {
  it('links and unlinks, for holders of system:users.manage', async () => {
    const server = await start();
    const { http, admin, auth } = server;
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD, roles: ['viewer'] });
    const linked = await http('PUT', `/api/v1/users/${bob.id}/identities/fake`, {
      cookie: admin,
      json: { subject: 'sub-3' },
    });
    expect(linked.status).toBe(204);
    const listed = await http('GET', '/api/v1/identities', { cookie: admin });
    expect(listed.json.identities).toEqual([
      { userId: bob.id, provider: 'fake', subject: 'sub-3' },
    ]);
    expect(listed.json.providers).toEqual([
      { id: 'fake', name: 'Fake <b>&"ID"' },
      { id: 'open', name: 'Open' },
    ]);
    const signedIn = await finish(server, await begin(server), 'sub-3|x');
    const session = cookieOf(signedIn, 'mooncg_session');
    expect((await http('GET', '/api/v1/me', { cookie: session })).json.user.name).toBe('bob');

    const unlinked = await http('DELETE', `/api/v1/users/${bob.id}/identities/fake/sub-3`, {
      cookie: admin,
      json: {},
    });
    expect(unlinked.status).toBe(204);
    // Unlinking signs out whoever came in through the link.
    expect((await http('GET', '/api/v1/me', { cookie: session })).status).toBe(401);
    expect(errorOf(await finish(server, await begin(server), 'sub-3|x'))).toBe('not_linked');
  });

  it('forgets an attempt once its account is linked', async () => {
    const server = await start();
    const { http, admin, auth } = server;
    await finish(server, await begin(server), 'sub-7|someone');
    const ada = auth.findUser('ada');
    await http('PUT', `/api/v1/users/${ada?.id}/identities/fake`, {
      cookie: admin,
      json: { subject: 'sub-7' },
    });
    expect((await http('GET', '/api/v1/identities', { cookie: admin })).json.unlinked).toEqual([]);
  });

  it('refuses whoever may not manage users, and a request that was not meant', async () => {
    const server = await start();
    const { http, admin, auth, login } = server;
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD, roles: ['viewer'] });
    const viewer = await login('bob');
    const path = `/api/v1/users/${bob.id}/identities/fake`;
    expect((await http('PUT', path, { json: { subject: 's' } })).status).toBe(401);
    expect((await http('PUT', path, { cookie: viewer, json: { subject: 's' } })).status).toBe(403);
    expect((await http('GET', '/api/v1/identities', { cookie: viewer })).status).toBe(403);
    const forged = await http('PUT', path, {
      cookie: admin,
      body: 'subject=s',
      headers: { 'content-type': 'text/plain' },
    });
    expect(forged.status).toBe(403);
    expect(auth.listIdentities()).toEqual([]);
  });

  it('lets nobody take over a user who holds more than they do', async () => {
    const server = await start();
    const { http, auth, login } = server;
    auth.createRole('helpdesk', ['system:users.manage', 'system:dashboard.view']);
    await auth.createUser({ name: 'hal', password: PASSWORD, roles: ['helpdesk'] });
    const hal = await login('hal');
    const ada = auth.findUser('ada');
    // Linking an account to the administrator would make whoever has that account one.
    const answer = await http('PUT', `/api/v1/users/${ada?.id}/identities/fake`, {
      cookie: hal,
      json: { subject: 'hals-own-account' },
    });
    expect(answer.status).toBe(403);
    expect(auth.listIdentities()).toEqual([]);
  });

  it('answers with what went wrong', async () => {
    const server = await start();
    const { http, admin, auth } = server;
    const ada = auth.findUser('ada');
    const bob = await auth.createUser({ name: 'bob', password: PASSWORD });
    const put = (user: string, provider: string, subject: unknown) =>
      http('PUT', `/api/v1/users/${user}/identities/${provider}`, {
        cookie: admin,
        json: { subject },
      });
    expect((await put(ada?.id as string, 'fake', 'sub-1')).status).toBe(204);
    expect((await put(bob.id, 'fake', 'sub-1')).status).toBe(409);
    expect((await put(bob.id, 'local', bob.id)).status).toBe(400);
    expect((await put(bob.id, 'fake', 5)).status).toBe(400);
    expect((await put('nobody', 'fake', 'sub-2')).status).toBe(404);
    // A provider nobody registered: most likely a typing mistake.
    expect((await put(bob.id, 'fakee', 'sub-2')).status).toBe(404);
    const gone = await http('DELETE', `/api/v1/users/${bob.id}/identities/fake/sub-1`, {
      cookie: admin,
      json: {},
    });
    expect(gone.status).toBe(404);
  });

  it('still unlinks an account of a provider that is gone', async () => {
    const server = await start();
    const { http, admin, auth } = server;
    const ada = auth.findUser('ada');
    auth.linkIdentity(ada?.id as string, 'retired', 'sub-1');
    const gone = await http('DELETE', `/api/v1/users/${ada?.id}/identities/retired/sub-1`, {
      cookie: admin,
      json: {},
    });
    expect(gone.status).toBe(204);
  });
});

describe('what external sign-in is no way around', () => {
  it('signs nobody in or up while the installation has no user', async () => {
    const storage = memoryStorage();
    await storage.modules.setEnabled('fake-idp', true);
    const modulesDir = await temporary.create(FAKE_IDP);
    const bare = await startAuthServer(temporary, { modulesDir }, { storage });
    try {
      const started = await bare.http('GET', '/auth/open/start');
      const location = new URL(started.headers.get('location') as string);
      const cookie = cookieOf(started, 'mooncg_oauth');
      const answer = await bare.http(
        'GET',
        `/auth/open/callback?state=${location.searchParams.get('state')}&code=sub-1|eve`,
        { cookie },
      );
      expect(errorOf(answer)).toBe('setup');
      expect(bare.auth.listUsers()).toEqual([]);
      // The setup is still on offer, and still works.
      expect(bare.server.setupUrl).toBeDefined();
      expect((await bare.http('GET', '/setup')).status).toBe(200);
    } finally {
      await bare.server.close();
    }
  });

  it('cannot link the user of dev mode', async () => {
    const server = await start({ dev: true, watch: false });
    const dev = server.auth.listUsers().find((user) => user.devMode);
    const answer = await server.http('PUT', `/api/v1/users/${dev?.id}/identities/fake`, {
      cookie: server.admin,
      json: { subject: 'sub-1' },
    });
    expect(answer.status).toBe(409);
    expect(server.auth.listIdentities()).toEqual([]);
  });

  it('is gone when its module is disabled: no button, no start, and no way back in', async () => {
    const server = await start();
    const flow = await begin(server);
    await server.http('POST', '/api/v1/modules/fake-idp/disable', {
      cookie: server.admin,
      json: {},
    });
    expect((await server.http('GET', '/login')).text).not.toContain('href="/auth/');
    expect((await server.http('GET', '/auth/fake/start')).status).toBe(404);
    expect((await finish(server, flow, 'sub-1|x')).status).toBe(404);
  });

  it('survives a provider whose authorize throws', async () => {
    context = await startModuleServer(
      temporary,
      {
        'bad/mooncg.json': moduleManifest('bad'),
        'bad/index.js': `export default (ctx) => ctx.auth.registerProvider({
  id: 'bad',
  name: 'Bad',
  authorize() { throw new Error('No address today'); },
  callback() { throw new Error('never'); },
});`,
      },
      ['bad'],
    );
    const answer = await context.http('GET', '/auth/bad/start');
    expect(errorOf(answer)).toBe('provider');
    expect(answer.setCookies).toEqual([]);
    expect((await context.http('GET', '/login')).status).toBe(200);
  });

  it('sends the browser only to an http(s) address, whatever a provider answers', async () => {
    context = await startModuleServer(
      temporary,
      {
        'odd/mooncg.json': moduleManifest('odd'),
        'odd/index.js': `export default (ctx) => ctx.auth.registerProvider({
  id: 'odd',
  name: 'Odd',
  authorize: () => 'javascript:alert(1)',
  callback: () => ({ subject: 'x' }),
});`,
      },
      ['odd'],
    );
    expect(errorOf(await context.http('GET', '/auth/odd/start'))).toBe('provider');
  });
});
