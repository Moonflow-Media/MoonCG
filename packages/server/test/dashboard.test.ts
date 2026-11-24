import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, startAuthServer, startWithRoles } from './auth-helpers.js';
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

describe('the dashboard application', () => {
  const PAGES = [
    '/',
    '/w/show',
    '/bundles',
    '/graphics',
    '/assets',
    '/admin/users',
    '/admin/roles',
    '/admin/tokens',
    '/settings',
    '/logs',
  ];

  it('is served for every one of its routes, with the policy of a built-in page', async () => {
    const { http, cookies } = await withRoles();
    for (const path of PAGES) {
      const answer = await http('GET', path, { cookie: cookies.operator });
      expect(answer.status, path).toBe(200);
      expect(answer.text).toContain('dashboard fixture');
      expect(answer.headers.get('content-type')).toContain('text/html');
      expect(answer.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(answer.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('serves its built files, and nothing outside their folder', async () => {
    const { http, cookies } = await withRoles();
    const script = await http('GET', '/ui/app.js', { cookie: cookies.viewer });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.text).toContain('fixture');
    expect((await http('GET', '/ui/missing.js', { cookie: cookies.viewer })).status).toBe(404);
    expect((await http('GET', '/ui/..%2Findex.html', { cookie: cookies.viewer })).status).toBe(404);
    expect((await http('GET', '/shell.js', { cookie: cookies.admin })).status).toBe(404);
  });

  it('sends whoever is not signed in to the login, and refuses who may not see the dashboard', async () => {
    const { http, cookies } = await withRoles();
    for (const path of ['/', '/bundles', '/w/show']) {
      const anonymous = await http('GET', path);
      expect([anonymous.status, anonymous.headers.get('location')]).toEqual([302, '/login']);
      expect((await http('GET', path, { cookie: cookies.graphics })).status).toBe(403);
    }
    expect((await http('GET', '/ui/app.js')).status).toBe(401);
    // Paths that are no route of the dashboard are not found, whoever asks.
    expect((await http('GET', '/w', { cookie: cookies.admin })).status).toBe(404);
    expect((await http('GET', '/admin/other', { cookie: cookies.admin })).status).toBe(404);
  });

  it('says how to get the dashboard when it has not been built', async () => {
    const context = await startAuthServer(temporary, {}, { dashboardDir: undefined });
    cleanup.push(() => context.server.close());
    await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const answer = await context.http('GET', '/', { cookie: await context.login('ada') });
    expect(answer.status).toBe(404);
    expect(answer.json.error.message).toMatch(/pnpm build/);
  });
});

describe('preferences of a user', () => {
  const put = (value: unknown) => ({ json: { value } });

  it('are kept per user and key', async () => {
    const { http, cookies } = await withRoles();
    const mine = { cookie: cookies.operator };
    expect((await http('GET', '/api/v1/me/prefs/layout.show', mine)).json).toEqual({ value: null });
    const layout = { panels: [{ id: 'board:control', w: 4, h: 2 }] };
    const saved = await http('PUT', '/api/v1/me/prefs/layout.show', { ...mine, ...put(layout) });
    expect(saved.status).toBe(204);
    expect((await http('GET', '/api/v1/me/prefs/layout.show', mine)).json).toEqual({
      value: layout,
    });
    await http('PUT', '/api/v1/me/prefs/layout.show', { ...mine, ...put([1, 2]) });
    expect((await http('GET', '/api/v1/me/prefs/layout.show', mine)).json).toEqual({
      value: [1, 2],
    });
    const other = await http('GET', '/api/v1/me/prefs/layout.show', { cookie: cookies.viewer });
    expect(other.json).toEqual({ value: null });
  });

  it('follow the user to another browser and go when the user is deleted', async () => {
    const { http, cookies, login, auth, server } = await withRoles();
    await http('PUT', '/api/v1/me/prefs/theme', { cookie: cookies.viewer, ...put('dark') });
    const elsewhere = await login('vera');
    expect((await http('GET', '/api/v1/me/prefs/theme', { cookie: elsewhere })).json).toEqual({
      value: 'dark',
    });
    const vera = (auth.findUser('vera') as { id: string }).id;
    auth.deleteUser(vera);
    expect(server.storage.auth.prefs.count(vera)).toBe(0);
  });

  it('belong to signed-in users only', async () => {
    const { http, cookies } = await withRoles();
    expect((await http('GET', '/api/v1/me/prefs/theme')).status).toBe(401);
    expect((await http('PUT', '/api/v1/me/prefs/theme', put('dark'))).status).toBe(401);
    const created = await http('POST', '/api/v1/tokens', {
      cookie: cookies.admin,
      json: { name: 't', grants: ['*'] },
    });
    const token = { bearer: created.json.secret as string };
    expect((await http('GET', '/api/v1/me/prefs/theme', token)).status).toBe(403);
    expect((await http('PUT', '/api/v1/me/prefs/theme', { ...token, ...put('dark') })).status).toBe(
      403,
    );
  });

  it('are limited in name, size and number', async () => {
    const { http, cookies } = await withRoles();
    const mine = { cookie: cookies.operator };
    const set = (key: string, body: object) =>
      http('PUT', `/api/v1/me/prefs/${key}`, { ...mine, ...body });
    expect((await set('Bad%20Key', put(1))).status).toBe(400);
    expect((await set('k'.repeat(65), put(1))).status).toBe(400);
    expect((await set('theme', { json: { other: 1 } })).status).toBe(400);
    expect((await set('theme', put('x'.repeat(20_000)))).status).toBe(413);
    for (let i = 0; i < 50; i++) expect((await set(`key${i}`, put(i))).status).toBe(204);
    expect((await set('one-more', put(1))).status).toBe(409);
    // Replacing one that exists is still possible at the limit.
    expect((await set('key0', put('again'))).status).toBe(204);
  });
});
