import { afterEach, describe, expect, it } from 'vitest';
import {
  authBundles,
  cookiePair,
  PASSWORD,
  startAuthServer,
  startWithRoles,
} from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

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

type Rest = Parameters<typeof startAuthServer> extends [unknown, ...infer R] ? R : never;
async function fresh(...args: Rest) {
  const context = await startAuthServer(temporary, ...args);
  cleanup.push(() => context.server.close());
  return context;
}

const statuses = (answers: { status: number }[]) =>
  answers.reduce<Record<number, number>>((count, { status }) => {
    count[status] = (count[status] ?? 0) + 1;
    return count;
  }, {});

describe('setup over HTTP', () => {
  it('creates one administrator when the code is used six times at once', async () => {
    const { http, server, auth } = await fresh();
    const code = new URL(server.setupUrl as string).searchParams.get('code') as string;
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        http('POST', '/api/v1/setup', {
          json: { code, username: `admin${index}`, password: PASSWORD },
        }),
      ),
    );
    expect(statuses(answers)).toEqual({ 201: 1, 404: 5 });
    expect(auth.listUsers()).toHaveLength(1);
  });
});

describe('login under load and with odd input', () => {
  it('throttles a burst of wrong logins that arrive together', async () => {
    const { http, auth } = await fresh();
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const answers = await Promise.all(
      Array.from({ length: 60 }, () =>
        http('POST', '/api/v1/auth/login', {
          json: { username: 'ada', password: 'wrong password' },
        }),
      ),
    );
    expect(statuses(answers)).toEqual({ 401: 5, 429: 55 });
  });

  it('answers an impossible user name and an over-long password with the generic 401', async () => {
    const { http, auth } = await fresh();
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const wrong = await http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: 'wrong password' },
    });
    const before = auth.stats().throttleKeys;
    const longName = await http('POST', '/api/v1/auth/login', {
      json: { username: 'a'.repeat(5000), password: PASSWORD },
    });
    const longPassword = await http('POST', '/api/v1/auth/login', {
      json: { username: 'bob', password: 'p'.repeat(5000) },
    });
    expect([longName.status, longPassword.status]).toEqual([401, 401]);
    expect(longName.json).toEqual(wrong.json);
    expect(longPassword.json).toEqual(wrong.json);
    expect(auth.stats().throttleKeys).toBe(before);
  });

  it('refuses a large body on the account routes before reading it', async () => {
    const { http, cookies } = await withRoles();
    const big = { username: 'a'.repeat(100_000), password: PASSWORD };
    expect((await http('POST', '/api/v1/auth/login', { json: big })).status).toBe(413);
    const users = await http('POST', '/api/v1/users', {
      cookie: cookies.admin,
      json: { name: 'bob', password: 'p'.repeat(100_000) },
    });
    expect(users.status).toBe(413);
    // Bundle routes keep the configured limit.
    const route = await http('POST', '/b/board/api/score', {
      cookie: cookies.admin,
      json: { filler: 'x'.repeat(100_000) },
    });
    expect(route.status).toBe(200);
  });

  it('throttles wrong current passwords when changing the own password', async () => {
    const { http, cookies } = await withRoles();
    const attempt = (current: string) =>
      http('POST', '/api/v1/me/password', {
        cookie: cookies.viewer,
        json: { current, password: 'next password' },
      });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong password')).status).toBe(403);
    const blocked = await attempt(PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('managing users without holding everything', () => {
  /** A user who may manage users and see the board, and nothing else. */
  async function withManager() {
    const context = await withRoles();
    const { auth, login } = context;
    auth.createRole('manager', ['system:users.manage', 'bundle:board:view']);
    await auth.createUser({ name: 'mia', password: PASSWORD, roles: ['manager'] });
    const mia = { cookie: await login('mia') };
    const id = (name: string) => (auth.findUser(name) as { id: string }).id;
    return { ...context, mia, id };
  }

  it('cannot make itself or anyone an administrator', async () => {
    const { http, mia, id, auth } = await withManager();
    const self = await http('PUT', `/api/v1/users/${id('mia')}/roles/admin`, { ...mia, json: {} });
    expect(self.status).toBe(403);
    expect(self.json.error.message).toMatch(/do not hold/);
    const created = await http('POST', '/api/v1/users', {
      ...mia,
      json: { name: 'eve', password: PASSWORD, roles: ['admin'] },
    });
    expect(created.status).toBe(403);
    const granted = await http('POST', '/api/v1/roles/manager/grants', {
      ...mia,
      json: { permission: '*' },
    });
    expect(granted.status).toBe(403);
    const role = await http('POST', '/api/v1/roles', {
      ...mia,
      json: { name: 'boss', grants: ['*'] },
    });
    expect(role.status).toBe(403);
    expect(auth.findUser('mia')?.roles).toEqual(['manager']);
    expect(auth.findUser('eve')).toBeUndefined();
    expect(auth.policy().roles.manager).not.toContain('*');
  });

  it('cannot take over or remove someone who holds more', async () => {
    const { http, mia, id, auth, login } = await withManager();
    const ada = id('ada');
    const reset = await http('PUT', `/api/v1/users/${ada}/password`, {
      ...mia,
      json: { password: 'taken over now' },
    });
    const disable = await http('PATCH', `/api/v1/users/${ada}`, {
      ...mia,
      json: { disabled: true },
    });
    const rename = await http('PATCH', `/api/v1/users/${ada}`, { ...mia, json: { name: 'gone' } });
    const remove = await http('DELETE', `/api/v1/users/${ada}`, { ...mia, json: {} });
    const demote = await http('DELETE', `/api/v1/users/${ada}/roles/admin`, { ...mia, json: {} });
    const dropRole = await http('DELETE', '/api/v1/roles/operator', { ...mia, json: {} });
    const revoke = await http(
      'DELETE',
      `/api/v1/roles/operator/grants/${encodeURIComponent('bundle:board:operate')}`,
      { ...mia, json: {} },
    );
    expect([reset, disable, rename, remove, demote, dropRole, revoke].map((a) => a.status)).toEqual(
      [403, 403, 403, 403, 403, 403, 403],
    );
    expect(auth.findUser('ada')).toMatchObject({ disabled: false, roles: ['admin'] });
    await expect(login('ada')).resolves.toBeDefined();
  });

  it('can still manage what it fully holds', async () => {
    const { http, mia, id, auth } = await withManager();
    auth.createRole('board-viewer', ['bundle:board:view']);
    const created = await http('POST', '/api/v1/users', {
      ...mia,
      json: { name: 'bob', password: PASSWORD, roles: ['board-viewer'] },
    });
    expect(created.status).toBe(201);
    const bob = id('bob');
    expect(
      (
        await http('PUT', `/api/v1/users/${bob}/password`, {
          ...mia,
          json: { password: 'new password' },
        })
      ).status,
    ).toBe(204);
    expect(
      (await http('PATCH', `/api/v1/users/${bob}`, { ...mia, json: { disabled: true } })).status,
    ).toBe(200);
    expect(
      (await http('DELETE', `/api/v1/users/${bob}/roles/board-viewer`, { ...mia, json: {} }))
        .status,
    ).toBe(204);
    expect(
      (
        await http('POST', '/api/v1/roles/board-viewer/grants', {
          ...mia,
          json: { permission: 'system:users.manage' },
        })
      ).status,
    ).toBe(200);
    expect((await http('DELETE', `/api/v1/users/${bob}`, { ...mia, json: {} })).status).toBe(204);
  });

  it('leaves an administrator free to do all of it', async () => {
    const { http, cookies, id } = await withManager();
    const admin = { cookie: cookies.admin };
    expect(
      (await http('PUT', `/api/v1/users/${id('mia')}/roles/admin`, { ...admin, json: {} })).status,
    ).toBe(204);
    expect(
      (await http('POST', '/api/v1/roles/manager/grants', { ...admin, json: { permission: '*' } }))
        .status,
    ).toBe(200);
  });
});

describe('a bundle the principal holds nothing of', () => {
  it('answers 404 for its files and routes, exactly like a bundle that does not exist', async () => {
    const { http, auth, login, cookies } = await withRoles();
    auth.createRole('secret-viewer', ['bundle:secret:view']);
    await auth.createUser({ name: 'sam', password: PASSWORD, roles: ['secret-viewer'] });
    const sam = { cookie: await login('sam') };
    const same = async (hidden: string, absent: string, method = 'GET') => {
      const options = method === 'GET' ? sam : { ...sam, json: {} };
      const a = await http(method, hidden, options);
      const b = await http(method, absent, options);
      expect([a.status, b.status], hidden).toEqual([404, 404]);
      expect(a.text).toBe(b.text);
    };
    await same('/b/board/graphics/overlay.html', '/b/nope/graphics/overlay.html');
    await same('/b/board/dashboard/control.html', '/b/nope/dashboard/control.html');
    await same('/b/board/graphics/missing.html', '/b/nope/graphics/missing.html');
    await same('/b/board/api/public', '/b/nope/api/public');
    await same('/b/board/api/score', '/b/nope/api/score', 'POST');
    await same('/b/board/api/nothing', '/b/nope/api/nothing');
    expect((await http('GET', '/b/secret/graphics/g.html', sam)).status).toBe(200);
    // Seeing the bundle but lacking the one permission is still a 403.
    const viewer = await http('GET', '/b/board/dashboard/control.html', { cookie: cookies.viewer });
    expect(viewer.status).toBe(403);
    const route = await http('POST', '/b/board/api/score', { cookie: cookies.viewer, json: {} });
    expect(route.status).toBe(403);
  });

  it('cannot be entered or read on a socket', async () => {
    const { auth, login, upgrade, socket } = await withRoles();
    auth.createRole('secret-viewer', ['bundle:secret:view']);
    await auth.createUser({ name: 'sam', password: PASSWORD, roles: ['secret-viewer'] });
    const cookie = await login('sam');
    expect(await upgrade({ cookie })).toBe(101);
    await expect(socket({ cookie }, 'board')).rejects.toThrow(/hello/);
    const ws = await socket({ cookie }, 'secret');
    cleanup.push(() => ws.close());
    expect(await ws.ask({ t: 'rep.sub', name: 'board:score' })).toMatchObject({
      t: 'err',
      code: 'not_found',
    });
  });
});

describe('response headers', () => {
  it('forbid framing the built-in pages and restrict what they load', async () => {
    const { http, cookies } = await withRoles();
    for (const answer of [
      await http('GET', '/login'),
      await http('GET', '/', { cookie: cookies.admin }),
    ]) {
      const csp = answer.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("base-uri 'none'");
      expect(answer.headers.get('x-frame-options')).toBe('DENY');
    }
    const setup = await fresh();
    const page = await setup.http('GET', '/setup');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('let bundle pages be framed by this server only, and set no policy on their content', async () => {
    const { http, cookies } = await withRoles();
    for (const path of ['/b/board/dashboard/control.html', '/b/board/graphics/overlay.html']) {
      const answer = await http('GET', path, { cookie: cookies.admin });
      expect(answer.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      expect(answer.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    }
  });

  it('send nosniff and a same-origin referrer policy with everything', async () => {
    const { http, cookies } = await withRoles();
    const admin = { cookie: cookies.admin };
    for (const answer of [
      await http('GET', '/login'),
      await http('GET', '/api/v1/me', admin),
      await http('GET', '/api/v1/me'),
      await http('GET', '/sdk/mooncg.js', admin),
      await http('GET', '/b/board/graphics/style.css', admin),
      await http('GET', '/b/board/api/public', admin),
      await http('GET', '/nowhere'),
    ]) {
      expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
      expect(answer.headers.get('referrer-policy')).toBe('same-origin');
    }
  });
});

describe('a token in the URL next to other credentials', () => {
  async function withToken() {
    const context = await withRoles();
    const created = await context.http('POST', '/api/v1/tokens', {
      cookie: context.cookies.admin,
      json: { name: 'OBS', grants: ['bundle:board:view'] },
    });
    return { ...context, secret: created.json.secret as string };
  }
  const page = '/b/board/graphics/overlay.html';

  it('does not get in the way of a valid bearer token or session', async () => {
    const { http, cookies, secret } = await withToken();
    for (const credentials of [{ bearer: secret }, { cookie: cookies.viewer }]) {
      const answer = await http('GET', `${page}?a=1&token=mcg_wrong`, credentials);
      expect(answer.status).toBe(302);
      expect(answer.headers.get('location')).toBe(`${page}?a=1`);
      expect(answer.setCookies).toEqual([]);
    }
  });

  it('is not exchanged when the request is signed in already', async () => {
    const { http, cookies, secret } = await withToken();
    const answer = await http('GET', `${page}?token=${secret}`, { cookie: cookies.admin });
    expect(answer.status).toBe(302);
    expect(answer.setCookies).toEqual([]);
  });

  it('is still refused when it is the only credential and wrong', async () => {
    const { http } = await withToken();
    expect((await http('GET', `${page}?token=mcg_wrong`)).status).toBe(401);
    expect(
      (await http('GET', `${page}?token=mcg_wrong`, { cookie: 'mooncg_session=stale' })).status,
    ).toBe(401);
  });

  it('gets a cookie that lasts no longer than its session', async () => {
    const { http, secret } = await withToken();
    const answer = await http('GET', `${page}?token=${secret}`);
    expect(answer.setCookies[0]).toMatch(new RegExp(`Max-Age=${90 * 24 * 60 * 60}$`));
  });
});

describe('session cookies', () => {
  it('are refused when the same one is sent twice', async () => {
    const { http, cookies } = await withRoles();
    const twice = `${cookies.admin}; mooncg_session=other`;
    expect((await http('GET', '/api/v1/me', { cookie: twice })).status).toBe(401);
    expect(
      (await http('GET', '/api/v1/me', { cookie: `mooncg_session=other; ${cookies.admin}` }))
        .status,
    ).toBe(401);
    expect(
      (await http('GET', '/api/v1/me', { cookie: `theme=dark; ${cookies.admin}` })).status,
    ).toBe(200);
  });

  it('carry the __Host- prefix when they are Secure, and only that name is read then', async () => {
    const { http, auth } = await fresh({ secureCookies: true });
    await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const login = await http('POST', '/api/v1/auth/login', {
      json: { username: 'ada', password: PASSWORD },
    });
    const [setCookie] = login.setCookies as [string];
    expect(setCookie).toMatch(
      /^__Host-mooncg_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
    const cookie = cookiePair(setCookie);
    expect((await http('GET', '/api/v1/me', { cookie })).status).toBe(200);
    const plain = cookie.replace('__Host-', '');
    expect((await http('GET', '/api/v1/me', { cookie: plain })).status).toBe(401);

    const created = await http('POST', '/api/v1/tokens', {
      cookie,
      json: { name: 't', grants: ['*'] },
    });
    const exchanged = await http(
      'GET',
      `/b/board/graphics/overlay.html?token=${created.json.secret}`,
    );
    expect(exchanged.setCookies[0]).toMatch(/^__Host-mooncg_token=/);
    const out = await http('POST', '/api/v1/auth/logout', { cookie, json: {} });
    expect(out.setCookies.join()).toMatch(/__Host-mooncg_session=;.*Max-Age=0/);
  });
});

describe('the origin check', () => {
  const login = { json: { username: 'ada', password: PASSWORD } };

  it('compares the scheme as well as host and port', async () => {
    const { http, auth, server, upgrade } = await fresh();
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const host = `127.0.0.1:${server.port}`;
    const as = (origin: string) =>
      http('POST', '/api/v1/auth/login', { ...login, headers: { origin } });
    expect((await as(`http://${host}`)).status).toBe(200);
    expect((await as(`https://${host}`)).status).toBe(403);
    expect(await upgrade({ origin: `https://${host}` })).toBe(403);
    // Refused for the origin, not for the missing credentials.
    expect(await upgrade({ origin: `http://${host}` })).toBe(401);
  });

  it('takes the server for HTTPS behind a trusted proxy that says so', async () => {
    const { http, auth, server } = await fresh({ trustProxy: true });
    await auth.createUser({ name: 'ada', password: PASSWORD });
    const host = `127.0.0.1:${server.port}`;
    const as = (origin: string, proto?: string) =>
      http('POST', '/api/v1/auth/login', {
        ...login,
        headers: { origin, ...(proto === undefined ? {} : { 'x-forwarded-proto': proto }) },
      });
    expect((await as(`https://${host}`, 'https')).status).toBe(200);
    expect((await as(`http://${host}`, 'https')).status).toBe(403);
    expect((await as(`http://${host}`)).status).toBe(200);
  });
});

describe('passwords and tokens over HTTP', () => {
  it('revokes tokens on an admin reset unless told otherwise, and keeps them on an own change unless asked', async () => {
    const { http, cookies, auth } = await withRoles();
    auth.grant('operator', 'system:tokens.manage');
    const olga = (auth.findUser('olga') as { id: string }).id;
    const token = async () =>
      (
        await http('POST', '/api/v1/tokens', {
          cookie: cookies.operator,
          json: { name: 'deck', grants: ['bundle:board:view'] },
        })
      ).json.secret as string;
    const works = async (secret: string) =>
      (await http('GET', '/api/v1/me', { bearer: secret })).status === 200;
    const admin = { cookie: cookies.admin };

    const kept = await token();
    await http('PUT', `/api/v1/users/${olga}/password`, {
      ...admin,
      json: { password: 'second password', revokeTokens: false },
    });
    expect(await works(kept)).toBe(true);
    await http('PUT', `/api/v1/users/${olga}/password`, { ...admin, json: { password: PASSWORD } });
    expect(await works(kept)).toBe(false);

    const session = cookiePair(
      (await http('POST', '/api/v1/auth/login', { json: { username: 'olga', password: PASSWORD } }))
        .setCookies[0] as string,
    );
    const own = (
      await http('POST', '/api/v1/tokens', {
        cookie: session,
        json: { name: 'deck2', grants: ['bundle:board:view'] },
      })
    ).json.secret as string;
    const changed = await http('POST', '/api/v1/me/password', {
      cookie: session,
      json: { current: PASSWORD, password: 'third password' },
    });
    expect(changed.status).toBe(204);
    expect(await works(own)).toBe(true);
    const renewed = cookiePair(changed.setCookies[0] as string);
    const again = await http('POST', '/api/v1/me/password', {
      cookie: renewed,
      json: { current: 'third password', password: 'fourth password', revokeTokens: true },
    });
    expect(again.status).toBe(204);
    expect(await works(own)).toBe(false);
    const bad = await http('PUT', `/api/v1/users/${olga}/password`, {
      ...admin,
      json: { password: PASSWORD, revokeTokens: 'yes' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('bundle errors', () => {
  it('never show an API token, in the list or in the replicant', async () => {
    const files = {
      ...authBundles(),
      'leaky/mooncg.json': manifest('leaky', { extension: 'extension/index.js' }),
      'leaky/extension/index.js':
        "export default function start() { throw new Error('GET /x?token=mcg_Leaked-Secret_1 failed'); }",
    };
    const context = await startAuthServer(temporary, { bundlesDir: await temporary.create(files) });
    cleanup.push(() => context.server.close());
    const { http, auth, login, socket } = context;
    await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const cookie = await login('ada');
    const list = await http('GET', '/api/v1/bundles', { cookie });
    const leaky = list.json.bundles.find((bundle: { name: string }) => bundle.name === 'leaky');
    expect(leaky.state).toBe('failed');
    expect(leaky.lastError).toContain('token=mcg_***');
    expect(list.text).not.toContain('Leaked');
    const ws = await socket({ cookie }, 'system');
    cleanup.push(() => ws.close());
    const snapshot = await ws.ask({ t: 'rep.sub', name: 'bundles' });
    expect(JSON.stringify(snapshot)).toContain('mcg_***');
    expect(JSON.stringify(snapshot)).not.toContain('Leaked');
  });
});

describe('a bundle route handler', () => {
  it('is told who calls it', async () => {
    const { http, cookies, auth } = await withRoles();
    const olga = (auth.findUser('olga') as { id: string }).id;
    const viaCookie = await http('GET', '/b/board/api/public', { cookie: cookies.operator });
    expect(viaCookie.json.sender).toEqual({
      principal: `user:${olga}`,
      kind: 'user',
      bundle: 'board',
    });
    expect(viaCookie.json.operate).toBe(true);
    const created = await http('POST', '/api/v1/tokens', {
      cookie: cookies.admin,
      json: { name: 'OBS', grants: ['bundle:board:view'] },
    });
    const viaToken = await http('GET', '/b/board/api/public', { bearer: created.json.secret });
    expect(viaToken.json.sender).toEqual({
      principal: `token:${created.json.token.id}`,
      kind: 'token',
      bundle: 'board',
    });
    expect(viaToken.json.operate).toBe(false);
  });
});
