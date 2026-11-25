import { afterEach, describe, expect, it } from 'vitest';
import { BUILT_IN_CSP } from '../src/http/app.js';
import { type AuthServer, authBundles, PASSWORD, startAuthServer } from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: AuthServer | undefined;
afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

const DEV_SERVER = 'http://localhost:5173';

/** The usual bundles and `vite`, whose manifest names a development server. */
async function start(dev: boolean, url = DEV_SERVER): Promise<AuthServer> {
  const bundlesDir = await temporary.create({
    ...authBundles(),
    'vite/mooncg.json': manifest('vite', {
      permissions: { view: 'See it', operate: 'Use it' },
      defaultRoles: { operator: ['view', 'operate'], viewer: ['view'] },
      panels: [{ id: 'panel', title: 'Panel', file: 'dashboard/panel.html', requires: 'operate' }],
      graphics: [{ id: 'overlay', file: 'graphics/over lay.html', width: 1920, height: 1080 }],
      assets: [{ id: 'logos' }],
      dev: { url },
    }),
    'vite/dashboard/panel.html': 'the built panel',
    'vite/graphics/over lay.html': 'the built overlay',
  });
  context = await startAuthServer(temporary, { dev, bundlesDir });
  return context;
}

/** Signs in as a user of the given role, so that the request does not act as the dev user. */
async function as(server: AuthServer, role: string | undefined): Promise<{ cookie: string }> {
  const name = `user-${role ?? 'none'}`;
  await server.auth.createUser({ name, password: PASSWORD, roles: role ? [role] : [] });
  return { cookie: await server.login(name) };
}

describe('dev.url in dev mode', () => {
  it('sends requests for panel and graphic files to the development server', async () => {
    const { http } = await start(true);

    const panel = await http('GET', '/b/vite/dashboard/panel.html');
    const graphic = await http('GET', '/b/vite/graphics/over%20lay.html?scene=2&x=a%20b');
    const other = await http('GET', '/b/vite/dashboard/src/main.ts');

    expect(panel.status).toBe(302);
    expect(panel.headers.get('location')).toBe(`${DEV_SERVER}/dashboard/panel.html`);
    expect(graphic.headers.get('location')).toBe(
      `${DEV_SERVER}/graphics/over%20lay.html?scene=2&x=a%20b`,
    );
    // The development server knows files MoonCG has never seen.
    expect(other.headers.get('location')).toBe(`${DEV_SERVER}/dashboard/src/main.ts`);
    expect(panel.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps a query whole, also one with a question mark in it', async () => {
    const { http } = await start(true);
    const answer = await http('GET', '/b/vite/dashboard/panel.html?next=/a?b=1&q=what?');
    expect(answer.headers.get('location')).toBe(
      `${DEV_SERVER}/dashboard/panel.html?next=/a?b=1&q=what?`,
    );
  });

  it('keeps the path the address of the development server has', async () => {
    const { http } = await start(true, 'http://127.0.0.1:5173/base/');
    const panel = await http('GET', '/b/vite/dashboard/panel.html');
    expect(panel.headers.get('location')).toBe('http://127.0.0.1:5173/base/dashboard/panel.html');
  });

  it('serves the bundles without a development server from disk as ever', async () => {
    const { http } = await start(true);
    const answer = await http('GET', '/b/board/dashboard/control.html');
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('board control');
  });

  it('redirects nothing but the pages: no assets, no routes, no unsafe path', async () => {
    const { http } = await start(true);
    expect((await http('GET', '/b/vite/assets/logos/missing.png')).status).toBe(404);
    expect((await http('GET', '/b/vite/api/anything')).status).toBe(404);
    expect((await http('GET', '/b/vite/extension/index.js')).status).toBe(404);
    expect((await http('GET', '/b/vite/dashboard/..%2f..%2fsecret')).status).toBe(404);
    expect((await http('GET', '/b/vite/dashboard/%5c%5cevil.example/x')).status).toBe(404);
  });

  it('checks permissions before it redirects', async () => {
    const server = await start(true);
    const viewer = await as(server, 'viewer');
    const nobody = await as(server, undefined);

    expect((await server.http('GET', '/b/vite/dashboard/panel.html', viewer)).status).toBe(403);
    expect((await server.http('GET', '/b/vite/graphics/over%20lay.html', viewer)).status).toBe(302);
    expect((await server.http('GET', '/b/vite/dashboard/panel.html', nobody)).status).toBe(404);
  });

  it('names the origin of the development server in the list of bundles, for dialogs', async () => {
    const server = await start(true, `${DEV_SERVER}/b/vite/`);
    const admin = await as(server, 'admin');
    const { bundles } = (await server.http('GET', '/api/v1/bundles', admin)).json;
    const vite = bundles.find((bundle: { name: string }) => bundle.name === 'vite');
    expect(vite.devOrigin).toBe(DEV_SERVER);
    const board = bundles.find((bundle: { name: string }) => bundle.name === 'board');
    expect(board.devOrigin).toBeUndefined();
  });

  it('lets pages of the development server open a socket and change things', async () => {
    const { http, upgrade } = await start(true);

    expect(await upgrade({ origin: DEV_SERVER })).toBe(101);
    expect(await upgrade({ origin: 'http://localhost:5174' })).toBe(403);
    expect(await upgrade({ origin: 'http://evil.example:5173' })).toBe(403);
    const change = await http('POST', '/api/v1/bundles/board/reload', {
      json: {},
      headers: { origin: DEV_SERVER },
    });
    expect(change.status).toBe(200);
  });

  it('lets the dashboard frame the development server, and nothing else from elsewhere', async () => {
    const { http } = await start(true);
    const page = await http('GET', '/');
    const policy = page.headers.get('content-security-policy') ?? '';

    expect(policy).toContain(`frame-src 'self' ${DEV_SERVER}`);
    // Everything else is the policy as it always is.
    expect(policy.replace(`; frame-src 'self' ${DEV_SERVER}`, '')).toBe(BUILT_IN_CSP);
    const login = await http('GET', '/login');
    expect(login.headers.get('content-security-policy')).toBe(BUILT_IN_CSP);
  });

  it('stops allowing the origin once the bundle no longer runs', async () => {
    const { http, upgrade, server } = await start(true);
    await server.manager.disable('vite');

    expect(await upgrade({ origin: DEV_SERVER })).toBe(403);
    const page = await http('GET', '/');
    expect(page.headers.get('content-security-policy')).toBe(BUILT_IN_CSP);
  });
});

describe('dev.url outside dev mode', () => {
  it('is not honoured: the files come from disk', async () => {
    const server = await start(false);
    const admin = await as(server, 'admin');

    const panel = await server.http('GET', '/b/vite/dashboard/panel.html', admin);

    expect(panel.status).toBe(200);
    expect(panel.text).toBe('the built panel');
  });

  it('allows no origin and loosens no policy', async () => {
    const server = await start(false);
    const admin = await as(server, 'admin');

    expect(await server.upgrade({ ...admin, origin: DEV_SERVER })).toBe(403);
    const change = await server.http('POST', '/api/v1/bundles/board/reload', {
      ...admin,
      json: {},
      headers: { origin: DEV_SERVER },
    });
    expect(change.status).toBe(403);
    const page = await server.http('GET', '/', admin);
    expect(page.headers.get('content-security-policy')).toBe(BUILT_IN_CSP);
    const { bundles } = (await server.http('GET', '/api/v1/bundles', admin)).json;
    expect(bundles.find((bundle: { name: string }) => bundle.name === 'vite').devOrigin).toBe(
      undefined,
    );
  });
});
