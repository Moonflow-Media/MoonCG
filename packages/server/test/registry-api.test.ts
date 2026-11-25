import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLES_MANAGE, MODULES_MANAGE, SETTINGS_MANAGE } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { indexId } from '../src/registry/registry.js';
import { type HttpAnswer, PASSWORD, startAuthServer } from './auth-helpers.js';
import { bytes, type HttpFixture, json, startHttpFixture } from './http-fixture.js';
import { moduleManifest } from './module-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';
import { zipOf } from './zip-writer.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const tickerZip = (version: string) =>
  zipOf({
    'mooncg.json': manifest('ticker', { version, title: 'Ticker' }),
    'graphics/ticker.html': `<p>${version}</p>`,
  });
const greeterZip = zipOf({
  'mooncg.json': moduleManifest('greeter', { version: '1.0.0' }),
  'index.js': 'export default function setup() {}\n',
});

/** The index the fixture serves, with the archives it lists. */
function indexOf(tickers: readonly string[], extra: object[] = []) {
  return {
    index: 1,
    title: 'Test index',
    entries: [
      {
        name: 'ticker',
        kind: 'bundle',
        title: 'Ticker',
        description: 'Lines that run along the bottom.',
        versions: tickers.map((version) => ({
          version,
          engine: { mooncg: '>=0.1.0' },
          source: { type: 'zip', url: `ticker-${version}.zip`, sha256: sha256(tickerZip(version)) },
        })),
      },
      {
        name: 'greeter',
        kind: 'module',
        versions: [
          {
            version: '1.0.0',
            source: { type: 'zip', url: 'greeter.zip', sha256: sha256(greeterZip) },
          },
        ],
      },
      // Claims the name of a bundle that was installed from a folder, at a high version.
      {
        name: 'board',
        kind: 'bundle',
        versions: [
          {
            version: '9.9.9',
            source: { type: 'zip', url: 'ticker-1.0.0.zip', sha256: sha256(tickerZip('1.0.0')) },
          },
        ],
      },
      ...extra,
    ],
  };
}

async function setup() {
  const fixture: HttpFixture = await startHttpFixture({
    '/index.json': json(indexOf(['1.0.0'])),
    '/ticker-1.0.0.zip': bytes(tickerZip('1.0.0')),
    '/ticker-1.1.0.zip': bytes(tickerZip('1.1.0')),
    '/greeter.zip': bytes(greeterZip),
  });
  const indexUrl = `${fixture.url}/index.json`;
  const root = await mkdtemp(join(tmpdir(), 'mooncg-registry-api-'));
  const context = await startAuthServer(
    temporary,
    { dataDir: join(root, 'data'), modulesDir: join(root, 'modules'), registryIndexes: [indexUrl] },
    { npmInstall: async () => {} },
  );
  cleanup.push(async () => {
    await context.server.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { http, auth, login, server } = context;
  await server.registry.refreshed();
  const roles: Record<string, readonly string[]> = {
    bundler: [BUNDLES_MANAGE],
    moduler: [MODULES_MANAGE],
    settler: [SETTINGS_MANAGE],
    curator: [SETTINGS_MANAGE, BUNDLES_MANAGE],
  };
  const cookies: Record<string, string> = {};
  for (const [role, grants] of Object.entries(roles)) {
    auth.createRole(role, grants);
    await auth.createUser({ name: role, password: PASSWORD, roles: [role] });
    cookies[role] = await login(role);
  }
  await auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  cookies.admin = await login('ada');
  await auth.createUser({ name: 'vera', password: PASSWORD, roles: ['viewer'] });
  cookies.viewer = await login('vera');
  const as = (role: string) => ({ cookie: cookies[role] as string });

  const settle = async (answer: HttpAnswer, kind = 'bundles') => {
    expect(answer.status, answer.text).toBe(202);
    let { job } = answer.json;
    for (let tries = 0; !['succeeded', 'failed', 'rolled-back'].includes(job.state); tries++) {
      if (tries > 300) throw new Error(`The job did not end: ${JSON.stringify(job)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await http('GET', `/api/v1/${kind}/-/jobs/${job.id}`, as('admin'))).json.job;
    }
    return job;
  };
  return { ...context, fixture, indexUrl, as, settle };
}

describe('the registry API', () => {
  it('lets each kind of manager read only its own part of the catalog', async () => {
    const { http, as } = await setup();
    const kinds = async (role: string, query = '') => {
      const answer = await http('GET', `/api/v1/registry/catalog${query}`, as(role));
      return answer.status === 200
        ? [...new Set(answer.json.entries.map((entry: { kind: string }) => entry.kind))].sort()
        : answer.status;
    };
    expect(await kinds('admin')).toEqual(['bundle', 'module']);
    expect(await kinds('bundler')).toEqual(['bundle']);
    expect(await kinds('moduler')).toEqual(['module']);
    expect(await kinds('bundler', '?kind=module')).toBe(403);
    expect(await kinds('settler')).toBe(403);
    expect(await kinds('viewer')).toBe(403);
    expect((await http('GET', '/api/v1/registry/catalog')).status).toBe(401);
    expect((await http('GET', '/api/v1/registry/indexes', as('viewer'))).status).toBe(403);
    expect((await http('GET', '/api/v1/registry/updates', as('settler'))).status).toBe(403);
  });

  it('lets only those who manage settings and installs change the indexes', async () => {
    const { http, as, fixture } = await setup();
    const other = `${fixture.url}/index.json?copy=1`;
    const add = (role: string) =>
      http('POST', '/api/v1/registry/indexes', { ...as(role), json: { url: other } });
    expect((await add('bundler')).status).toBe(403);
    expect((await add('settler')).status).toBe(403);
    expect((await add('viewer')).status).toBe(403);
    const added = await add('curator');
    expect(added.status).toBe(201);
    expect(added.json.index).toMatchObject({ origin: 'added', status: 'ok' });

    const listed = await http('GET', '/api/v1/registry/indexes', as('moduler'));
    expect(listed.json).toMatchObject({ canEdit: false });
    expect(listed.json.indexes).toHaveLength(2);
    expect((await http('GET', '/api/v1/registry/indexes', as('curator'))).json.canEdit).toBe(true);

    const id = added.json.index.id as string;
    expect((await http('DELETE', `/api/v1/registry/indexes/${id}`, as('bundler'))).status).toBe(
      403,
    );
    // Without JSON or the header, a cookie alone changes nothing.
    expect(
      (await http('DELETE', `/api/v1/registry/indexes/${id}`, { cookie: as('curator').cookie }))
        .status,
    ).toBe(403);
    expect(
      (
        await http('DELETE', `/api/v1/registry/indexes/${id}`, {
          ...as('curator'),
          headers: { 'x-mooncg-csrf': '1' },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await http('POST', '/api/v1/registry/indexes', {
          ...as('admin'),
          json: { url: 'http://example.org/i.json' },
        })
      ).status,
    ).toBe(400);
  });

  it('installs from the catalog through staging, and offers an update once there is one', async () => {
    const { http, as, settle, fixture, indexUrl, server } = await setup();
    const staged = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('bundler'),
        json: { kind: 'bundle', index: indexId(indexUrl), name: 'ticker' },
      }),
    );
    expect(staged.state, staged.error).toBe('succeeded');
    expect(staged.staged.source).toMatchObject({
      type: 'url',
      location: `${fixture.url}/ticker-1.0.0.zip`,
      catalog: { index: indexId(indexUrl), indexUrl, name: 'ticker', version: '1.0.0' },
    });
    const done = await settle(
      await http('POST', `/api/v1/bundles/-/staged/${staged.staged.id}/commit`, {
        ...as('bundler'),
        json: {},
      }),
    );
    expect(done.state, done.error).toBe('succeeded');
    expect((await http('GET', '/api/v1/registry/updates', as('bundler'))).json.updates).toEqual([]);

    // A newer version appears in the index.
    fixture.routes.set('/index.json', json(indexOf(['1.0.0', '1.1.0'])));
    const refreshed = await http('POST', '/api/v1/registry/refresh', {
      ...as('bundler'),
      json: {},
    });
    expect(refreshed.status).toBe(200);
    const { updates } = (await http('GET', '/api/v1/registry/updates', as('bundler'))).json;
    // Only the bundle installed from this entry: "board", which the index also lists, is not.
    expect(updates).toEqual([
      expect.objectContaining({
        kind: 'bundle',
        name: 'ticker',
        installed: '1.0.0',
        available: '1.1.0',
      }),
    ]);
    const catalog = (await http('GET', '/api/v1/registry/catalog?kind=bundle', as('bundler'))).json;
    const board = catalog.entries.find((entry: { name: string }) => entry.name === 'board');
    expect(board.installed).toEqual({ version: '1.0.0', fromThisEntry: false });
    expect(board.update).toBeUndefined();

    // The one-click update goes through the same staging, as an update of the bundle.
    const update = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('bundler'),
        json: { kind: 'bundle', index: indexId(indexUrl), name: 'ticker', update: true },
      }),
    );
    expect(update.staged).toMatchObject({ target: 'ticker', replaces: '1.0.0', version: '1.1.0' });
    await settle(
      await http('POST', `/api/v1/bundles/-/staged/${update.staged.id}/commit`, {
        ...as('bundler'),
        json: {},
      }),
    );
    expect(server.manager.get('ticker')?.manifest?.version).toBe('1.1.0');

    // An index cannot take over a bundle installed otherwise.
    const hijack = await http('POST', '/api/v1/registry/stage', {
      ...as('bundler'),
      json: { kind: 'bundle', index: indexId(indexUrl), name: 'board', update: true },
    });
    expect(hijack.status).toBe(409);
  });

  it('keeps the rules of modules and of each kind of manager', async () => {
    const { http, as, settle, indexUrl, server } = await setup();
    const index = indexId(indexUrl);
    const module = { kind: 'module', index, name: 'greeter' };
    expect(
      (await http('POST', '/api/v1/registry/stage', { ...as('bundler'), json: module })).status,
    ).toBe(403);
    expect(
      (
        await http('POST', '/api/v1/registry/stage', {
          ...as('moduler'),
          json: { kind: 'bundle', index, name: 'ticker' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http('POST', '/api/v1/registry/stage', {
          ...as('moduler'),
          json: { ...module, name: 'nothing-here' },
        })
      ).status,
    ).toBe(404);
    const staged = await settle(
      await http('POST', '/api/v1/registry/stage', { ...as('moduler'), json: module }),
      'modules',
    );
    expect(staged.state, staged.error).toBe('succeeded');
    expect(staged.staged.source.catalog).toMatchObject({ kind: 'module', name: 'greeter' });
    const done = await settle(
      await http('POST', `/api/v1/modules/-/staged/${staged.staged.id}/commit`, {
        ...as('moduler'),
        json: {},
      }),
      'modules',
    );
    expect(done.state, done.error).toBe('succeeded');
    // Installed, and disabled until someone enables it.
    expect(server.modules.get('greeter')?.enabled).toBe(false);
  });

  it('pushes the update hints of each kind live, to those who manage that kind alone', async () => {
    const { http, as, settle, fixture, indexUrl, socket, server } = await setup();
    const read = async (role: string, kind: 'bundles' | 'modules') => {
      const connection = await socket({ cookie: as(role).cookie }, 'system');
      try {
        return await connection.ask({ t: 'rep.sub', name: `system:updates.${kind}` });
      } finally {
        connection.close();
      }
    };
    expect(await read('bundler', 'bundles')).toMatchObject({
      t: 'rep.snap',
      value: { updates: [] },
    });
    expect(await read('moduler', 'bundles')).toMatchObject({ t: 'err' });
    expect(await read('bundler', 'modules')).toMatchObject({ t: 'err' });
    expect(await read('viewer', 'bundles')).toMatchObject({ t: 'err' });
    expect(await read('moduler', 'modules')).toMatchObject({ t: 'rep.snap' });

    const staged = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('bundler'),
        json: { kind: 'bundle', index: indexId(indexUrl), name: 'ticker' },
      }),
    );
    await settle(
      await http('POST', `/api/v1/bundles/-/staged/${staged.staged.id}/commit`, {
        ...as('bundler'),
        json: {},
      }),
    );
    // Followed while the index changes: the hint arrives without anything being asked.
    const watching = await socket({ cookie: as('bundler').cookie }, 'system');
    cleanup.push(() => watching.close());
    await watching.ask({ t: 'rep.sub', name: 'system:updates.bundles' });
    fixture.routes.set('/index.json', json(indexOf(['1.0.0', '1.1.0'])));
    await server.registry.refresh();
    const deadline = Date.now() + 3000;
    let hints: unknown;
    while (Date.now() < deadline) {
      hints = (await read('bundler', 'bundles')) as { value?: { updates?: unknown[] } };
      if ((hints as { value: { updates: unknown[] } }).value.updates.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hints).toMatchObject({
      value: {
        updates: [{ kind: 'bundle', name: 'ticker', installed: '1.0.0', available: '1.1.0' }],
      },
    });
    expect(watching.pushed.some((message) => message.t === 'rep.patch')).toBe(true);
    // The modules hold nothing of it.
    expect(await read('moduler', 'modules')).toMatchObject({ value: { updates: [] } });
  });

  it('counts for each manager only the entries of the kinds they may read', async () => {
    const { http, as } = await setup();
    const counted = async (role: string) =>
      (await http('GET', '/api/v1/registry/indexes', as(role))).json.indexes[0].entries;
    expect(await counted('admin')).toBe(3);
    expect(await counted('bundler')).toBe(2);
    expect(await counted('moduler')).toBe(1);
    const catalog = await http('GET', '/api/v1/registry/catalog', as('moduler'));
    expect(catalog.json.indexes[0].entries).toBe(1);
  });

  it('checks the indexes on request at most every so often', async () => {
    const { http, as } = await setup();
    const refresh = () => http('POST', '/api/v1/registry/refresh', { ...as('bundler'), json: {} });
    expect((await refresh()).status).toBe(200);
    const again = await refresh();
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(again.json.error.message).toMatch(/try again in \d+ s/i);
  });

  it('never stages a downgrade from the catalog', async () => {
    const { http, as, settle, fixture, indexUrl } = await setup();
    const index = indexId(indexUrl);
    fixture.routes.set('/index.json', json(indexOf(['1.0.0', '1.1.0'])));
    await http('POST', '/api/v1/registry/refresh', { ...as('admin'), json: {} });
    const installed = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('bundler'),
        json: { kind: 'bundle', index, name: 'ticker', version: '1.1.0' },
      }),
    );
    expect(installed.state, installed.error).toBe('succeeded');
    await settle(
      await http('POST', `/api/v1/bundles/-/staged/${installed.staged.id}/commit`, {
        ...as('bundler'),
        json: {},
      }),
    );
    const older = await http('POST', '/api/v1/registry/stage', {
      ...as('bundler'),
      json: { kind: 'bundle', index, name: 'ticker', version: '1.0.0', update: true },
    });
    expect(older.status).toBe(409);
    expect(older.json.error.message).toMatch(/1\.0\.0.*older than.*1\.1\.0/);
  });

  it('refuses an archive whose manifest has another version than the entry names', async () => {
    const { http, as, settle, fixture, indexUrl } = await setup();
    fixture.routes.set(
      '/index.json',
      json({
        index: 1,
        entries: [
          {
            name: 'ticker',
            kind: 'bundle',
            versions: [
              {
                version: '2.0.0',
                source: {
                  type: 'zip',
                  url: 'ticker-1.0.0.zip',
                  sha256: sha256(tickerZip('1.0.0')),
                },
              },
            ],
          },
          {
            name: 'greeter',
            kind: 'module',
            versions: [
              {
                version: '3.0.0',
                source: { type: 'zip', url: 'greeter.zip', sha256: sha256(greeterZip) },
              },
            ],
          },
        ],
      }),
    );
    await http('POST', '/api/v1/registry/refresh', { ...as('admin'), json: {} });
    const index = indexId(indexUrl);
    const bundle = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('admin'),
        json: { kind: 'bundle', index, name: 'ticker' },
      }),
    );
    expect(bundle.state).toBe('failed');
    expect(bundle.error).toMatch(/2\.0\.0/);
    expect(bundle.error).toMatch(/1\.0\.0/);
    const module = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('admin'),
        json: { kind: 'module', index, name: 'greeter' },
      }),
      'modules',
    );
    expect(module.state).toBe('failed');
    expect(module.error).toMatch(/3\.0\.0.*1\.0\.0|1\.0\.0.*3\.0\.0/);
  });

  it('fetches again what came from an index, from it, when an update names no source', async () => {
    const { http, as, settle, indexUrl } = await setup();
    const staged = await settle(
      await http('POST', '/api/v1/registry/stage', {
        ...as('bundler'),
        json: { kind: 'bundle', index: indexId(indexUrl), name: 'ticker' },
      }),
    );
    await settle(
      await http('POST', `/api/v1/bundles/-/staged/${staged.staged.id}/commit`, {
        ...as('bundler'),
        json: {},
      }),
    );
    const again = await settle(
      await http('POST', '/api/v1/bundles/ticker/update', { ...as('bundler'), json: {} }),
    );
    expect(again.state, again.error).toBe('succeeded');
    expect(again.staged.source.catalog).toMatchObject({ name: 'ticker', version: '1.0.0' });
  });

  it('refuses a version this MoonCG cannot run', async () => {
    const { http, as, fixture, indexUrl } = await setup();
    fixture.routes.set(
      '/index.json',
      json(
        indexOf(
          ['1.0.0'],
          [
            {
              name: 'future',
              kind: 'bundle',
              versions: [
                {
                  version: '1.0.0',
                  engine: { mooncg: '>=99.0.0' },
                  source: { type: 'zip', url: 'f.zip', sha256: 'a'.repeat(64) },
                },
              ],
            },
          ],
        ),
      ),
    );
    await http('POST', '/api/v1/registry/refresh', { ...as('admin'), json: {} });
    const answer = await http('POST', '/api/v1/registry/stage', {
      ...as('admin'),
      json: { kind: 'bundle', index: indexId(indexUrl), name: 'future' },
    });
    expect(answer.status).toBe(409);
    expect(answer.json.error.message).toMatch(/MoonCG/);
    // Nothing was fetched for it.
    expect(fixture.requests.some((request) => request.url === '/f.zip')).toBe(false);
  });
});
