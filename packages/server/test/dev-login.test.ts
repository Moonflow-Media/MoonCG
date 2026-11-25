import type { IncomingMessage } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAuth } from '../src/auth/auth.js';
import {
  createIdentify,
  devLinkTarget,
  devLoginAllowed,
  devLoginHeldBack,
} from '../src/http/identity.js';
import { attachWebSocket } from '../src/http/ws.js';
import type { ServerConfig } from '../src/kernel/config.js';
import type { ServerOptions } from '../src/server.js';
import { startServer } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { type AuthServer, CHEAP, PASSWORD, startAuthServer } from './auth-helpers.js';
import { memoryLogger, testConfig } from './helpers.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: AuthServer | undefined;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  await context?.server.close();
  context = undefined;
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

async function start(
  dev: boolean,
  options: Partial<ServerOptions> = {},
  config: Partial<ServerConfig> = {},
): Promise<AuthServer> {
  context = await startAuthServer(temporary, { dev, ...config }, options);
  return context;
}

/** A store that outlives the servers started on it, as the database of an installation does. */
function lastingStorage() {
  const storage = memoryStorage();
  cleanup.push(() => storage.close());
  return { ...storage, close: async () => {} };
}

/** A GET with headers `fetch` would not let through, such as another `Host`. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

describe('devLoginAllowed', () => {
  const request = (remoteAddress: string | undefined, headers: Record<string, string>) =>
    ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

  it.each([
    ['127.0.0.1', 'localhost:9090'],
    ['::1', '[::1]:9090'],
    ['::ffff:127.0.0.1', '127.0.0.1:9090'],
    ['127.0.0.1', 'localhost'],
  ])('lets a request from %s for %s in', (address, host) => {
    expect(devLoginAllowed(request(address, { host }))).toBe(true);
  });

  it.each([
    ['192.168.1.20', 'localhost:9090'],
    ['10.0.0.5', '127.0.0.1:9090'],
    [undefined, 'localhost:9090'],
    ['::ffff:192.168.1.20', 'localhost:9090'],
  ])('keeps a request from the socket address %s out', (address, host) => {
    expect(devLoginAllowed(request(address, { host }))).toBe(false);
  });

  it.each(['evil.example:9090', 'evil.example', '127.0.0.1.nip.io:9090', ''])(
    'keeps a request for the host "%s" out, though it comes from this machine',
    (host) => {
      expect(devLoginAllowed(request('127.0.0.1', { host }))).toBe(false);
    },
  );

  it('keeps a request without a Host header out', () => {
    expect(devLoginAllowed(request('127.0.0.1', {}))).toBe(false);
  });

  it.each([
    'http://localhost:9090',
    'http://127.0.0.1:5173',
    'http://[::1]:3000',
    'https://localhost:8443',
  ])('lets a page of this machine in (Origin: %s)', (origin) => {
    const headers = { host: 'localhost:9090', origin };
    expect(devLoginAllowed(request('127.0.0.1', headers))).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://192.168.1.20:9090',
    'http://localhost.evil.example',
    'http://127.0.0.1.nip.io:9090',
    'http://localhost:9090, https://evil.example',
    'null',
    '',
  ])(
    'keeps the page of another site out, though it comes from this machine (Origin: "%s")',
    (origin) => {
      const headers = { host: 'localhost:9090', origin };
      expect(devLoginAllowed(request('127.0.0.1', headers))).toBe(false);
    },
  );

  it.each([
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'forwarded',
    'via',
  ])('keeps a request out that a proxy passed on (%s)', (header) => {
    const headers = { host: 'localhost:9090', [header]: '127.0.0.1' };
    expect(devLoginAllowed(request('127.0.0.1', headers))).toBe(false);
  });
});

describe('devLoginAllowed and what the browser says caused a request', () => {
  const request = (headers: Record<string, string>) =>
    ({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:9090', ...headers },
    }) as unknown as IncomingMessage;

  it.each(['none', 'same-origin', 'same-site'])(
    'lets a request in that states no Origin and Sec-Fetch-Site: %s',
    (site) => {
      expect(devLoginAllowed(request({ 'sec-fetch-site': site }))).toBe(true);
    },
  );

  it.each(['cross-site', 'CROSS-SITE', 'something-new', ''])(
    'keeps a request out that states no Origin and Sec-Fetch-Site: "%s"',
    (site) => {
      expect(devLoginAllowed(request({ 'sec-fetch-site': site }))).toBe(false);
    },
  );

  it('keeps a tag of another site out whatever it asks for', () => {
    for (const dest of ['image', 'script', 'iframe', 'document', 'style', 'empty']) {
      const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': dest };
      expect(devLoginAllowed(request(headers))).toBe(false);
    }
  });

  it('judges a request that states an Origin by it', () => {
    // A development server over HTTPS is another site to the browser, and still this machine.
    const https = { origin: 'https://localhost:5173', 'sec-fetch-site': 'cross-site' };
    const foreign = { origin: 'https://evil.example', 'sec-fetch-site': 'same-site' };
    expect(devLoginAllowed(request(https))).toBe(true);
    expect(devLoginAllowed(request(foreign))).toBe(false);
  });

  it('holds only a navigation back that a click here could repeat', () => {
    const link = {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    const held = (headers: Record<string, string>, url = '/bundles') =>
      devLoginHeldBack({ ...request(headers), url } as IncomingMessage);

    expect(held(link)).toBe(true);
    expect(held({ ...link, 'sec-fetch-site': 'none' })).toBe(false);
    expect(held({ ...link, 'sec-fetch-dest': 'iframe' })).toBe(false);
    expect(held({ ...link, 'sec-fetch-mode': 'no-cors' })).toBe(false);
    expect(held({ ...link, cookie: 'mooncg_session=stale' })).toBe(false);
    expect(held({ ...link, host: 'evil.example' })).toBe(false);
    expect(held({ ...link, 'x-forwarded-for': '10.0.0.1' })).toBe(false);
    expect(held(link, '/bundles?token=mcg_x')).toBe(false);
  });
});

describe('devLinkTarget', () => {
  it('keeps a path on this server', () => {
    expect(devLinkTarget('/w/Show?a=1')).toBe('/w/Show?a=1');
    expect(devLinkTarget('/')).toBe('/');
  });

  it.each(['//evil.example/x', '/\\evil.example/x', 'http://evil.example/', '', undefined])(
    'never leads to another site: %s',
    (url) => {
      expect(devLinkTarget(url)).toBe('/');
    },
  );
});

describe('without dev mode', () => {
  it('signs nobody in by itself, from this machine or not', async () => {
    const { http, upgrade } = await start(false);
    expect((await http('GET', '/api/v1/me')).status).toBe(401);
    expect(await upgrade()).toBe(401);
  });

  it('has no page for a link from another site: the login page is where it leads', async () => {
    const { server } = await start(false);
    const answer = await rawGet(server.port, '/', {
      host: `localhost:${server.port}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    });
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('/setup');
  });
});

describe('createIdentify with a dev login', () => {
  const setup = async () => {
    const storage = memoryStorage();
    cleanup.push(() => storage.close());
    const auth = createAuth({ store: storage.auth, scrypt: CHEAP, devMode: true });
    auth.ensureDevUser();
    const ada = await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['viewer'] });
    const identify = createIdentify({ auth, devLogin: () => auth.devIdentity() });
    const from = (headers: Record<string, string>, url = '/api/v1/me') =>
      identify({
        url,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:9090', ...headers },
      } as unknown as IncomingMessage);
    return { auth, ada, from };
  };

  it('signs a request without credentials in, and one from another site not', async () => {
    const { from } = await setup();
    expect(from({}).via).toBe('dev');
    expect(from({ origin: 'http://localhost:5173' }).via).toBe('dev');
    expect(from({ origin: 'https://evil.example' }).principal.kind).toBe('anonymous');
  });

  it.each([
    ['a session cookie that is not valid', { cookie: 'mooncg_session=stale' }],
    ['a token cookie that is not valid', { cookie: 'mooncg_token=stale' }],
    ['two session cookies', { cookie: 'mooncg_session=a; mooncg_session=b' }],
    ['a wrong bearer token', { authorization: 'Bearer mcg_wrong' }],
    ['an Authorization header of another kind', { authorization: 'Basic ZGV2OmRldg==' }],
    ['an empty Authorization header', { authorization: '' }],
  ])('does not sign in a request that brought %s', async (_what, headers) => {
    const { from } = await setup();
    expect(from(headers).principal.kind).toBe('anonymous');
  });

  it.each(['/b/board/graphics/overlay.html?token=mcg_wrong', '/ws?x=1&token=', '/?token'])(
    'does not sign in a request that brought a token in its address (%s)',
    async (url) => {
      const { from } = await setup();
      expect(from({}, url).principal.kind).toBe('anonymous');
      expect(from({}, url.replaceAll('token', 'tokens')).via).toBe('dev');
    },
  );

  it('does not sign in a request whose token was revoked or whose session ended', async () => {
    const { auth, ada, from } = await setup();
    const { token, secret } = auth.createToken(
      { id: `user:${ada.id}`, kind: 'user', roles: ['viewer'] },
      { name: 'obs', grants: ['system:dashboard.view'] },
    );
    const login = await auth.login('ada', PASSWORD, '127.0.0.1');
    if (!login.ok) throw new Error('The login failed');
    expect(from({ authorization: `Bearer ${secret}` }).principal.kind).toBe('token');
    expect(from({ cookie: `mooncg_session=${login.session}` }).via).toBe('session');

    auth.revokeToken(token.id);
    auth.logout(login.session);

    expect(from({ authorization: `Bearer ${secret}` }).principal.kind).toBe('anonymous');
    expect(from({ cookie: `mooncg_session=${login.session}` }).principal.kind).toBe('anonymous');
  });
});

describe('a socket in dev mode', () => {
  /** A socket server with the dev login, and origins allowed that dev mode would refuse. */
  async function sockets(allowedOrigins: string[]) {
    const storage = memoryStorage();
    const auth = createAuth({ store: storage.auth, scrypt: CHEAP, devMode: true });
    auth.ensureDevUser();
    const server = createServer();
    const handle = attachWebSocket(server, {
      registry: new ReplicantRegistry(),
      bundleExists: () => true,
      identify: createIdentify({ auth, devLogin: () => auth.devIdentity() }),
      allowedOrigins,
      logger: memoryLogger().logger,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      handle.close();
      await new Promise((resolve) => server.close(resolve));
      await storage.close();
    });
    const { port } = server.address() as AddressInfo;
    return (headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
        const done = (status: number) => {
          ws.terminate();
          resolve(status);
        };
        ws.on('open', () => done(101));
        ws.on('unexpected-response', (_request, response) => done(response.statusCode ?? 0));
        ws.on('error', reject);
      });
  }

  it('is never opened for a page of another site, even one whose origin is allowed', async () => {
    const upgrade = await sockets(['https://evil.example', 'http://localhost:5173']);

    expect(await upgrade()).toBe(101);
    expect(await upgrade({ origin: 'http://localhost:5173' })).toBe(101);
    // Allowed to connect, so it gets past the origin check; signed in it is not.
    expect(await upgrade({ origin: 'https://evil.example' })).toBe(401);
  });
});

describe('dev mode', () => {
  it('creates its own administrator "dev" in an installation without users and warns', async () => {
    const { http, lines, server, auth } = await start(true);

    const me = await http('GET', '/api/v1/me');

    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ user: { kind: 'user', name: 'dev' }, roles: ['admin'] });
    expect(auth.listUsers()).toEqual([
      { id: expect.any(String), name: 'dev', disabled: false, roles: ['admin'], devMode: true },
    ]);
    expect(server.setupUrl).toBeUndefined();
    const warning = lines.find((line) => line.includes('DEV MODE'));
    expect(warning).toContain('WARN');
    expect(warning).toContain('without a password');
    expect(warning).toContain('"dev"');
  });

  it('never acts as a real person, also where an administrator exists', async () => {
    const storage = memoryStorage();
    const before = createAuth({ store: storage.auth, scrypt: CHEAP });
    await before.createUser({ name: 'vera', password: PASSWORD, roles: ['viewer'] });
    await before.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });

    const { http, auth } = await start(true, { storage });

    expect((await http('GET', '/api/v1/me')).json).toMatchObject({ user: { name: 'dev' } });
    expect(auth.listUsers().map((user) => [user.name, user.devMode === true])).toEqual([
      ['ada', false],
      ['dev', true],
      ['vera', false],
    ]);
  });

  it('takes another name when a real person is called "dev", and leaves that account alone', async () => {
    const storage = memoryStorage();
    const before = createAuth({ store: storage.auth, scrypt: CHEAP });
    const person = await before.createUser({ name: 'dev', password: PASSWORD, roles: ['viewer'] });

    const { http, auth, lines } = await start(true, { storage });

    const me = await http('GET', '/api/v1/me');
    expect(me.json).toMatchObject({ user: { name: 'dev-mode' }, roles: ['admin'] });
    expect(auth.findUser('dev')).toEqual(person);
    expect(lines.find((line) => line.includes('DEV MODE'))).toContain('"dev-mode"');
  });

  it('acts as the same user at every start', async () => {
    const storage = lastingStorage();
    const first = await start(true, { storage });
    const id = (await first.http('GET', '/api/v1/me')).json.user.id;
    await first.http('PUT', '/api/v1/me/prefs/layout', { json: { value: { columns: 3 } } });
    await first.server.close();

    const second = await start(true, { storage });

    expect((await second.http('GET', '/api/v1/me')).json.user.id).toBe(id);
    expect(second.auth.listUsers()).toHaveLength(1);
    expect((await second.http('GET', '/api/v1/me/prefs/layout')).json).toEqual({
      value: { columns: 3 },
    });
  });

  it('opens the dashboard and the socket without signing in', async () => {
    const { http, upgrade } = await start(true);
    expect((await http('GET', '/')).status).toBe(200);
    expect((await http('GET', '/api/v1/bundles')).status).toBe(200);
    expect(await upgrade()).toBe(101);
  });

  it('believes only a Host header that names this machine', async () => {
    const { server } = await start(true);
    const own = await rawGet(server.port, '/api/v1/me', { host: `localhost:${server.port}` });
    const rebound = await rawGet(server.port, '/api/v1/me', {
      host: `evil.example:${server.port}`,
    });

    expect(own.status).toBe(200);
    expect(rebound.status).toBe(401);
  });

  it('does not sign in a request a proxy passed on', async () => {
    const { http } = await start(true);
    const answer = await http('GET', '/api/v1/me', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(answer.status).toBe(401);
  });

  it('does not sign in a request of a page of another site', async () => {
    const { http, base } = await start(true);
    const get = (origin: string) => http('GET', '/api/v1/me', { headers: { origin } });

    expect((await get('https://evil.example')).status).toBe(401);
    expect((await get('null')).status).toBe(401);
    expect((await get(base)).status).toBe(200);
    expect((await get('http://localhost:5173')).status).toBe(200);
  });

  it('does not sign in what a tag or a link on another site makes the browser ask for', async () => {
    const { http } = await start(true);
    const get = (path: string, site: string, more: Record<string, string> = {}) =>
      http('GET', path, { headers: { 'sec-fetch-site': site, ...more } });

    // An <img>, <script> or <iframe> of another site states no Origin.
    expect((await get('/api/v1/me', 'cross-site')).status).toBe(401);
    expect((await get('/b/board/api/public', 'cross-site')).status).toBe(401);
    expect((await get('/b/board/graphics/overlay.html', 'cross-site')).status).toBe(401);
    expect((await get('/sdk/mooncg.js', 'cross-site')).status).toBe(401);
    // The address bar, a page of this server, and one of a development server here.
    expect((await get('/api/v1/me', 'none')).status).toBe(200);
    expect((await get('/b/board/api/public', 'same-origin')).status).toBe(200);
    expect((await get('/b/board/graphics/overlay.html', 'same-site')).status).toBe(200);
  });

  it('answers a link on another site to the dashboard with a page to go on from', async () => {
    const { server } = await start(true);
    // Sent by hand: `fetch` states a mode of its own.
    const link = {
      host: `localhost:${server.port}`,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };

    const held = await rawGet(server.port, '/w/Show?a=1&b=%22%3E<script>', link);

    expect(held.status).toBe(200);
    expect(held.headers['cache-control']).toBe('no-store');
    expect(held.headers['content-security-policy']).toContain("default-src 'self'");
    expect(held.body).toContain('href="/w/Show?a=1&amp;b=%22%3E&lt;script&gt;"');
    expect(held.body).not.toContain('<script');
    // The click on that link is a request of a page of this server.
    const onward = await rawGet(server.port, '/w/Show?a=1', {
      ...link,
      'sec-fetch-site': 'same-origin',
    });
    expect(onward.status).toBe(200);
    expect(onward.body).not.toContain('Continue to the dashboard');
    // A frame is no place to go on from: it is answered like anyone who is not signed in.
    const framed = await rawGet(server.port, '/', { ...link, 'sec-fetch-dest': 'iframe' });
    expect(framed.status).toBe(302);
    expect(framed.headers.location).toBe('/login');
  });

  it('refuses the socket of a page of another site and of another host name', async () => {
    const { upgrade, server } = await start(true);
    expect(await upgrade({ origin: 'http://evil.example' })).toBe(403);
    expect(await upgrade({ host: `evil.example:${server.port}` })).toBe(401);
  });

  it('still asks a request that changes something to prove it was meant', async () => {
    const { http, base } = await start(true);
    const path = '/api/v1/bundles/board/reload';

    const form = await http('POST', path, {
      body: 'x=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const foreign = await http('POST', path, {
      json: {},
      headers: { origin: 'http://evil.example' },
    });
    const own = await http('POST', path, { json: {}, headers: { origin: base } });

    expect(form.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(own.status).toBe(200);
  });

  it('lets whoever brings credentials act as themselves', async () => {
    const { http, auth, login } = await start(true);
    await auth.createUser({ name: 'vera', password: PASSWORD, roles: ['viewer'] });

    const answer = await http('GET', '/api/v1/me', { cookie: await login('vera') });

    expect(answer.json).toMatchObject({ user: { name: 'vera' }, roles: ['viewer'] });
  });

  it('signs nobody in whose credentials are not accepted', async () => {
    const { http, upgrade } = await start(true);

    expect((await http('GET', '/api/v1/me', { cookie: 'mooncg_session=stale' })).status).toBe(401);
    expect((await http('GET', '/api/v1/me', { bearer: 'mcg_wrong' })).status).toBe(401);
    expect((await http('GET', '/api/v1/bundles', { bearer: 'mcg_wrong' })).status).toBe(401);
    expect(await upgrade({ cookie: 'mooncg_session=stale' })).toBe(401);
    expect(await upgrade({ authorization: 'Bearer mcg_wrong' })).toBe(401);
    const page = await http('GET', '/b/board/graphics/overlay.html?token=mcg_wrong');
    expect(page.status).toBe(401);
  });

  it('takes a cookie that is no longer valid away when the dashboard is opened', async () => {
    const { http } = await start(true);

    const stale = await http('GET', '/bundles', {
      cookie: 'mooncg_session=stale; mooncg_token=old; theme=dark',
    });

    expect(stale.status).toBe(302);
    expect(stale.headers.get('location')).toBe('/bundles');
    expect(stale.setCookies.map((cookie) => cookie.split(';')[0]).sort()).toEqual([
      'mooncg_session=',
      'mooncg_token=',
    ]);
    expect(stale.setCookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    // The browser comes back without them, and is signed in.
    expect((await http('GET', '/bundles', { cookie: 'theme=dark' })).status).toBe(200);
    // A token is never taken out of a client's hands like that: it is refused.
    const token = await http('GET', '/bundles', { bearer: 'mcg_wrong' });
    expect(token.status).toBe(302);
    expect(token.headers.get('location')).toBe('/login');
  });

  it('signs nobody in once its user is deleted, and creates it again at the next start', async () => {
    const storage = lastingStorage();
    const first = await start(true, { storage });
    const dev = first.auth.findUser('dev');

    first.auth.deleteUser(dev?.id ?? '');

    expect((await first.http('GET', '/api/v1/me')).status).toBe(401);
    await first.server.close();
    const second = await start(true, { storage });
    expect((await second.http('GET', '/api/v1/me')).json).toMatchObject({ user: { name: 'dev' } });
  });

  it('has no password to change', async () => {
    const { http } = await start(true);
    const answer = await http('POST', '/api/v1/me/password', {
      json: { current: 'x', password: 'another password' },
    });
    expect(answer.status).toBe(403);
  });

  it.each([
    [{ host: '0.0.0.0' }, /loopback/],
    [{ host: '192.168.1.10' }, /loopback/],
    [{ trustProxy: true }, /proxy/],
    [{ allowedOrigins: ['https://evil.example'] }, /allowed origin.*evil\.example/s],
    [{ allowedOrigins: ['http://localhost:5173', 'http://10.0.0.5:5173'] }, /10\.0\.0\.5/],
  ])('does not start with %j', async (overrides, message) => {
    const starting = startServer(testConfig({ dev: true, ...overrides }), {
      logger: memoryLogger().logger,
      storage: memoryStorage(),
    });
    await expect(starting).rejects.toThrow(message);
  });

  it('starts with allowed origins on this machine', async () => {
    const { upgrade } = await start(true, {}, { allowedOrigins: ['http://localhost:5173'] });
    expect(await upgrade({ origin: 'http://localhost:5173' })).toBe(101);
  });
});

describe('the user of dev mode', () => {
  it('cannot be turned into an ordinary account', async () => {
    const { auth, http } = await start(true);
    const dev = auth.findUser('dev');
    const id = dev?.id ?? '';
    await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const refused = /dev mode/;

    expect(() => auth.updateUser(id, { name: 'dominik' })).toThrow(refused);
    expect(() => auth.updateUser(id, { disabled: true })).toThrow(refused);
    expect(() => auth.assignRole(id, 'viewer')).toThrow(refused);
    expect(() => auth.unassignRole(id, 'admin')).toThrow(refused);
    await expect(auth.setPassword(id, 'a new password')).rejects.toThrow(refused);
    const patch = await http('PATCH', `/api/v1/users/${id}`, { json: { name: 'dominik' } });
    const password = await http('PUT', `/api/v1/users/${id}/password`, {
      json: { password: 'a new password' },
    });

    expect(patch.status).toBe(409);
    expect(password.status).toBe(409);
    expect(auth.findUser('dev')).toEqual(dev);
    expect(await auth.login('dev', 'a new password', '127.0.0.1')).toEqual({
      ok: false,
      reason: 'credentials',
    });
  });

  it('shows as what it is in the list of users', async () => {
    const { http } = await start(true);
    const { json } = await http('GET', '/api/v1/users');
    expect(json.users).toEqual([
      { id: expect.any(String), name: 'dev', disabled: false, roles: ['admin'], devMode: true },
    ]);
  });
});

describe('after dev mode, without it', () => {
  /** An installation that was only ever used in dev mode, started the ordinary way. */
  async function afterDevMode() {
    const storage = lastingStorage();
    const dev = await start(true, { storage });
    const made = await dev.http('POST', '/api/v1/tokens', {
      json: { name: 'obs', grants: ['*'] },
    });
    expect((await dev.http('GET', '/api/v1/me', { bearer: made.json.secret })).status).toBe(200);
    const id = dev.auth.findUser('dev')?.id ?? '';
    await dev.server.close();
    return { ...(await start(false, { storage })), secret: made.json.secret as string, id };
  }

  it('offers the setup of a fresh installation: the user of dev mode is nobody', async () => {
    const { server, http, auth } = await afterDevMode();

    expect(server.setupUrl).toMatch(/\/setup\?code=/);
    expect((await http('GET', '/')).headers.get('location')).toBe('/setup');
    expect((await http('GET', '/setup')).status).toBe(200);
    const code = new URL(server.setupUrl ?? '').searchParams.get('code');
    const setup = await http('POST', '/api/v1/setup', {
      json: { code, username: 'ada', password: PASSWORD },
    });

    expect(setup.status).toBe(201);
    expect(auth.findUser('ada')).toMatchObject({ roles: ['admin'] });
    expect((await http('GET', '/setup')).status).toBe(404);
  });

  it('warns once that such a user exists', async () => {
    const { lines } = await afterDevMode();
    const warnings = lines.filter((line) => line.includes('"dev"') && line.includes('dev mode'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WARN');
  });

  it('says nothing where dev mode never ran', async () => {
    const { lines } = await start(false);
    expect(lines.filter((line) => line.includes('dev mode'))).toEqual([]);
  });

  it('accepts nothing of that user: no password, no token, no session', async () => {
    const { http, upgrade, auth, secret, id } = await afterDevMode();

    expect((await http('GET', '/api/v1/me')).status).toBe(401);
    expect((await http('GET', '/api/v1/me', { bearer: secret })).status).toBe(401);
    expect(await upgrade({ authorization: `Bearer ${secret}` })).toBe(401);
    expect(auth.listTokens()).toEqual([]);
    expect(auth.check(`user:${id}`, 'system:dashboard.view')).toBe(false);
    expect(auth.devIdentity().principal.kind).toBe('anonymous');
    const login = await http('POST', '/api/v1/auth/login', {
      json: { username: 'dev', password: PASSWORD },
    });
    expect(login.status).toBe(401);
  });

  it('gives that user no token and no password from the command line either', async () => {
    const { auth, id } = await afterDevMode();
    expect(() =>
      auth.createToken(
        { id: `user:${id}`, kind: 'user', roles: ['admin'] },
        { name: 'cli', grants: ['*'] },
      ),
    ).toThrow(/dev mode/);
    await expect(auth.setPassword(id, 'a new password')).rejects.toThrow(/dev mode/);
  });

  it('does not count that user as an administrator', async () => {
    const { auth } = await afterDevMode();
    const ada = await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    // With "dev" counted, the last real administrator could be removed.
    expect(() => auth.deleteUser(ada.id)).toThrow(/last administrator/);
    expect(() => auth.updateUser(ada.id, { disabled: true })).toThrow(/last administrator/);
  });
});
