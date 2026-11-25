import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstallJob, StagedBundle } from '../src/install/installer.js';
import { loadConfig } from '../src/kernel/config.js';
import { PASSWORD, startAuthServer } from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';
import { zipOf } from './zip-writer.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

type Files = Readonly<Record<string, string | object>>;
const ticker = (version: string, extra: object = {}): Files => ({
  'mooncg.json': manifest('ticker', {
    version,
    title: 'Ticker',
    permissions: { view: 'See the ticker' },
    panels: [{ id: 'lines', title: 'Lines', file: 'dashboard/lines.html' }],
    ...extra,
  }),
  'dashboard/lines.html': `<p>ticker ${version}</p>`,
});
const UPLOAD = { 'content-type': 'application/zip', 'x-mooncg-csrf': '1' };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-install-api-'));
  const dataDir = join(root, 'data');
  const npm: string[] = [];
  const context = await startAuthServer(
    temporary,
    { dataDir },
    {
      npmInstall: async ({ dir, scripts }) => {
        npm.push(`${scripts ? 'with' : 'without'} scripts`);
        await mkdir(join(dir, 'node_modules'), { recursive: true });
      },
    },
  );
  cleanup.push(async () => {
    await context.server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { http, auth, login, server } = context;
  const cookies: Record<string, string> = {};
  for (const [name, role] of [
    ['ada', 'admin'],
    ['olga', 'operator'],
    ['vera', 'viewer'],
  ] as const) {
    await auth.createUser({ name, password: PASSWORD, roles: [role] });
    cookies[role] = await login(name);
  }
  const admin = { cookie: cookies.admin as string };
  /** A folder outside the server's own, with the files of a bundle. */
  const folder = async (files: Files, name = `src-${Math.random().toString(36).slice(2)}`) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(
        join(root, name, path),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    return join(root, name);
  };
  /** Follows a job to its end through the API, as a client does. */
  const settle = async (answer: { status: number; json: unknown }): Promise<InstallJob> => {
    expect(answer.status).toBe(202);
    let { job } = answer.json as { job: InstallJob };
    for (let tries = 0; !['succeeded', 'failed', 'rolled-back'].includes(job.state); tries++) {
      if (tries > 200) throw new Error(`The job did not end: ${JSON.stringify(job)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const asked = await http('GET', `/api/v1/bundles/-/jobs/${job.id}`, admin);
      expect(asked.status).toBe(200);
      job = (asked.json as { job: InstallJob }).job;
    }
    return job;
  };
  const stage = async (files: Files, target?: string) =>
    settle(
      await http('POST', '/api/v1/bundles/-/stage', {
        ...admin,
        json: { source: { type: 'path', path: await folder(files) }, target },
      }),
    );
  const commit = async (staged: StagedBundle | undefined, body: object = {}) =>
    settle(
      await http('POST', `/api/v1/bundles/-/staged/${staged?.id}/commit`, { ...admin, json: body }),
    );
  const listed = async (cookie = admin.cookie) => {
    const answer = await http('GET', '/api/v1/bundles', { cookie });
    return (answer.json as { bundles: Record<string, unknown>[] }).bundles;
  };
  const bundle = async (name: string) => (await listed()).find((entry) => entry.name === name);
  return {
    ...context,
    root,
    dataDir,
    bundlesDir: server.manager.list()[0]?.dir.replace(/[\\/][^\\/]+$/, '') ?? '',
    cookies,
    admin,
    npm,
    folder,
    settle,
    stage,
    commit,
    listed,
    bundle,
  };
}

/** Every request the installation API takes, with a body that would be fine. */
const REQUESTS: [method: string, path: string, json?: object][] = [
  ['POST', '/api/v1/bundles/-/stage', { source: { type: 'path', path: '/srv/bundle' } }],
  ['GET', '/api/v1/bundles/-/staged'],
  ['POST', '/api/v1/bundles/-/staged/0123456789abcdef01234567/commit', {}],
  ['DELETE', '/api/v1/bundles/-/staged/0123456789abcdef01234567', {}],
  ['GET', '/api/v1/bundles/-/jobs'],
  ['GET', '/api/v1/bundles/-/jobs/0123456789abcdef'],
  ['POST', '/api/v1/bundles/board/update', {}],
  ['POST', '/api/v1/bundles/board/remove', {}],
  ['GET', '/api/v1/bundles/board/backups'],
  ['GET', '/api/v1/bundles/-/backups'],
  ['POST', '/api/v1/bundles/board/backups/1.0.0-20260101T000000000Z/restore', {}],
];

describe('who may install, update and remove', () => {
  it('refuses everyone who does not hold system:bundles.manage', async () => {
    const { http, cookies, server } = await setup();
    for (const role of ['viewer', 'operator']) {
      for (const [method, path, json] of REQUESTS) {
        const answer = await http(method, path, { cookie: cookies[role] as string, json });
        expect([role, method, path, answer.status]).toEqual([role, method, path, 403]);
        expect(answer.json).toMatchObject({ error: { code: 'forbidden' } });
      }
      const upload = await http('PUT', '/api/v1/bundles/-/stage', {
        cookie: cookies[role] as string,
        headers: UPLOAD,
        body: zipOf(ticker('1.0.0')),
      });
      expect(upload.status).toBe(403);
    }
    expect(server.installer.jobs()).toEqual([]);
    expect(server.manager.get('board')?.state).toBe('running');
  });

  it('asks whoever is not signed in to sign in', async () => {
    const { http, server } = await setup();
    for (const [method, path, json] of REQUESTS) {
      const answer = await http(method, path, { json });
      expect([method, path, answer.status]).toEqual([method, path, 401]);
    }
    const upload = await http('PUT', '/api/v1/bundles/-/stage', {
      headers: UPLOAD,
      body: zipOf(ticker('1.0.0')),
    });
    expect(upload.status).toBe(401);
    expect(server.installer.jobs()).toEqual([]);
  });

  it('takes an upload from a browser only with the CSRF header', async () => {
    const { http, admin, server } = await setup();
    const answer = await http('PUT', '/api/v1/bundles/-/stage', {
      ...admin,
      headers: { 'content-type': 'application/zip' },
      body: zipOf(ticker('1.0.0')),
    });
    expect(answer.status).toBe(403);
    expect(server.installer.jobs()).toEqual([]);
  });

  it('takes an API token that holds the permission, and none that does not', async () => {
    const { http, auth, folder, settle } = await setup();
    const ada = auth.findUser('ada');
    const principal = { id: `user:${ada?.id}`, kind: 'user' as const, roles: ['admin'] };
    const manage = auth.createToken(principal, { name: 'ci', grants: ['system:bundles.manage'] });
    const other = auth.createToken(principal, { name: 'view', grants: ['system:dashboard.view'] });
    const json = { source: { type: 'path', path: await folder(ticker('1.0.0')) } };

    const refused = await http('POST', '/api/v1/bundles/-/stage', { bearer: other.secret, json });
    expect(refused.status).toBe(403);
    const job = await settle(
      await http('POST', '/api/v1/bundles/-/stage', { bearer: manage.secret, json }),
    );
    expect(job).toMatchObject({ state: 'succeeded', by: 'ci (token)' });
  });
});

describe('installing through the API', () => {
  it('stages from a path, shows the summary, installs on commit and lists the source', async () => {
    const { http, admin, stage, commit, bundle, lines, bundlesDir } = await setup();

    const job = await stage(ticker('1.0.0'));
    expect(job).toMatchObject({ operation: 'stage', state: 'succeeded', by: 'ada' });
    expect(job.staged).toMatchObject({
      name: 'ticker',
      version: '1.0.0',
      permissions: [{ name: 'view', description: 'See the ticker' }],
      panels: 1,
      extension: false,
    });
    const staged = await http('GET', '/api/v1/bundles/-/staged', admin);
    expect(staged.json).toEqual({ staged: [job.staged] });
    // Staged is not installed.
    expect(await bundle('ticker')).toBeUndefined();
    expect(existsSync(join(bundlesDir, 'ticker'))).toBe(false);

    const done = await commit(job.staged);

    expect(done).toMatchObject({ operation: 'install', state: 'succeeded', bundle: 'ticker' });
    expect(await bundle('ticker')).toMatchObject({
      state: 'running',
      version: '1.0.0',
      source: { type: 'path' },
      panels: [{ id: 'lines' }],
    });
    expect((await http('GET', '/b/ticker/dashboard/lines.html', admin)).text).toBe(
      '<p>ticker 1.0.0</p>',
    );
    expect((await http('GET', '/api/v1/bundles/-/staged', admin)).json).toEqual({ staged: [] });
    const jobs = (await http('GET', '/api/v1/bundles/-/jobs', admin)).json as {
      jobs: InstallJob[];
    };
    expect(jobs.jobs.map(({ operation }) => operation)).toEqual(['install', 'stage']);
    expect(lines.join('\n')).toMatch(/\[bundles\] ada installed ticker 1\.0\.0/);
  });

  it('takes an uploaded archive, with the name it was given', async () => {
    const { http, admin, settle, commit, bundle } = await setup();
    const job = await settle(
      await http('PUT', '/api/v1/bundles/-/stage?filename=ticker-1.2.0.zip', {
        ...admin,
        headers: UPLOAD,
        body: zipOf(ticker('1.2.0')),
      }),
    );
    expect(job.staged).toMatchObject({
      version: '1.2.0',
      source: { type: 'upload', location: 'ticker-1.2.0.zip' },
    });
    expect((await commit(job.staged)).state).toBe('succeeded');
    expect(await bundle('ticker')).toMatchObject({ state: 'running', source: { type: 'upload' } });
  });

  it('answers a hostile archive with a failed job and writes nothing outside staging', async () => {
    const { http, admin, settle, root, dataDir } = await setup();
    const { makeZip } = await import('./zip-writer.js');
    const job = await settle(
      await http('PUT', '/api/v1/bundles/-/stage', {
        ...admin,
        headers: UPLOAD,
        body: makeZip([
          { name: 'mooncg.json', data: JSON.stringify(manifest('evil')) },
          { name: '../../../../evil.txt', data: 'evil' },
        ]),
      }),
    );
    expect(job.state).toBe('failed');
    expect(job.error).toContain('evil.txt');
    for (const dir of [root, dirname(root), dataDir]) {
      expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    }
    expect(await readdir(join(dataDir, 'staging'))).toEqual([]);
  });

  it('discards a staged bundle', async () => {
    const { http, admin, stage, dataDir } = await setup();
    const { staged } = await stage(ticker('1.0.0'));
    const path = `/api/v1/bundles/-/staged/${staged?.id}`;
    expect((await http('DELETE', path, { ...admin, json: {} })).status).toBe(204);
    expect((await http('DELETE', path, { ...admin, json: {} })).status).toBe(404);
    expect(await readdir(join(dataDir, 'staging'))).toEqual([]);
    const commit = await http('POST', `${path}/commit`, { ...admin, json: {} });
    expect(commit.status).toBe(404);
  });

  it('runs install scripts of npm packages only when the commit says so', async () => {
    const { stage, commit, npm } = await setup();
    const files = (name: string) => ({
      'mooncg.json': manifest(name),
      'package.json': { dependencies: { 'left-pad': '1.3.0' } },
    });
    await commit((await stage(files('one'))).staged);
    await commit((await stage(files('two'))).staged, { scripts: true });
    await commit((await stage(files('three'))).staged, { scripts: 'yes' });
    expect(npm).toEqual(['without scripts', 'with scripts', 'without scripts']);
  });

  it.each([
    ['an upload in JSON', { source: { type: 'upload' } }],
    ['no source', {}],
    ['a source that is a text', { source: 'https://example.org/x.git' }],
    ['an option as a Git address', { source: { type: 'git', url: '--upload-pack=calc' } }],
    ['a file URL', { source: { type: 'git', url: 'file:///srv/repo.git' } }],
    [
      'a file URL with a request to allow it',
      {
        source: { type: 'git', url: 'file:///srv/repo.git', allowFileUrls: true },
        allowFileUrls: true,
      },
    ],
    ['the ext transport', { source: { type: 'git', url: 'ext::sh -c calc' } }],
    [
      'a ref that is an option',
      { source: { type: 'git', url: 'https://example.org/x.git', ref: '-x' } },
    ],
    ['a relative path', { source: { type: 'path', path: 'bundles/x' } }],
    ['a path that is no text', { source: { type: 'path', path: ['/', 'x'] } }],
  ])('refuses %s with 400 and starts nothing', async (_what, json) => {
    const { http, admin, server, dataDir } = await setup();
    const answer = await http('POST', '/api/v1/bundles/-/stage', { ...admin, json });
    expect(answer.status).toBe(400);
    expect(server.installer.jobs()).toEqual([]);
    expect(await readdir(join(dataDir, 'staging')).catch(() => [])).toEqual([]);
  });

  it('answers 404 for what is not there', async () => {
    const { http, admin } = await setup();
    const none = { ...admin, json: {} };
    for (const [method, path] of [
      ['POST', '/api/v1/bundles/-/staged/0123456789abcdef01234567/commit'],
      ['POST', '/api/v1/bundles/-/staged/..%2F..%2Fx/commit'],
      ['DELETE', '/api/v1/bundles/-/staged/0123456789abcdef01234567'],
      ['POST', '/api/v1/bundles/nope/update'],
      ['POST', '/api/v1/bundles/nope/remove'],
      ['POST', '/api/v1/bundles/board/backups/1.0.0-20260101T000000000Z/restore'],
      ['POST', '/api/v1/bundles/board/backups/..%2F..%2Fx/restore'],
      // The dash is no bundle: nothing of the lifecycle answers under it.
      ['POST', '/api/v1/bundles/-/enable'],
      ['POST', '/api/v1/bundles/-/remove'],
    ] as const) {
      const answer = await http(method, path, none);
      expect([method, path, answer.status]).toEqual([method, path, 404]);
    }
    expect((await http('GET', '/api/v1/bundles/-/jobs/nope', admin)).status).toBe(404);
    expect((await http('GET', '/api/v1/bundles/nope/backups', admin)).json).toEqual({
      backups: [],
    });
  });
});

describe('updating and removing through the API', () => {
  it('updates from where the bundle came from, keeps a backup, and restores it', async () => {
    const { http, admin, settle, commit, bundle, root, folder } = await setup();
    const path = await folder(ticker('1.0.0'), 'ticker-checkout');
    const first = await settle(
      await http('POST', '/api/v1/bundles/-/stage', {
        ...admin,
        json: { source: { type: 'path', path } },
      }),
    );
    await commit(first.staged);
    await folder(ticker('1.1.0'), 'ticker-checkout');
    void root;

    const staged = await settle(
      await http('POST', '/api/v1/bundles/ticker/update', { ...admin, json: {} }),
    );
    expect(staged.staged).toMatchObject({ target: 'ticker', replaces: '1.0.0', version: '1.1.0' });
    const done = await commit(staged.staged);
    expect(done).toMatchObject({ operation: 'update', state: 'succeeded' });
    expect(await bundle('ticker')).toMatchObject({ state: 'running', version: '1.1.0' });

    const backups = (await http('GET', '/api/v1/bundles/ticker/backups', admin)).json as {
      backups: { id: string; version: string }[];
    };
    expect(backups.backups).toMatchObject([{ version: '1.0.0', reason: 'update' }]);

    const restored = await settle(
      await http('POST', `/api/v1/bundles/ticker/backups/${backups.backups[0]?.id}/restore`, {
        ...admin,
        json: {},
      }),
    );
    expect(restored).toMatchObject({ operation: 'restore', state: 'succeeded' });
    expect(await bundle('ticker')).toMatchObject({ state: 'running', version: '1.0.0' });
  });

  it('rolls an update back when the new version does not start', async () => {
    const { stage, commit, bundle, http, admin } = await setup();
    await commit((await stage(ticker('1.0.0'))).staged);
    // The new version names a schema file it does not bring.
    const broken = ticker('2.0.0', { replicants: { lines: { schema: 'schemas/missing.json' } } });

    const done = await commit((await stage(broken, 'ticker')).staged);

    expect(done).toMatchObject({ operation: 'update', state: 'rolled-back' });
    expect(done.error).toContain('schemas/missing.json');
    expect(await bundle('ticker')).toMatchObject({
      state: 'running',
      version: '1.0.0',
      errors: [],
    });
    expect((await http('GET', '/b/ticker/dashboard/lines.html', admin)).text).toBe(
      '<p>ticker 1.0.0</p>',
    );
  });

  it('refuses an update without a source for a bundle of unknown origin', async () => {
    const { http, admin } = await setup();
    const answer = await http('POST', '/api/v1/bundles/board/update', { ...admin, json: {} });
    expect(answer.status).toBe(409);
    expect(answer.json).toMatchObject({ error: { code: 'conflict' } });
  });

  it('removes a bundle, keeping its files as a backup unless told otherwise', async () => {
    const { http, admin, settle, stage, commit, bundle, dataDir, bundlesDir, lines } =
      await setup();
    await commit((await stage(ticker('1.0.0'))).staged);

    const removed = await settle(
      await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: {} }),
    );

    expect(removed).toMatchObject({ operation: 'remove', state: 'succeeded' });
    expect(await bundle('ticker')).toBeUndefined();
    expect(existsSync(join(bundlesDir, 'ticker'))).toBe(false);
    expect(await readdir(join(dataDir, 'backups', 'ticker'))).toHaveLength(1);
    expect((await http('GET', '/b/ticker/dashboard/lines.html', admin)).status).toBe(404);
    expect(lines.join('\n')).toMatch(/\[bundles\] ada removed ticker 1\.0\.0 .*data kept/);

    await commit((await stage(ticker('1.0.0'))).staged);
    const deleted = await settle(
      await http('POST', '/api/v1/bundles/ticker/remove', {
        ...admin,
        json: { deleteFiles: true, purgeData: true },
      }),
    );
    expect(deleted.state).toBe('succeeded');
    expect(await readdir(join(dataDir, 'backups', 'ticker'))).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/ada removed ticker 1\.0\.0 \(files deleted, data purged\)/);
  });

  it('lists the backups of every bundle, also of one that was removed', async () => {
    const { http, admin, settle, stage, commit } = await setup();
    const all = async () =>
      (await http('GET', '/api/v1/bundles/-/backups', admin)).json as {
        bundles: { name: string; installed: boolean; backups: { version: string }[] }[];
      };
    expect(await all()).toEqual({ bundles: [] });

    await commit((await stage(ticker('1.0.0'))).staged);
    await commit((await stage(ticker('1.1.0'), 'ticker')).staged);
    expect(await all()).toMatchObject({
      bundles: [{ name: 'ticker', installed: true, backups: [{ version: '1.0.0' }] }],
    });

    await settle(await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: {} }));
    const { bundles } = await all();
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({ name: 'ticker', installed: false });
    expect(bundles[0]?.backups.map(({ version }) => version)).toEqual(['1.1.0', '1.0.0']);
    // The same entries as the list of one bundle has.
    const one = await http('GET', '/api/v1/bundles/ticker/backups', admin);
    expect(one.json).toEqual({ backups: bundles[0]?.backups });
  });

  it('purges configuration, assets and replicants only with purgeData', async () => {
    const { http, admin, settle, stage, commit, dataDir, server } = await setup();
    const files = {
      ...ticker('1.0.0', {
        replicants: { lines: { default: ['a'], persistent: true } },
        assets: [{ id: 'logos' }],
      }),
    };
    const write = async () => {
      await mkdir(join(dataDir, 'config'), { recursive: true });
      await writeFile(join(dataDir, 'config', 'ticker.json'), '{}');
      await mkdir(join(dataDir, 'assets', 'ticker', 'logos'), { recursive: true });
      await writeFile(join(dataDir, 'assets', 'ticker', 'logos', 'a.png'), 'png');
      await server.storage.replicants.save([
        { bundle: 'ticker', name: 'lines', rev: 4, value: ['x'] },
      ]);
    };
    const kept = async () => ({
      config: existsSync(join(dataDir, 'config', 'ticker.json')),
      assets: existsSync(join(dataDir, 'assets', 'ticker', 'logos', 'a.png')),
      replicant: (await server.storage.replicants.load('ticker', 'lines')) !== undefined,
    });
    await commit((await stage(files)).staged);
    await write();

    await settle(await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: {} }));
    expect(await kept()).toEqual({ config: true, assets: true, replicant: true });

    await commit((await stage(files)).staged);
    await settle(
      await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: { purgeData: true } }),
    );
    expect(await kept()).toEqual({ config: false, assets: false, replicant: false });
  });

  it('refuses to remove what an enabled bundle needs, unless forced', async () => {
    const { http, admin, settle, stage, commit, bundle } = await setup();
    await commit((await stage(ticker('1.0.0'))).staged);
    const needs = {
      'mooncg.json': manifest('crawl', { dependencies: { ticker: '^1.0.0' } }),
    };
    await commit((await stage(needs)).staged);

    const refused = await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: {} });
    expect(refused.status).toBe(409);
    expect((refused.json as { error: { message: string } }).error.message).toContain('crawl');
    expect(await bundle('ticker')).toMatchObject({ state: 'running' });

    const forced = await settle(
      await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: { force: true } }),
    );
    expect(forced.state).toBe('succeeded');
    expect(await bundle('crawl')).toMatchObject({ state: 'failed' });
  });
});

describe('what others are told', () => {
  it('lists the bundles to a token that may manage bundles and nothing else', async () => {
    const { http, auth } = await setup();
    const ada = auth.findUser('ada');
    const principal = { id: `user:${ada?.id}`, kind: 'user' as const, roles: ['admin'] };
    const manage = auth.createToken(principal, { name: 'ci', grants: ['system:bundles.manage'] });
    const none = auth.createToken(principal, { name: 'none', grants: ['system:logs.view'] });

    const answer = await http('GET', '/api/v1/bundles', { bearer: manage.secret });
    expect(answer.status).toBe(200);
    const { canManage, bundles } = answer.json as {
      canManage: boolean;
      bundles: { name: string }[];
    };
    expect(canManage).toBe(true);
    expect(bundles.map(({ name }) => name)).toContain('board');
    expect((await http('GET', '/api/v1/bundles', { bearer: none.secret })).status).toBe(403);
  });

  it('tells the source of a bundle only to those who manage bundles', async () => {
    const { stage, commit, listed, cookies, auth } = await setup();
    await commit((await stage(ticker('1.0.0'))).staged);
    auth.grant('viewer', 'bundle:ticker:view');
    const viewer = (await listed(cookies.viewer)).find((entry) => entry.name === 'ticker');
    expect(viewer).toMatchObject({ name: 'ticker', state: 'running' });
    expect(viewer).not.toHaveProperty('source');
    const admin = (await listed()).find((entry) => entry.name === 'ticker');
    expect(admin).toHaveProperty('source');
  });
});

describe('what the review asked of the API', () => {
  const steering = {
    'mooncg.json': manifest('steer'),
    'package.json': { dependencies: { 'left-pad': '1.3.0' } },
    '.npmrc': 'git=./tools/g.exe',
  };

  it('refuses a bundle with an .npmrc unless the request trusts it to run code', async () => {
    const { http, admin, settle, folder, npm, commit } = await setup();
    const path = await folder(steering);
    const stage = (body: object) =>
      http('POST', '/api/v1/bundles/-/stage', {
        ...admin,
        json: { source: { type: 'path', path }, ...body },
      });

    const refused = await settle(await stage({}));
    expect(refused.state).toBe('failed');
    expect(refused.error).toMatch(/\.npmrc/);
    for (const scripts of ['true', 1, 'yes']) {
      expect((await settle(await stage({ scripts }))).state).toBe('failed');
    }

    const trusted = await settle(await stage({ scripts: true }));
    expect(trusted.staged).toMatchObject({ installCode: 'allowed', npm: { config: ['.npmrc'] } });
    expect((await commit(trusted.staged)).state).toBe('succeeded');
    expect(npm).toEqual(['with scripts']);
  });

  it('takes the same for an upload, from the address', async () => {
    const { http, admin, settle } = await setup();
    const upload = (query: string) =>
      http('PUT', `/api/v1/bundles/-/stage${query}`, {
        ...admin,
        headers: UPLOAD,
        body: zipOf(steering),
      });
    expect((await settle(await upload(''))).state).toBe('failed');
    expect((await settle(await upload('?scripts=1'))).state).toBe('failed');
    expect((await settle(await upload('?scripts=true'))).staged).toMatchObject({
      installCode: 'allowed',
    });
  });

  it('tells those who manage bundles how many backups are kept', async () => {
    const { http, admin, cookies } = await setup();
    const forAdmin = (await http('GET', '/api/v1/bundles', admin)).json as Record<string, unknown>;
    expect(forAdmin.backupsKept).toBe(3);
    const forViewer = (await http('GET', '/api/v1/bundles', { cookie: cookies.viewer as string }))
      .json as Record<string, unknown>;
    expect(forViewer).not.toHaveProperty('backupsKept');
  });

  it('shows the role grants a bundle proposes, and takes them away again with its data', async () => {
    const { http, admin, settle, stage, commit, auth } = await setup();
    const files = {
      'mooncg.json': manifest('ticker', {
        permissions: { view: 'See' },
        defaultRoles: { viewer: ['view'], nobody: ['view'] },
      }),
    };
    const viewer = () => auth.policy().roles.viewer ?? [];
    const remove = async (body: object) =>
      settle(await http('POST', '/api/v1/bundles/ticker/remove', { ...admin, json: body }));

    const first = await stage(files);
    expect(first.staged?.roles).toEqual({ grants: { viewer: ['view'] }, applies: true });
    await commit(first.staged);
    expect(viewer()).toContain('bundle:ticker:view');

    // Removed without its data: the grants stay, and a new one of that name brings none.
    await remove({});
    expect(viewer()).toContain('bundle:ticker:view');
    const second = await stage(files);
    expect(second.staged?.roles).toMatchObject({ applies: false });
    await commit(second.staged);

    // Removed with its data: the grants go, and the name starts over.
    await remove({ purgeData: true });
    expect(viewer()).not.toContain('bundle:ticker:view');
    const third = await stage(files);
    expect(third.staged?.roles).toMatchObject({ applies: true });
    await commit(third.staged);
    expect(viewer()).toContain('bundle:ticker:view');
  });

  it('answers a bundle named like a device with a failed job that says so', async () => {
    const { stage } = await setup();
    for (const name of ['nul', 'con', 'com1']) {
      const job = await stage({ 'mooncg.json': manifest(name) });
      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/reserves for a device/);
    }
  });

  it('answers 409 while as many bundles wait as may', async () => {
    const { http, admin, stage, folder } = await setup();
    for (const name of ['a', 'b', 'c', 'd', 'e']) await stage({ 'mooncg.json': manifest(name) });
    const sixth = await http('POST', '/api/v1/bundles/-/stage', {
      ...admin,
      json: { source: { type: 'path', path: await folder({ 'mooncg.json': manifest('f') }) } },
    });
    expect(sixth.status).toBe(409);
    expect((sixth.json as { error: { message: string } }).error.message).toMatch(
      /wait for a decision/,
    );
  });
});

describe('configuration', () => {
  it('takes a registry for npm, which must be an https address', () => {
    const at = (argv: string[], env: Record<string, string> = {}) =>
      loadConfig({ argv, env, cwd: tmpdir() }).bundleNpmRegistry;
    expect(at([])).toBeUndefined();
    expect(at(['--bundle-npm-registry', 'https://npm.example.org/team'])).toBe(
      'https://npm.example.org/team',
    );
    expect(at([], { MOONCG_BUNDLE_NPM_REGISTRY: 'https://npm.example.org/' })).toBe(
      'https://npm.example.org/',
    );
    for (const bad of [
      'http://npm.example.org/',
      'npm.example.org',
      'file:///x',
      'https://u:p@npm.example.org/',
    ]) {
      expect(() => at(['--bundle-npm-registry', bad])).toThrow(/registry/);
    }
  });

  const load = (argv: string[] = [], env: Record<string, string> = {}) =>
    loadConfig({ argv, env, cwd: tmpdir() });

  it('has limits for installing bundles', () => {
    expect(load()).toMatchObject({
      bundleMaxArchiveBytes: 100 * 1024 * 1024,
      bundleMaxUnpackedBytes: 500 * 1024 * 1024,
      bundleMaxFiles: 50_000,
      bundleBackupsKept: 3,
      bundleInstallTimeoutMs: 300_000,
    });
  });

  it('takes them from flags and from the environment', () => {
    expect(
      load([
        '--bundle-max-archive-bytes',
        '1000',
        '--bundle-max-unpacked-bytes',
        '2000',
        '--bundle-max-files',
        '30',
        '--bundle-backups-kept',
        '0',
        '--bundle-install-timeout-ms',
        '5000',
      ]),
    ).toMatchObject({
      bundleMaxArchiveBytes: 1000,
      bundleMaxUnpackedBytes: 2000,
      bundleMaxFiles: 30,
      bundleBackupsKept: 0,
      bundleInstallTimeoutMs: 5000,
    });
    expect(
      load([], { MOONCG_BUNDLE_BACKUPS_KEPT: '7', MOONCG_BUNDLE_MAX_FILES: '9' }),
    ).toMatchObject({ bundleBackupsKept: 7, bundleMaxFiles: 9 });
  });

  it('refuses values that make no sense', () => {
    expect(() => load(['--bundle-backups-kept', '-1'])).toThrow(/backups/);
    expect(() => load(['--bundle-max-files', '0'])).toThrow();
    expect(() => load(['--bundle-install-timeout-ms', 'soon'])).toThrow();
  });

  it('has no way to allow file URLs for Git', () => {
    expect(() => load(['--allow-file-git-urls'])).toThrow();
    const config = load([], { MOONCG_ALLOW_FILE_GIT_URLS: '1', MOONCG_GIT_ALLOW_FILE: '1' });
    // `publicUrl` is the address of the server itself and has nothing to do with Git.
    expect(Object.keys(config).filter((key) => /git|url/i.test(key))).toEqual(['publicUrl']);
  });
});
