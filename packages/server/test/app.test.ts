import { ANONYMOUS_PRINCIPAL, type Policy, type Principal, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBundles } from '../src/bundles/bundles.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { type AppOptions, createApp, resolveLocalAdmin } from '../src/http/app.js';
import { fixture, memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const apps: { close(): Promise<unknown> }[] = [];
const temporary = temporaryBundles();
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await temporary.cleanup();
});

async function setup(overrides: Partial<AppOptions> = {}, bundlesDir = fixture('bundles')) {
  const registry = new ReplicantRegistry();
  const { logger } = memoryLogger();
  const bundles = await loadBundles({
    bundlesDir,
    registry,
    host: new InlineHost({ registry, logger }),
    logger,
  });
  const app = await createApp({
    resolvePrincipal: resolveLocalAdmin,
    bundles,
    sdkFile: fixture('sdk/mooncg.js'),
    dashboardDir: fixture('dashboard'),
    ...overrides,
  });
  apps.push(app);
  return app;
}

/** A principal that may open the dashboard and view, but not operate, the `good` bundle. */
const viewer: Principal = { id: 'viewer', roles: ['viewer'] };
const viewerPolicy: Policy = {
  roles: { viewer: ['system:dashboard.view', 'bundle:good:view'] },
};
const asViewer = { policy: viewerPolicy, resolvePrincipal: () => viewer };
const asNobody = { policy: { roles: {} }, resolvePrincipal: () => viewer };

describe('shell', () => {
  it('serves the dashboard page and its built files', async () => {
    const app = await setup();

    const page = await app.inject({ url: '/' });
    const script = await app.inject({ url: '/ui/app.js' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('dashboard fixture');
    expect(page.body).toContain('/ui/app.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.body).toContain('fixture');
  });
});

describe('GET /api/v1/bundles', () => {
  it('lists every bundle with its state, panels, graphics and errors', async () => {
    const app = await setup();

    const response = await app.inject({ url: '/api/v1/bundles' });
    const { bundles } = response.json();

    expect(response.statusCode).toBe(200);
    expect(bundles.map((bundle: { name: string }) => bundle.name)).toEqual([
      'broken',
      'crashy',
      'good',
      'no-manifest',
      'wrong-name',
    ]);
    expect(bundles[2]).toEqual({
      name: 'good',
      state: 'running',
      title: 'Good',
      version: '1.0.0',
      errors: [],
      dependencies: [],
      panels: [
        { id: 'control', title: 'Control', width: 2, url: '/b/good/dashboard/control.html' },
      ],
      dialogs: [],
      assets: [],
      graphics: [
        {
          id: 'overlay',
          width: 1920,
          height: 1080,
          singleInstance: false,
          url: '/b/good/graphics/overlay.html',
        },
      ],
    });
    expect(bundles[0]).toMatchObject({ name: 'broken', state: 'failed', panels: [], graphics: [] });
    expect(bundles[0].errors).toHaveLength(3);
    expect(bundles[1]).toMatchObject({
      name: 'crashy',
      state: 'failed',
      errors: ['Extension failed to start: crashy failed on purpose'],
    });
  });

  it('leaves out panels and graphics the principal may not use', async () => {
    const app = await setup(asViewer);
    const { bundles, canManage } = (await app.inject({ url: '/api/v1/bundles' })).json();
    // Of the bundles, the viewer holds a permission of `good` only, so that is all it is shown.
    expect(bundles.map((bundle: { name: string }) => bundle.name)).toEqual(['good']);
    expect(bundles[0].panels).toEqual([]);
    expect(bundles[0].graphics).toHaveLength(1);
    expect(canManage).toBe(false);
  });

  describe('the bundles a bundle needs', () => {
    const permissions = { permissions: { view: 'See it' } };
    const needy = async (overrides: Partial<AppOptions> = {}) => {
      const dir = await temporary.create({
        'base/mooncg.json': manifest('base', permissions),
        'extra/mooncg.json': manifest('extra', permissions),
        'consumer/mooncg.json': manifest('consumer', {
          ...permissions,
          dependencies: { base: '^1.0.0', extra: '^1.0.0' },
        }),
        // Needs a bundle that is not there, so it cannot start.
        'stuck/mooncg.json': manifest('stuck', {
          ...permissions,
          dependencies: { absent: '^1.0.0' },
        }),
      });
      const app = await setup(overrides, dir);
      const { bundles } = (await app.inject({ url: '/api/v1/bundles' })).json();
      return Object.fromEntries(
        bundles.map((bundle: { name: string; dependencies: string[] }) => [
          bundle.name,
          bundle.dependencies,
        ]),
      );
    };

    it('names them by the manifest, also for a bundle that did not start', async () => {
      expect(await needy()).toEqual({
        base: [],
        extra: [],
        consumer: ['base', 'extra'],
        stuck: ['absent'],
      });
    });

    it('names only those the principal is shown as bundles itself', async () => {
      const policy: Policy = {
        roles: {
          viewer: [
            'system:dashboard.view',
            'bundle:consumer:view',
            'bundle:base:view',
            'bundle:stuck:view',
          ],
        },
      };
      // `extra` and `absent` are no bundles this principal is told about, so no list names them.
      expect(await needy({ policy, resolvePrincipal: () => viewer })).toEqual({
        base: [],
        consumer: ['base'],
        stuck: [],
      });
    });

    it('names a bundle that is not installed only to whoever may manage bundles', async () => {
      // A grant with a wildcard covers every name, also one no bundle has. That a manifest
      // asks for such a bundle is told to those who can do something about it.
      const wide: Policy = { roles: { viewer: ['system:dashboard.view', 'bundle:*:view'] } };
      expect(await needy({ policy: wide, resolvePrincipal: () => viewer })).toEqual({
        base: [],
        extra: [],
        consumer: ['base', 'extra'],
        stuck: [],
      });
      const manager: Policy = {
        roles: { viewer: ['system:dashboard.view', 'system:bundles.manage'] },
      };
      expect(await needy({ policy: manager, resolvePrincipal: () => viewer })).toMatchObject({
        stuck: ['absent'],
      });
    });
  });
});

describe('bundle files', () => {
  it('serves panel and graphic files with their content type', async () => {
    const app = await setup();

    const panel = await app.inject({ url: '/b/good/dashboard/control.html' });
    const style = await app.inject({ url: '/b/good/dashboard/style.css' });
    const graphic = await app.inject({ url: '/b/good/graphics/overlay.html' });

    expect(panel.statusCode).toBe(200);
    expect(panel.headers['content-type']).toContain('text/html');
    expect(panel.body).toContain('good control panel');
    expect(style.headers['content-type']).toContain('text/css');
    expect(graphic.body).toContain('good overlay graphic');
  });

  it.each([
    ['a file outside dashboard/ and graphics/', '/b/good/extension/index.js'],
    ['the manifest', '/b/good/mooncg.json'],
    ['a parent directory', '/b/good/dashboard/../mooncg.json'],
    ['an encoded parent directory', '/b/good/dashboard/%2e%2e/mooncg.json'],
    ['an encoded slash', '/b/good/dashboard/..%2fmooncg.json'],
    ['a backslash parent directory', '/b/good/dashboard/..%5cmooncg.json'],
    ['an absolute path', '/b/good/dashboard//etc/passwd'],
    ['a directory', '/b/good/dashboard/'],
    ['a missing file', '/b/good/dashboard/missing.html'],
    ['an unknown bundle', '/b/nope/dashboard/control.html'],
    ['a failed bundle', '/b/crashy/extension/index.js'],
    ['a bundle folder reached by traversal', '/b/../good/dashboard/control.html'],
  ])('answers 404 for %s', async (_label, url) => {
    const app = await setup();
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"manifest"');
  });
});

describe('GET /sdk/mooncg.js', () => {
  it('serves the browser build of the SDK', async () => {
    const app = await setup();
    const response = await app.inject({ url: '/sdk/mooncg.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.body).toContain('sdk bundle');
  });

  it('answers 404 with a hint when the SDK has not been built', async () => {
    const app = await setup({ sdkFile: fixture('sdk/not-built.js') });
    const response = await app.inject({ url: '/sdk/mooncg.js' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toMatch(/pnpm build/);
  });
});

describe('authorization', () => {
  it.each([['/'], ['/api/v1/bundles']])('answers 403 for %s without any grant', async (url) => {
    const app = await setup(asNobody);
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it.each([
    ['/b/good/dashboard/control.html'],
    ['/b/good/dashboard/style.css'],
    ['/b/good/graphics/overlay.html'],
  ])('answers 404 for %s to whoever holds nothing of the bundle', async (url) => {
    const app = await setup(asNobody);
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual((await app.inject({ url: '/b/absent/x/y.html' })).json());
  });

  it('checks the permission a panel or graphic requires', async () => {
    const app = await setup(asViewer);
    expect((await app.inject({ url: '/b/good/graphics/overlay.html' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/b/good/dashboard/control.html' })).statusCode).toBe(403);
  });

  it('opens files no panel or graphic names to whoever holds a permission of the bundle', async () => {
    const app = await setup(asViewer);
    expect((await app.inject({ url: '/b/good/dashboard/style.css' })).statusCode).toBe(200);
  });

  it('serves the SDK to anyone who is signed in, and refuses everything to who is not', async () => {
    const signedIn = await setup(asNobody);
    expect((await signedIn.inject({ url: '/sdk/mooncg.js' })).statusCode).toBe(200);
    const anonymous = await setup({ resolvePrincipal: () => ANONYMOUS_PRINCIPAL });
    for (const url of ['/', '/sdk/mooncg.js', '/api/v1/bundles', '/b/good/graphics/overlay.html']) {
      const response = await anonymous.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
  });

  it('refuses everyone when neither accounts nor a principal are given', async () => {
    const app = await createApp({ bundles: [], sdkFile: undefined });
    apps.push(app);
    expect((await app.inject({ url: '/api/v1/bundles' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/sdk/mooncg.js' })).statusCode).toBe(401);
  });
});
