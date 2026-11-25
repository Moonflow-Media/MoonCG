import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_CSP } from '../src/http/shared.js';
import { cookiePair, type HttpAnswer, PASSWORD } from './auth-helpers.js';
import {
  FAKE_IDP,
  fakeIdpCalls,
  type ModuleServer,
  moduleManifest,
  startModuleServer,
} from './module-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

/** What the security review of milestone 8 found, as far as it shows over HTTP. */

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

const start = async (config = {}, modules: Record<string, string | object> = FAKE_IDP) => {
  context = await startModuleServer(
    temporary,
    modules,
    [Object.keys(modules)[0]?.split('/')[0] ?? ''],
    config,
  );
  return context;
};

const cookieOf = (answer: HttpAnswer, name: string) => {
  const found = answer.setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found === undefined ? undefined : cookiePair(found);
};

/** A whole sign-in as the account `code` stands for; answers the callback. */
async function signIn(server: ModuleServer, code: string, provider = 'fake') {
  const started = await server.http('GET', `/auth/${provider}/start`);
  expect(started.status).toBe(302);
  const location = new URL(started.headers.get('location') as string);
  const state = location.searchParams.get('state') as string;
  return server.http(
    'GET',
    `/auth/${provider}/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { cookie: cookieOf(started, 'mooncg_oauth') },
  );
}

const errorOf = (answer: HttpAnswer) => {
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers.get('location') as string, 'http://x');
  expect(location.pathname).toBe('/login');
  return location.searchParams.get('error');
};

/** A request with headers `fetch` will not send, such as another `Host`. */
function rawRequest(
  server: ModuleServer,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; setCookies: string[]; text: string }> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(
      { host: '127.0.0.1', port: server.server.port, path, method, headers },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            setCookies: response.headers['set-cookie'] ?? [],
            text,
          }),
        );
      },
    );
    sent.on('error', reject);
    sent.end(body);
  });
}

describe('starting sign-ins over HTTP', () => {
  it('answers 429 to an address that starts too many', async () => {
    const server = await start();
    for (let n = 0; n < 30; n++) {
      expect((await server.http('GET', '/auth/fake/start')).status, String(n)).toBe(302);
    }
    const refused = await server.http('GET', '/auth/fake/start');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.setCookies).toEqual([]);
    // The provider was not asked for the one that was refused.
    expect(fakeIdpCalls().authorize).toHaveLength(30);
  });
});

describe('the login page with providers of any name', () => {
  const NAMES = ['Pay $` now', 'Pay $& now', "Pay $' now", 'Pay $$ now', 'Pay $1 now'];
  const DOLLARS = {
    'dollars/mooncg.json': moduleManifest('dollars'),
    'dollars/index.js': `export default function setup(ctx) {
  ${JSON.stringify(NAMES)}.forEach((name, n) =>
    ctx.auth.registerProvider({
      id: 'p' + n,
      name,
      authorize: () => 'https://idp.example/',
      callback: () => ({ subject: 'x' }),
    }),
  );
}
`,
  };

  it('puts the names into the page as they are, whatever a "$" in them would mean to a replacement', async () => {
    const server = await start({}, DOLLARS);
    const page = await server.http('GET', '/login');
    expect(page.status).toBe(200);
    for (const shown of [
      'Sign in with Pay $` now</span>',
      'Sign in with Pay $&amp; now</span>',
      'Sign in with Pay $&#39; now</span>',
      'Sign in with Pay $$ now</span>',
      'Sign in with Pay $1 now</span>',
    ]) {
      expect(page.text).toContain(shown);
    }
    // Nothing of the page was copied into itself.
    expect(page.text.match(/<\/html>/g)).toHaveLength(1);
    expect(page.text.match(/<form/g)).toHaveLength(1);
    expect(page.text.match(/class="providers"/g)).toHaveLength(1);
    expect(page.text).not.toContain('<!-- providers -->');
  });
});

describe('what a route of a module answers', () => {
  const PAGES = {
    'pages/mooncg.json': moduleManifest('pages'),
    'pages/index.js': `export default function setup(ctx) {
  ctx.http.register({
    method: 'GET',
    path: '/page',
    public: true,
    handler: (request) => ({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<p>' + (request.query.q ?? '') + '</p>',
    }),
  });
  ctx.http.register({
    method: 'GET',
    path: '/own',
    public: true,
    handler: () => ({
      headers: { 'Content-Security-Policy': "default-src 'self'", 'content-type': 'text/html' },
      body: '<p>own</p>',
    }),
  });
  ctx.http.register({
    method: 'GET',
    path: '/headers',
    public: true,
    handler: (request) => ({ body: { headers: Object.keys(request.headers).sort() } }),
  });
  ctx.http.register({
    method: 'GET',
    path: '/boom',
    public: true,
    handler: () => {
      throw new Error('broke');
    },
  });
}
`,
  };

  it('carries a restrictive policy unless the handler sets its own', async () => {
    const server = await start({}, PAGES);
    const page = await server.http('GET', '/m/pages/page?q=%3Cscript%3Ealert(1)%3C/script%3E');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<script>');
    // Whatever the page holds, a browser runs nothing of it as this server.
    expect(page.headers.get('content-security-policy')).toBe(ASSET_CSP);
    expect(ASSET_CSP).toContain('sandbox');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const own = await server.http('GET', '/m/pages/own');
    expect(own.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(own.headers.get('x-content-type-options')).toBe('nosniff');

    const json = await server.http('GET', '/m/pages/headers');
    expect(json.headers.get('content-security-policy')).toBe(ASSET_CSP);
    const failed = await server.http('GET', '/m/pages/boom');
    expect(failed.status).toBe(500);
    expect(failed.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never shows a handler the credentials of the caller, also not those for a proxy', async () => {
    const server = await start({}, PAGES);
    const answer = await server.http('GET', '/m/pages/headers', {
      cookie: server.admin,
      headers: {
        'proxy-authorization': 'Basic c2VjcmV0OnNlY3JldA==',
        authorization: 'Bearer nothing',
        'x-kept': 'yes',
      },
    });
    expect(answer.json.headers).toContain('x-kept');
    expect(answer.json.headers).not.toContain('proxy-authorization');
    expect(answer.json.headers).not.toContain('authorization');
    expect(answer.json.headers).not.toContain('cookie');
  });

  it('holds for the routes of bundles as well', async () => {
    const server = await start({}, PAGES);
    const answer = await server.http('GET', '/b/board/api/public', {
      cookie: server.admin,
      headers: { 'proxy-authorization': 'Basic c2VjcmV0OnNlY3JldA==', 'x-kept': 'yes' },
    });
    expect(answer.status).toBe(200);
    expect(answer.json.headers).toContain('x-kept');
    expect(answer.json.headers).not.toContain('proxy-authorization');
  });
});

describe('an https public address without a trusted proxy', () => {
  const PUBLIC = { publicUrl: 'https://show.example' };
  const HOST = { host: 'show.example' };

  it('sets the cookie of a started sign-in as a secure one', async () => {
    const server = await start(PUBLIC);
    const started = await rawRequest(server, 'GET', '/auth/fake/start', HOST);
    expect(started.status).toBe(302);
    const [cookie = ''] = started.setCookies;
    expect(cookie).toMatch(/^__Host-mooncg_oauth=/);
    expect(cookie).toMatch(/; Secure/);
  });

  it('sets the session cookie as a secure one, for a password and for an external account', async () => {
    const server = await start(PUBLIC);
    const body = JSON.stringify({ username: 'ada', password: PASSWORD });
    const json = { 'content-type': 'application/json' };
    const login = await rawRequest(
      server,
      'POST',
      '/api/v1/auth/login',
      { ...HOST, ...json, origin: 'https://show.example' },
      body,
    );
    expect(login.status).toBe(200);
    const [session = ''] = login.setCookies;
    expect(session).toMatch(/^__Host-mooncg_session=/);
    expect(session).toMatch(/; Secure/);
    // The cookie is read back under the name it was set with.
    const me = await rawRequest(server, 'GET', '/api/v1/me', {
      ...HOST,
      cookie: cookiePair(session),
    });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.text).user.name).toBe('ada');
    // The address is HTTPS, so a page that came over plain HTTP is another origin.
    const plain = await rawRequest(
      server,
      'POST',
      '/api/v1/auth/login',
      { ...HOST, ...json, origin: 'http://show.example' },
      body,
    );
    expect(plain.status).toBe(403);

    // The same for the session an external sign-in opens.
    const ada = server.auth.findUser('ada');
    server.auth.linkIdentity(ada?.id ?? '', 'fake', 'sub-1');
    const started = await rawRequest(server, 'GET', '/auth/fake/start', HOST);
    const asked = fakeIdpCalls().authorize.at(-1) as { redirectUri: string; state: string };
    expect(new URL(asked.redirectUri).origin).toBe('https://show.example');
    const back = await rawRequest(
      server,
      'GET',
      `/auth/fake/callback?state=${asked.state}&code=sub-1`,
      { ...HOST, cookie: cookiePair(started.setCookies[0] ?? '') },
    );
    expect(back.status).toBe(302);
    const opened = back.setCookies.find((cookie) => cookie.includes('mooncg_session')) ?? '';
    expect(opened).toMatch(/^__Host-mooncg_session=/);
    expect(opened).toMatch(/; Secure/);
  });

  it('opens a socket for a page of the https address, and for no page of the http one', async () => {
    const server = await start(PUBLIC);
    const login = await rawRequest(
      server,
      'POST',
      '/api/v1/auth/login',
      { ...HOST, 'content-type': 'application/json', origin: 'https://show.example' },
      JSON.stringify({ username: 'ada', password: PASSWORD }),
    );
    const cookie = cookiePair(login.setCookies[0] ?? '');
    expect(await server.upgrade({ ...HOST, cookie, origin: 'https://show.example' })).toBe(101);
    expect(await server.upgrade({ ...HOST, cookie, origin: 'http://show.example' })).toBe(403);
  });

  it('changes nothing for a request that came under another name', async () => {
    const server = await start(PUBLIC);
    const login = await server.http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.setCookies[0]).toMatch(/^mooncg_session=/);
    expect(login.setCookies[0]).not.toMatch(/Secure/);
  });

  it('says at the start what a plain http public address means, and nothing for an https one', async () => {
    const plain = await start({ publicUrl: 'http://192.168.1.20:9090' });
    const warned = plain.lines.filter((line) => line.includes('http://192.168.1.20:9090'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^WARN .*unencrypted/);
    await plain.server.close();
    const secure = await start(PUBLIC);
    expect(secure.lines.some((line) => line.includes('unencrypted'))).toBe(false);
  });
});

describe('links, realms and the log', () => {
  it('links a refused account for the realm it came from, and refuses it from another', async () => {
    const server = await start();
    const bob = await server.auth.createUser({ name: 'bob', password: PASSWORD, roles: [] });
    expect(errorOf(await signIn(server, 'acct-9|Zed|https://id.example'))).toBe('not_linked');
    const before = await server.http('GET', '/api/v1/identities', { cookie: server.admin });
    expect(before.json.unlinked).toMatchObject([
      { provider: 'fake', subject: 'acct-9', realm: 'https://id.example', name: 'Zed' },
    ]);

    const linked = await server.http('PUT', `/api/v1/users/${bob.id}/identities/fake`, {
      cookie: server.admin,
      json: { subject: 'acct-9' },
    });
    expect(linked.status).toBe(204);
    const after = await server.http('GET', '/api/v1/identities', { cookie: server.admin });
    expect(after.json.identities).toEqual([
      { userId: bob.id, provider: 'fake', subject: 'acct-9', realm: 'https://id.example' },
    ]);
    expect(after.json.unlinked).toEqual([]);
    expect(
      server.lines.some((line) =>
        /^INFO .*ada linked the account of "fake" \(subject "acct-9"\) to the user "bob", for the realm "https:\/\/id\.example"/.test(
          line,
        ),
      ),
    ).toBe(true);

    const signedIn = await signIn(server, 'acct-9|Zed|https://id.example');
    expect(signedIn.headers.get('location')).toBe('/');
    expect(
      server.lines.some((line) =>
        /^INFO .*"bob" signed in with "fake" \(subject "acct-9"\) from 127\.0\.0\.1/.test(line),
      ),
    ).toBe(true);

    // The provider id now stands for another issuer, where "acct-9" is somebody else.
    const elsewhere = await signIn(server, 'acct-9|Zed|https://evil.example');
    expect(errorOf(elsewhere)).toBe('realm');
    expect(elsewhere.setCookies.some((cookie) => cookie.startsWith('mooncg_session='))).toBe(false);
    expect(
      server.lines.some((line) =>
        /^WARN .*"https:\/\/id\.example".*"https:\/\/evil\.example"/.test(line),
      ),
    ).toBe(true);
    // The page a browser ends on has words for it.
    expect((await server.http('GET', '/auth.js')).text).toMatch(/\brealm:/);

    const unlinked = await server.http('DELETE', `/api/v1/users/${bob.id}/identities/fake/acct-9`, {
      cookie: server.admin,
      headers: { 'x-mooncg-csrf': '1' },
    });
    expect(unlinked.status).toBe(204);
    expect(
      server.lines.some((line) =>
        /^INFO .*ada unlinked the account of "fake" \(subject "acct-9"\) from the user "bob"/.test(
          line,
        ),
      ),
    ).toBe(true);
  });

  it('takes the realm a link names, and binds one without at the first sign-in', async () => {
    const server = await start();
    const ada = server.auth.findUser('ada');
    const put = (body: object) =>
      server.http('PUT', `/api/v1/users/${ada?.id}/identities/fake`, {
        cookie: server.admin,
        json: body,
      });
    expect((await put({ subject: 'a1', realm: 'https://named.example' })).status).toBe(204);
    expect((await put({ subject: 'a2' })).status).toBe(204);
    expect((await put({ subject: 'a3', realm: 5 })).status).toBe(400);
    expect((await put({ subject: 'a3', realm: '' })).status).toBe(400);
    const realms = () =>
      Object.fromEntries(
        server.auth.listIdentities().map((identity) => [identity.subject, identity.realm]),
      );
    expect(realms()).toEqual({ a1: 'https://named.example', a2: undefined });
    expect(errorOf(await signIn(server, 'a1||https://other.example'))).toBe('realm');
    expect((await signIn(server, 'a2||https://first.example')).headers.get('location')).toBe('/');
    expect(realms()).toEqual({ a1: 'https://named.example', a2: 'https://first.example' });
    expect(errorOf(await signIn(server, 'a2||https://second.example'))).toBe('realm');
  });
});

describe('folders in the modules folder that cannot be modules', () => {
  it('lists them as failed, by a name that can be shown, and starts none', async () => {
    const reordering = `x${String.fromCodePoint(0x202e)}gnp`;
    const server = await start(
      {},
      {
        'good/mooncg.json': moduleManifest('good'),
        'good/index.js': 'export default function setup() {}',
        'Bad Name/mooncg.json': moduleManifest('bad-name'),
        'Bad Name/index.js': 'export default function setup() { globalThis.__badName = true; }',
        [`${reordering}/mooncg.json`]: moduleManifest('x'),
      },
    );
    const answer = await server.http('GET', '/api/v1/modules', { cookie: server.admin });
    const modules = answer.json.modules as { name: string; state: string; error?: string }[];
    expect(modules.find((module) => module.name === 'good')?.state).toBe('running');
    const bad = modules.find((module) => module.name === 'Bad Name');
    expect(bad).toMatchObject({ state: 'failed', enabled: false });
    expect(bad?.error).toMatch(/invalid name/i);
    // What draws nothing is written out: the name reads as no other, also not as "xgnp".
    const backslash = String.fromCodePoint(0x5c);
    const hidden = modules.find((module) => module.name === `x${backslash}u{202e}gnp`);
    expect(hidden).toMatchObject({ state: 'failed' });
    expect(answer.text.includes(String.fromCodePoint(0x202e))).toBe(false);
    expect(modules.some((module) => module.name === 'xgnp')).toBe(false);
    expect(server.lines.some((line) => /^WARN .*"Bad Name".*invalid name/i.test(line))).toBe(true);
    // Nothing reaches it by that name.
    const enabled = await server.http('POST', '/api/v1/modules/Bad%20Name/enable', {
      cookie: server.admin,
      json: {},
    });
    expect(enabled.status).toBe(404);
    expect((globalThis as { __badName?: boolean }).__badName).toBeUndefined();
  });
});
