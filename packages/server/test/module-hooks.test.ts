import { afterEach, describe, expect, it } from 'vitest';
import { indexId } from '../src/registry/registry.js';
import { PASSWORD } from './auth-helpers.js';
import { type ModuleServer, moduleManifest, startModuleServer } from './module-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

/**
 * The hooks of `ModuleContext` beyond sign-ins, routes and permissions: an index source of its
 * own (`registry.registerSource`) and a page in the dashboard (`dashboard.registerPage`).
 */

const temporary = temporaryBundles();
let context: ModuleServer | undefined;
afterEach(async () => {
  await context?.server.close();
  context = undefined;
  delete (globalThis as { __catalogue?: unknown }).__catalogue;
  await temporary.cleanup();
});

const SHA = 'a'.repeat(64);
/** What the private API of the module answers; a test puts another index in its place. */
const index = (url = 'https://downloads.example.org/ticker-1.0.0.zip') => ({
  index: 1,
  title: 'Studio API',
  entries: [
    {
      name: 'ticker',
      kind: 'bundle',
      versions: [{ version: '1.0.0', source: { type: 'zip', url, sha256: SHA } }],
    },
  ],
});
const answer = (value: unknown) => {
  (globalThis as { __catalogue?: unknown }).__catalogue = value;
};

/** A module with an index source of its own and a page of its own. */
const CATALOGUE = {
  'catalogue/mooncg.json': moduleManifest('catalogue', { title: 'Catalogue' }),
  'catalogue/index.js': `export default function setup(ctx) {
  const view = ctx.permissions.define('stats', 'See the stats');
  ctx.http.register({
    method: 'GET',
    path: '/stats',
    permission: view,
    handler: () => ({ headers: { 'content-type': 'text/html' }, body: '<p>stats</p>' }),
  });
  ctx.dashboard.registerPage({ id: 'stats', title: 'Stats', path: '/stats', permission: view });
  ctx.registry.registerSource({
    id: 'studio',
    title: 'Studio API',
    load: async () => globalThis.__catalogue,
  });
}
`,
};
const SOURCE = 'module://catalogue/studio';

async function start(modules: Record<string, string | object> = CATALOGUE) {
  answer(index());
  context = await startModuleServer(temporary, modules, ['catalogue']);
  await context.server.registry.refreshed();
  return context;
}

describe('an index source of a module', () => {
  it('lists what it provides in the catalog, checked like any index', async () => {
    const { http, admin } = await start();
    const indexes = (await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json;
    expect(indexes.indexes).toEqual([
      expect.objectContaining({
        id: indexId(SOURCE),
        url: SOURCE,
        origin: 'module',
        module: 'catalogue',
        status: 'ok',
        title: 'Studio API',
        entries: 1,
      }),
    ]);
    const catalog = (await http('GET', '/api/v1/registry/catalog', { cookie: admin })).json;
    expect(catalog.entries).toEqual([
      expect.objectContaining({ name: 'ticker', index: expect.objectContaining({ url: SOURCE }) }),
    ]);
  });

  it('is refused as a whole when what it provides is no valid index', async () => {
    const { http, admin, server } = await start();
    answer({ index: 1, entries: [{ name: 'Bad Name', kind: 'bundle', versions: [] }] });
    await server.registry.refresh();
    const [state] = (await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json.indexes;
    expect(state).toMatchObject({ status: 'stale', error: expect.stringMatching(/valid index/) });
  });

  it('may list neither paths next to it nor this machine', async () => {
    const { http, admin, server } = await start();
    answer(index('ticker-1.0.0.zip'));
    await server.registry.refresh();
    let [state] = (await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json.indexes;
    expect(state.error).toMatch(/https:\/\//);
    answer(index('https://127.0.0.1/ticker-1.0.0.zip'));
    await server.registry.refresh();
    [state] = (await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json.indexes;
    expect(state.error).toMatch(/this machine/);
  });

  it('fetches what it lists through the guarded path of the server alone', async () => {
    const { http, admin, server } = await start();
    answer(index('https://10.0.0.7/ticker-1.0.0.zip'));
    await server.registry.refresh();
    const staged = await http('POST', '/api/v1/registry/stage', {
      cookie: admin,
      json: { kind: 'bundle', index: indexId(SOURCE), name: 'ticker' },
    });
    // Refused before anything connects: an internal address, whoever lists it.
    expect(staged.status).toBe(400);
    expect(staged.text).toMatch(/internal/);
  });

  it('is changed by its module alone, and gone with it', async () => {
    const { http, admin } = await start();
    const removed = await http('DELETE', `/api/v1/registry/indexes/${indexId(SOURCE)}`, {
      cookie: admin,
      headers: { 'x-mooncg-csrf': '1' },
    });
    expect(removed.status).toBe(409);
    await http('POST', '/api/v1/modules/catalogue/disable', { cookie: admin, json: {} });
    expect((await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json.indexes).toEqual(
      [],
    );
    expect((await http('GET', '/api/v1/registry/catalog', { cookie: admin })).json.entries).toEqual(
      [],
    );
    await http('POST', '/api/v1/modules/catalogue/enable', { cookie: admin, json: {} });
    await context?.server.registry.refreshed();
    expect(
      (await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json.indexes,
    ).toHaveLength(1);
  });

  it.each([
    [
      'an id that cannot be one',
      `ctx.registry.registerSource({ id: 'Bad/Id', load: () => ({}) });`,
    ],
    ['no load', `ctx.registry.registerSource({ id: 'studio' });`],
    [
      'the same id twice',
      `const source = { id: 'studio', load: () => ({}) };
  ctx.registry.registerSource(source);
  ctx.registry.registerSource(source);`,
    ],
  ])('fails the module for %s', async (_what, body) => {
    const { http, admin } = await start({
      'catalogue/mooncg.json': moduleManifest('catalogue'),
      'catalogue/index.js': `export default function setup(ctx) {\n  ${body}\n}\n`,
    });
    const listed = (await http('GET', '/api/v1/modules', { cookie: admin })).json.modules;
    expect(listed.find((module: { name: string }) => module.name === 'catalogue')).toMatchObject({
      state: 'failed',
    });
    expect((await http('GET', '/api/v1/registry/indexes', { cookie: admin })).json.indexes).toEqual(
      [],
    );
  });
});

describe('a dashboard page of a module', () => {
  it('is listed for those who hold its permission, as a link to the route of the module', async () => {
    const { http, admin, auth, login } = await start();
    const pages = await http('GET', '/api/v1/module-pages', { cookie: admin });
    expect(pages.status).toBe(200);
    expect(pages.json.pages).toEqual([
      { module: 'catalogue', id: 'stats', title: 'Stats', url: '/m/catalogue/stats' },
    ]);
    // Served by the route of the module, with the policy every module answer gets.
    const page = await http('GET', '/m/catalogue/stats', { cookie: admin });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/sandbox/);

    await auth.createUser({ name: 'vera', password: PASSWORD, roles: ['viewer'] });
    const vera = await login('vera');
    expect((await http('GET', '/api/v1/module-pages', { cookie: vera })).json.pages).toEqual([]);
    auth.createRole('stats', ['system:module.catalogue.stats']);
    await auth.createUser({ name: 'sam', password: PASSWORD, roles: ['stats'] });
    const sam = await login('sam');
    expect((await http('GET', '/api/v1/module-pages', { cookie: sam })).json.pages).toHaveLength(1);
    expect((await http('GET', '/api/v1/module-pages')).status).toBe(401);
  });

  it('is gone with its module', async () => {
    const { http, admin } = await start();
    await http('POST', '/api/v1/modules/catalogue/disable', { cookie: admin, json: {} });
    expect((await http('GET', '/api/v1/module-pages', { cookie: admin })).json.pages).toEqual([]);
  });

  it.each([
    [
      'a path with a parameter',
      `ctx.dashboard.registerPage({ id: 'p', title: 'P', path: '/x/:id', permission: 'system:dashboard.view' });`,
    ],
    [
      'a permission that is neither its own nor a system one',
      `ctx.dashboard.registerPage({ id: 'p', title: 'P', path: '/x', permission: 'system:module.other.x' });`,
    ],
    ['no permission', `ctx.dashboard.registerPage({ id: 'p', title: 'P', path: '/x' });`],
    [
      'a title with control characters',
      `ctx.dashboard.registerPage({ id: 'p', title: 'P\\u0007', path: '/x', permission: 'system:dashboard.view' });`,
    ],
  ])('fails the module for %s', async (_what, body) => {
    const { http, admin } = await start({
      'catalogue/mooncg.json': moduleManifest('catalogue'),
      'catalogue/index.js': `export default function setup(ctx) {\n  ${body}\n}\n`,
    });
    const listed = (await http('GET', '/api/v1/modules', { cookie: admin })).json.modules;
    expect(listed.find((module: { name: string }) => module.name === 'catalogue')).toMatchObject({
      state: 'failed',
    });
    expect((await http('GET', '/api/v1/module-pages', { cookie: admin })).json.pages).toEqual([]);
  });
});
