import { request as rawRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindingWarning } from '../src/server.js';
import { cookiePair, PASSWORD, startAuthServer, startWithRoles, WAIT_MS } from './auth-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

async function withRoles() {
  const context = await startWithRoles(temporary);
  cleanup.push(() => context.server.close());
  return context;
}

async function fresh(
  ...args: Parameters<typeof startAuthServer> extends [unknown, ...infer Rest] ? Rest : never
) {
  const context = await startAuthServer(temporary, ...args);
  cleanup.push(() => context.server.close());
  return context;
}

const WAIT = { timeout: WAIT_MS, interval: 20 };

describe('login and session cookie', () => {
  it('sets an HttpOnly, SameSite=Lax cookie and answers who signed in', async () => {
    const { http, auth } = await fresh();
    const ada = await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const answer = await http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: PASSWORD },
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      user: { id: `user:${ada.id}`, kind: 'user', name: 'ada' },
      roles: ['admin'],
      permissions: ['*'],
    });
    expect(answer.setCookies).toHaveLength(1);
    const [setCookie] = answer.setCookies as [string];
    expect(setCookie).toMatch(/^mooncg_session=[A-Za-z0-9_-]{40,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=\d+/);
    expect(setCookie).not.toContain('Secure');
    expect(answer.headers.get('cache-control')).toBe('no-store');

    const me = await http('GET', '/api/v1/me', { cookie: cookiePair(setCookie) });
    expect(me.json).toEqual(answer.json);
  });

  it('marks the cookie Secure when told to, or behind a trusted HTTPS proxy', async () => {
    const forced = await fresh({ secureCookies: true });
    await forced.auth.createUser({ name: 'ada', password: PASSWORD });
    const body = { json: { username: 'ada', password: PASSWORD } };
    expect((await forced.http('POST', '/api/v1/auth/login', body)).setCookies[0]).toContain(
      'Secure',
    );

    const proxied = await fresh({ trustProxy: true });
    await proxied.auth.createUser({ name: 'ada', password: PASSWORD });
    const https = { ...body, headers: { 'x-forwarded-proto': 'https' } };
    expect((await proxied.http('POST', '/api/v1/auth/login', https)).setCookies[0]).toContain(
      'Secure',
    );
    expect((await proxied.http('POST', '/api/v1/auth/login', body)).setCookies[0]).not.toContain(
      'Secure',
    );

    // Without --trust-proxy the header is whatever a client claims, and is ignored.
    const plain = await fresh();
    await plain.auth.createUser({ name: 'ada', password: PASSWORD });
    expect((await plain.http('POST', '/api/v1/auth/login', https)).setCookies[0]).not.toContain(
      'Secure',
    );
  });

  it('answers 401 alike for a wrong password and an unknown user', async () => {
    const { http, auth } = await fresh();
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const wrong = await http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: 'wrong password' },
    });
    const unknown = await http('POST', '/api/v1/auth/login', {
      json: { username: 'nobody', password: PASSWORD },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(wrong.setCookies).toEqual([]);
  });

  it('answers 429 with Retry-After once a name is throttled', async () => {
    const { http, auth } = await fresh();
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const attempt = (password: string) =>
      http('POST', '/api/v1/auth/login', { json: { username: 'ada', password } });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong password')).status).toBe(401);
    const blocked = await attempt(PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.setCookies).toEqual([]);
  });

  it('refuses a body that is not the expected JSON', async () => {
    const { http } = await fresh();
    const form = await http('POST', '/api/v1/auth/login', {
      body: 'username=ada&password=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(400);
    expect((await http('POST', '/api/v1/auth/login', { json: { username: 7 } })).status).toBe(400);
    expect((await http('POST', '/api/v1/auth/login', { json: [] })).status).toBe(400);
  });

  it('refuses a login posted from a page of another origin', async () => {
    const { http, auth } = await fresh();
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const answer = await http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: PASSWORD },
      headers: { origin: 'http://evil.example' },
    });
    expect(answer.status).toBe(403);
    expect(answer.setCookies).toEqual([]);
  });

  it('ends the session on logout and clears the cookie', async () => {
    const { http, cookies } = await withRoles();
    const out = await http('POST', '/api/v1/auth/logout', { cookie: cookies.viewer, json: {} });
    expect(out.status).toBe(204);
    expect(out.setCookies.join()).toMatch(/mooncg_session=;.*Max-Age=0/);
    expect((await http('GET', '/api/v1/me', { cookie: cookies.viewer })).status).toBe(401);
  });

  it('lets a user change the own password and keeps that browser signed in', async () => {
    const { http, cookies, login } = await withRoles();
    const other = await login('vera');
    const wrong = await http('POST', '/api/v1/me/password', {
      cookie: cookies.viewer,
      json: { current: 'wrong password', password: 'next password' },
    });
    expect(wrong.status).toBe(403);
    const changed = await http('POST', '/api/v1/me/password', {
      cookie: cookies.viewer,
      json: { current: PASSWORD, password: 'next password' },
    });
    expect(changed.status).toBe(204);
    const renewed = cookiePair(changed.setCookies[0] as string);
    expect((await http('GET', '/api/v1/me', { cookie: renewed })).status).toBe(200);
    expect((await http('GET', '/api/v1/me', { cookie: cookies.viewer })).status).toBe(401);
    expect((await http('GET', '/api/v1/me', { cookie: other })).status).toBe(401);
    await expect(login('vera', 'next password')).resolves.toMatch(/^mooncg_session=/);
  });
});

describe('request forgery protection', () => {
  it('requires JSON or the custom header for state-changing requests sent with a cookie', async () => {
    const { http, cookies } = await withRoles();
    const path = '/api/v1/bundles/secret/reload';
    const bare = await http('POST', path, { cookie: cookies.admin });
    expect(bare.status).toBe(403);
    expect(bare.json.error.message).toMatch(/X-MoonCG-CSRF/);
    const form = await http('POST', path, {
      cookie: cookies.admin,
      body: 'a=b',
      headers: { 'content-type': 'text/plain' },
    });
    expect(form.status).toBe(403);
    const json = await http('POST', path, { cookie: cookies.admin, json: {} });
    expect(json.status).toBe(200);
    const header = await http('POST', path, {
      cookie: cookies.admin,
      headers: { 'x-mooncg-csrf': '1' },
    });
    expect(header.status).toBe(200);
  });

  it('still checks the origin first', async () => {
    const { http, cookies } = await withRoles();
    const answer = await http('POST', '/api/v1/bundles/secret/reload', {
      cookie: cookies.admin,
      json: {},
      headers: { origin: 'http://evil.example' },
    });
    expect(answer.status).toBe(403);
    expect(answer.json.error.message).toMatch(/origin/);
  });

  it('exempts requests that carry a bearer token', async () => {
    const { http, cookies } = await withRoles();
    const created = await http('POST', '/api/v1/tokens', {
      cookie: cookies.admin,
      json: { name: 'automation', grants: ['system:bundles.manage'] },
    });
    const answer = await http('POST', '/api/v1/bundles/secret/reload', {
      bearer: created.json.secret,
    });
    expect(answer.status).toBe(200);
  });

  it('applies to bundle API routes as well', async () => {
    const { http, cookies } = await withRoles();
    const bare = await http('POST', '/b/board/api/score', { cookie: cookies.operator });
    expect(bare.status).toBe(403);
    const ok = await http('POST', '/b/board/api/score', {
      cookie: cookies.operator,
      headers: { 'x-mooncg-csrf': '1' },
    });
    expect(ok.status).toBe(200);
  });
});

describe('users API', () => {
  it('creates, lists, renames, disables and deletes users without ever showing a hash', async () => {
    const { http, cookies, login } = await withRoles();
    const admin = { cookie: cookies.admin };
    const created = await http('POST', '/api/v1/users', {
      ...admin,
      json: { name: 'bob', password: PASSWORD, roles: ['viewer'] },
    });
    expect(created.status).toBe(201);
    expect(created.json.user).toEqual({
      id: expect.any(String),
      name: 'bob',
      disabled: false,
      roles: ['viewer'],
    });
    const { id } = created.json.user;

    const renamed = await http('PATCH', `/api/v1/users/${id}`, {
      ...admin,
      json: { name: 'robert' },
    });
    expect(renamed.json.user.name).toBe('robert');
    const list = await http('GET', '/api/v1/users', admin);
    expect(list.json.users.map((user: { name: string }) => user.name)).toContain('robert');
    expect(list.text).not.toMatch(/scrypt|password|hash|secret/i);

    const session = await login('robert');
    const disabled = await http('PATCH', `/api/v1/users/${id}`, {
      ...admin,
      json: { disabled: true },
    });
    expect(disabled.json.user.disabled).toBe(true);
    expect((await http('GET', '/api/v1/me', { cookie: session })).status).toBe(401);
    await http('PATCH', `/api/v1/users/${id}`, { ...admin, json: { disabled: false } });

    const reset = await http('PUT', `/api/v1/users/${id}/password`, {
      ...admin,
      json: { password: 'brand new password' },
    });
    expect(reset.status).toBe(204);
    await expect(login('robert', 'brand new password')).resolves.toBeDefined();

    expect((await http('DELETE', `/api/v1/users/${id}`, { ...admin, json: {} })).status).toBe(204);
    expect((await http('DELETE', `/api/v1/users/${id}`, { ...admin, json: {} })).status).toBe(404);
  });

  it('answers with the right status for bad input and conflicts', async () => {
    const { http, cookies } = await withRoles();
    const admin = { cookie: cookies.admin };
    const post = (json: unknown) => http('POST', '/api/v1/users', { ...admin, json });
    expect((await post({ name: 'bob', password: 'short' })).status).toBe(400);
    expect((await post({ name: 'ADA', password: PASSWORD })).status).toBe(409);
    expect((await post({ name: 'bob', password: PASSWORD, roles: ['nope'] })).status).toBe(404);
    expect((await post({ name: 'bob', password: PASSWORD, roles: 'admin' })).status).toBe(400);
    expect(
      (await http('PATCH', '/api/v1/users/nope', { ...admin, json: { name: 'x' } })).status,
    ).toBe(404);
  });

  it('assigns and removes roles, but keeps the last admin', async () => {
    const { http, cookies, auth } = await withRoles();
    const admin = { cookie: cookies.admin, json: {} };
    const vera = auth.findUser('vera') as { id: string };
    const ada = auth.findUser('ada') as { id: string };
    expect((await http('PUT', `/api/v1/users/${vera.id}/roles/operator`, admin)).status).toBe(204);
    expect(auth.findUser('vera')?.roles).toEqual(['operator', 'viewer']);
    expect((await http('DELETE', `/api/v1/users/${vera.id}/roles/viewer`, admin)).status).toBe(204);
    expect(auth.findUser('vera')?.roles).toEqual(['operator']);
    expect((await http('PUT', `/api/v1/users/${vera.id}/roles/nope`, admin)).status).toBe(404);

    expect((await http('DELETE', `/api/v1/users/${ada.id}/roles/admin`, admin)).status).toBe(409);
    expect((await http('DELETE', `/api/v1/users/${ada.id}`, admin)).status).toBe(409);
    const disable = await http('PATCH', `/api/v1/users/${ada.id}`, {
      cookie: cookies.admin,
      json: { disabled: true },
    });
    expect(disable.status).toBe(409);
    expect((await http('GET', '/api/v1/me', { cookie: cookies.admin })).status).toBe(200);
  });
});

describe('roles API', () => {
  it('creates roles, grants and revokes, and protects the built-in ones', async () => {
    const { http, cookies } = await withRoles();
    const admin = { cookie: cookies.admin };
    const created = await http('POST', '/api/v1/roles', {
      ...admin,
      json: { name: 'replay', grants: ['bundle:board:view'] },
    });
    expect(created.status).toBe(201);
    expect(created.json.role).toEqual({
      name: 'replay',
      builtin: false,
      grants: ['bundle:board:view'],
    });

    const granted = await http('POST', '/api/v1/roles/replay/grants', {
      ...admin,
      json: { permission: 'bundle:*:operate' },
    });
    expect(granted.json.role.grants).toEqual(['bundle:*:operate', 'bundle:board:view']);
    const revoked = await http(
      'DELETE',
      `/api/v1/roles/replay/grants/${encodeURIComponent('bundle:*:operate')}`,
      { ...admin, json: {} },
    );
    expect(revoked.json.role.grants).toEqual(['bundle:board:view']);

    const bad = await http('POST', '/api/v1/roles/replay/grants', {
      ...admin,
      json: { permission: 'everything' },
    });
    expect(bad.status).toBe(400);
    const roles = await http('GET', '/api/v1/roles', admin);
    expect(roles.json.roles.map((role: { name: string }) => role.name)).toEqual([
      'admin',
      'graphics',
      'operator',
      'replay',
      'viewer',
    ]);

    expect((await http('DELETE', '/api/v1/roles/replay', { ...admin, json: {} })).status).toBe(204);
    expect((await http('DELETE', '/api/v1/roles/viewer', { ...admin, json: {} })).status).toBe(409);
    expect(
      (
        await http('DELETE', `/api/v1/roles/admin/grants/${encodeURIComponent('*')}`, {
          ...admin,
          json: {},
        })
      ).status,
    ).toBe(409);
  });

  it('applies a changed grant to the next request', async () => {
    const { http, cookies } = await withRoles();
    const panel = () => http('GET', '/b/board/dashboard/control.html', { cookie: cookies.viewer });
    expect((await panel()).status).toBe(403);
    await http('POST', '/api/v1/roles/viewer/grants', {
      cookie: cookies.admin,
      json: { permission: 'bundle:board:operate' },
    });
    expect((await panel()).status).toBe(200);
  });
});

describe('API tokens over HTTP', () => {
  async function withToken(grants = ['bundle:board:view']) {
    const context = await withRoles();
    const created = await context.http('POST', '/api/v1/tokens', {
      cookie: context.cookies.admin,
      json: { name: 'OBS', grants },
    });
    return {
      ...context,
      created,
      secret: created.json.secret as string,
      id: created.json.token.id as string,
    };
  }

  it('shows the secret once and never again', async () => {
    const { http, cookies, created, secret } = await withToken();
    expect(created.status).toBe(201);
    expect(secret).toMatch(/^mcg_[A-Za-z0-9_-]{40,}$/);
    expect(created.json.token).toMatchObject({
      name: 'OBS',
      grants: ['bundle:board:view'],
      expires: null,
      lastUsed: null,
    });
    expect(created.headers.get('cache-control')).toBe('no-store');
    const list = await http('GET', '/api/v1/tokens', { cookie: cookies.admin });
    expect(list.json.tokens).toHaveLength(1);
    expect(list.text).not.toContain(secret);
    expect(list.text).not.toMatch(/hash/i);
  });

  it('refuses grants beyond the creator, bad input and a past expiry', async () => {
    const { http, cookies, auth } = await withRoles();
    auth.grant('operator', 'system:tokens.manage');
    const post = (cookie: string, json: unknown) =>
      http('POST', '/api/v1/tokens', { cookie, json });
    expect(
      (await post(cookies.operator, { name: 'x', grants: ['system:users.manage'] })).status,
    ).toBe(403);
    expect(
      (await post(cookies.operator, { name: 'x', grants: ['bundle:board:view'] })).status,
    ).toBe(201);
    expect((await post(cookies.admin, { name: 'x', grants: [] })).status).toBe(400);
    expect((await post(cookies.admin, { name: 'x', grants: 'all' })).status).toBe(400);
    const past = { name: 'x', grants: ['*'], expires: '2001-01-01T00:00:00Z' };
    expect((await post(cookies.admin, past)).status).toBe(400);
    const future = { name: 'x', grants: ['*'], expires: '2999-01-01T00:00:00.000Z' };
    expect((await post(cookies.admin, future)).json.token.expires).toBe('2999-01-01T00:00:00.000Z');
  });

  it('acts as the token when sent as a bearer token, over HTTP and on a socket', async () => {
    const { http, upgrade, socket, secret, id } = await withToken();
    const me = await http('GET', '/api/v1/me', { bearer: secret });
    expect(me.json).toEqual({
      user: { id: `token:${id}`, kind: 'token', name: 'OBS' },
      roles: ['admin'],
      permissions: ['bundle:board:view'],
    });
    expect((await http('GET', '/b/board/graphics/overlay.html', { bearer: secret })).status).toBe(
      200,
    );
    expect((await http('GET', '/b/board/dashboard/control.html', { bearer: secret })).status).toBe(
      403,
    );
    expect((await http('GET', '/api/v1/bundles', { bearer: secret })).status).toBe(403);
    expect((await http('GET', '/sdk/mooncg.js', { bearer: secret })).status).toBe(200);

    expect(await upgrade({ authorization: `Bearer ${secret}` })).toBe(101);
    const ws = await socket({ authorization: `Bearer ${secret}` });
    cleanup.push(() => ws.close());
    expect((await ws.ask({ t: 'rep.sub', name: 'score' })).t).toBe('rep.snap');
    expect(
      await ws.ask({
        t: 'rep.op',
        name: 'score',
        patches: [{ op: 'replace', path: '/home', value: 9 }],
      }),
    ).toMatchObject({ t: 'err', code: 'forbidden' });
  });

  it('exchanges ?token= on a bundle page for a cookie and redirects to the clean URL', async () => {
    const { http, socket, secret } = await withToken();
    const first = await http(
      'GET',
      `/b/board/graphics/overlay.html?layout=wide&token=${secret}&x=1`,
    );
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/b/board/graphics/overlay.html?layout=wide&x=1');
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    const [setCookie] = first.setCookies as [string];
    expect(setCookie).toMatch(/^mooncg_token=[A-Za-z0-9_-]{40,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain(secret);

    const cookie = cookiePair(setCookie);
    const page = await http('GET', '/b/board/graphics/overlay.html?layout=wide&x=1', { cookie });
    expect(page.status).toBe(200);
    expect(page.text).toBe('board overlay');
    expect((await http('GET', '/b/board/dashboard/control.html', { cookie })).status).toBe(403);

    const ws = await socket({ cookie });
    cleanup.push(() => ws.close());
    expect(await ws.ask({ t: 'rep.sub', name: 'score' })).toMatchObject({
      t: 'rep.snap',
      value: { home: 0 },
    });
  });

  it('redirects without a query when the token was the only parameter', async () => {
    const { http, secret } = await withToken();
    const answer = await http('GET', `/b/board/graphics/overlay.html?token=${secret}`);
    expect(answer.headers.get('location')).toBe('/b/board/graphics/overlay.html');
  });

  it('refuses a wrong token in the URL and exchanges nothing outside bundle pages', async () => {
    const { http, secret } = await withToken();
    const wrong = await http('GET', '/b/board/graphics/overlay.html?token=mcg_wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.setCookies).toEqual([]);
    expect(wrong.text).not.toContain('mcg_wrong');
    const elsewhere = await http('GET', `/api/v1/me?token=${secret}`);
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.setCookies).toEqual([]);
  });

  it('invalidates the cookie and closes the socket when the token is revoked', async () => {
    const { http, socket, upgrade, cookies, secret, id } = await withToken();
    const exchanged = await http('GET', `/b/board/graphics/overlay.html?token=${secret}`);
    const cookie = cookiePair(exchanged.setCookies[0] as string);
    const ws = await socket({ cookie });
    cleanup.push(() => ws.close());
    expect((await ws.ask({ t: 'rep.sub', name: 'score' })).t).toBe('rep.snap');

    const revoked = await http('DELETE', `/api/v1/tokens/${id}`, {
      cookie: cookies.admin,
      json: {},
    });
    expect(revoked.status).toBe(204);
    expect(await ws.closed()).toBe(4401);
    expect((await http('GET', '/b/board/graphics/overlay.html', { cookie })).status).toBe(401);
    expect((await http('GET', '/b/board/graphics/overlay.html', { bearer: secret })).status).toBe(
      401,
    );
    expect(await upgrade({ cookie })).toBe(401);
    expect((await http('GET', `/b/board/graphics/overlay.html?token=${secret}`)).status).toBe(401);
    expect(
      (await http('DELETE', `/api/v1/tokens/${id}`, { cookie: cookies.admin, json: {} })).status,
    ).toBe(404);
  });

  it('keeps tokens out of the log and out of error texts', async () => {
    const { http, lines, secret, server } = await withToken();
    await http('GET', `/b/board/graphics/missing.html?token=${secret}`);
    await http('GET', `/b/nope/graphics/x.html?token=${secret}`);
    await http('GET', `/nowhere?token=${secret}`);
    const wrong = await http('GET', `/b/board/api/nope?token=${secret}x`);
    expect(wrong.text).not.toContain('mcg_');
    // Whatever a part of the server logs passes through the same filter.
    server.logger.warn(`Refused GET /b/board/graphics/overlay.html?token=${secret}`);
    expect(lines.join('\n')).toContain('token=mcg_***');
    expect(lines.join('\n')).not.toContain(secret);
  });

  it('hides credentials from bundle route handlers', async () => {
    const { http, cookies, secret } = await withToken(['bundle:board:view']);
    const viaCookie = await http('GET', '/b/board/api/public?a=1', { cookie: cookies.operator });
    expect(viaCookie.json.headers).not.toContain('cookie');
    expect(viaCookie.json.query).toEqual({ a: '1' });
    const viaBearer = await http('GET', '/b/board/api/public', { bearer: secret });
    expect(viaBearer.status).toBe(200);
    expect(viaBearer.json.headers).not.toContain('authorization');
  });
});

describe('open sockets follow changes of access', () => {
  it('closes the socket of a user whose access changed, and of one who signed out', async () => {
    const { http, socket, cookies, auth, login } = await withRoles();
    const viewer = await socket({ cookie: cookies.viewer });
    const operator = await socket({ cookie: cookies.operator });
    cleanup.push(
      () => viewer.close(),
      () => operator.close(),
    );

    auth.revoke('viewer', 'bundle:board:view');
    expect(await viewer.closed()).toBe(4401);
    // Someone whose access stayed the same is left alone.
    expect((await operator.ask({ t: 'rep.sub', name: 'score' })).t).toBe('rep.snap');

    const other = await login('olga');
    const second = await socket({ cookie: other });
    cleanup.push(() => second.close());
    await http('POST', '/api/v1/auth/logout', { cookie: other, json: {} });
    expect(await second.closed()).toBe(4401);
    expect((await operator.ask({ t: 'rep.sub', name: 'notes' })).t).toBe('rep.snap');
  });

  it('notices a change made by another process at its next periodic check', async () => {
    const { socket, cookies, server } = await startWithRoles(temporary).then((context) => {
      cleanup.push(() => context.server.close());
      return context;
    });
    const viewer = await socket({ cookie: cookies.viewer });
    cleanup.push(() => viewer.close());
    // What the command line tool does: it writes to the store without telling the server.
    server.storage.auth.roles.revoke('viewer', 'bundle:board:view');
    server.recheckSockets();
    expect(await viewer.closed()).toBe(4401);
  });
});

describe('first-time setup over HTTP', () => {
  it('announces a setup URL, creates the first admin and then disappears', async () => {
    const { http, server, lines, login } = await fresh();
    const url = new URL(server.setupUrl as string);
    expect(url.pathname).toBe('/setup');
    const code = url.searchParams.get('code') as string;
    expect(code.length).toBeGreaterThanOrEqual(40);
    expect(lines.some((line) => line.includes(server.setupUrl as string))).toBe(true);

    const page = await http('GET', `/setup?code=${code}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect((await http('GET', '/')).headers.get('location')).toBe('/setup');

    const body = { username: 'ada', password: PASSWORD };
    expect((await http('POST', '/api/v1/setup', { json: { ...body, code: 'wrong' } })).status).toBe(
      403,
    );
    expect(
      (await http('POST', '/api/v1/setup', { json: { ...body, code, password: 'short' } })).status,
    ).toBe(400);
    const foreign = await http('POST', '/api/v1/setup', {
      json: { ...body, code },
      headers: { origin: 'http://evil.example' },
    });
    expect(foreign.status).toBe(403);

    const created = await http('POST', '/api/v1/setup', { json: { ...body, code } });
    expect(created.status).toBe(201);
    expect(created.json.user).toMatchObject({ name: 'ada', roles: ['admin'] });

    expect(
      (await http('POST', '/api/v1/setup', { json: { ...body, username: 'eve', code } })).status,
    ).toBe(404);
    expect((await http('GET', `/setup?code=${code}`)).status).toBe(404);
    expect((await http('GET', '/')).headers.get('location')).toBe('/login');
    const cookie = await login('ada');
    expect((await http('GET', '/api/v1/users', { cookie })).json.users).toHaveLength(1);
  });

  it('has no setup once a user exists, and creates no user through any other route', async () => {
    const { http, server, auth } = await fresh();
    const code = new URL(server.setupUrl as string).searchParams.get('code') as string;
    expect(
      (await http('POST', '/api/v1/users', { json: { name: 'eve', password: PASSWORD } })).status,
    ).toBe(401);
    await auth.createUser({ name: 'cli', password: PASSWORD });
    const late = await http('POST', '/api/v1/setup', {
      json: { code, username: 'ada', password: PASSWORD },
    });
    expect(late.status).toBe(404);
    expect(auth.listUsers().map((user) => user.name)).toEqual(['cli']);
  });

  it('serves the login page and its script to anyone', async () => {
    const { http } = await fresh();
    const page = await http('GET', '/login');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<form');
    const script = await http('GET', '/auth.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
  });

  it('serves the styles and the mark of the sign-in pages to anyone, and nothing more', async () => {
    const { http, base } = await fresh();
    const types = {
      '/tokens.css': 'text/css',
      '/auth.css': 'text/css',
      '/logo-mark.svg': 'image/svg+xml',
    };
    for (const [path, type] of Object.entries(types)) {
      const file = await http('GET', path);
      expect([path, file.status]).toEqual([path, 200]);
      expect(file.headers.get('content-type')).toContain(type);
      expect(file.headers.get('x-content-type-options')).toBe('nosniff');
      expect(file.headers.get('set-cookie')).toBeNull();
    }
    // The tokens are the one file the dashboard is built from as well.
    expect((await http('GET', '/tokens.css')).text).toContain('--surface-page:');
    expect((await http('GET', '/auth.css')).text).not.toContain('--surface-page:');

    // Both pages load exactly these, and carry no styles of their own.
    for (const path of ['/login', '/setup']) {
      const answer = await http('GET', path);
      // So the policy lets no style in that is written into a page.
      const policy = answer.headers.get('content-security-policy') ?? '';
      expect(policy.split('; ')).toContain("style-src 'self'");
      expect(policy).not.toContain('unsafe-inline');
      const page = answer.text;
      const loaded = [...page.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
      expect(loaded).toEqual(['/tokens.css', '/auth.css', '/logo-mark.svg', '/auth.js']);
      expect(page).not.toMatch(/<style|style="/);
    }

    // No other file became reachable without signing in: not the dashboard's, not the
    // pages under their file names, not a neighbour of the files above.
    const closed = {
      '/ui/index.css': 401,
      '/ui/logo-mark.svg': 401,
      '/style.css': 404,
      '/login.html': 404,
      '/setup.html': 404,
      '/auth.css.map': 404,
      '/tokens.css/': 404,
      '/public/tokens.css': 404,
      '/logo-mark.png': 404,
    };
    for (const [path, status] of Object.entries(closed)) {
      expect([path, (await http('GET', path)).status]).toEqual([path, status]);
    }

    // Paths that climb, sent as they are written here: `fetch` would tidy them up first.
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const { hostname, port } = new URL(base);
        const sent = rawRequest({ hostname, port, path, method: 'GET' }, (answer) => {
          let body = '';
          answer.setEncoding('utf8');
          answer.on('data', (chunk: string) => {
            body += chunk;
          });
          answer.on('end', () => resolve({ status: answer.statusCode ?? 0, body }));
        });
        sent.on('error', reject);
        sent.end();
      });
    // The helper does send what it is given: the file itself answers.
    expect((await raw('/tokens.css')).status).toBe(200);
    for (const path of [
      '/../public/tokens.css',
      '/%2e%2e/public/tokens.css',
      '/..%2fpublic%2ftokens.css',
      '/%2e%2e%2fpublic%2ftokens.css',
      '/..%2ftokens.css',
      '/%2e%2e%2ftokens.css',
      '/tokens.css/../auth.js/../../package.json',
      '/..%2f..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/..%5c..%5cpackage.json',
    ]) {
      const answer = await raw(path);
      // Refused, or answered with one of the files that are open anyway; never anything else.
      expect([path, [400, 404].includes(answer.status)]).toEqual([path, true]);
      expect(answer.body).not.toContain('"name"');
      expect(answer.body).not.toContain('--surface-page');
    }
  });
});

describe('bundles and roles at start', () => {
  it('applies the default roles of a bundle once, so a removed grant stays removed', async () => {
    const { auth, http, cookies } = await withRoles();
    expect(auth.policy().roles.viewer).toEqual(['bundle:board:view', 'system:dashboard.view']);
    expect(auth.policy().roles.graphics).toEqual(['bundle:board:view']);
    auth.revoke('graphics', 'bundle:board:view');
    const reload = await http('POST', '/api/v1/bundles/board/reload', {
      cookie: cookies.admin,
      json: {},
    });
    expect(reload.status).toBe(200);
    expect(auth.policy().roles.graphics).toEqual([]);
  });

  it('bumps system:revision when a bundle changes state', async () => {
    const { http, socket, cookies } = await withRoles();
    const ws = await socket({ cookie: cookies.operator }, 'system');
    cleanup.push(() => ws.close());
    const snapshot = await ws.ask({ t: 'rep.sub', name: 'revision' });
    expect(snapshot).toMatchObject({ t: 'rep.snap', value: { bundles: expect.any(Number) } });
    await http('POST', '/api/v1/bundles/secret/disable', { cookie: cookies.admin, json: {} });
    await vi.waitFor(() => expect(ws.pushed.some((msg) => msg.t === 'rep.patch')).toBe(true), WAIT);
  });
});

describe('extensions and senders', () => {
  it('tells an extension who asked, of what kind, and whether they hold a permission', async () => {
    const { http, socket, cookies, auth } = await withRoles();
    const operator = await socket({ cookie: cookies.operator });
    const viewer = await socket({ cookie: cookies.viewer });
    cleanup.push(
      () => operator.close(),
      () => viewer.close(),
    );
    const olga = auth.findUser('olga') as { id: string };

    expect(await operator.ask({ t: 'msg.req', name: 'whoami', data: null })).toMatchObject({
      t: 'msg.res',
      data: {
        sender: { principal: `user:${olga.id}`, kind: 'user', bundle: 'board' },
        operate: true,
      },
    });
    expect(await viewer.ask({ t: 'msg.req', name: 'whoami', data: null })).toMatchObject({
      data: { sender: { kind: 'user' }, operate: false },
    });

    const created = await http('POST', '/api/v1/tokens', {
      cookie: cookies.admin,
      json: { name: 'bot', grants: ['bundle:board:view', 'bundle:board:operate'] },
    });
    const bot = await socket({ authorization: `Bearer ${created.json.secret}` });
    cleanup.push(() => bot.close());
    expect(await bot.ask({ t: 'msg.req', name: 'whoami', data: null })).toMatchObject({
      data: {
        sender: { principal: `token:${created.json.token.id}`, kind: 'token' },
        operate: true,
      },
    });
  });
});

describe('listening beyond this machine', () => {
  it('warns about a non-loopback address without secure cookies, and only then', () => {
    expect(bindingWarning({ host: '0.0.0.0', secureCookies: false })).toMatch(/0\.0\.0\.0/);
    expect(bindingWarning({ host: '192.168.1.20', secureCookies: false })).toBeDefined();
    expect(bindingWarning({ host: '::', secureCookies: false })).toBeDefined();
    expect(bindingWarning({ host: '0.0.0.0', secureCookies: true })).toBeUndefined();
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) {
      expect(bindingWarning({ host, secureCookies: false }), host).toBeUndefined();
    }
  });

  it('logs no warning on loopback', async () => {
    const local = await fresh();
    expect(local.lines.some((line) => line.startsWith('WARN'))).toBe(false);
  });
});
