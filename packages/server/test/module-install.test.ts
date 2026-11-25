import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_ACCESS, type ModuleJob } from '../src/install/module-installer.js';
import { type ModuleServer, moduleManifest, startModuleServer } from './module-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';
import { makeZip, zipOf } from './zip-writer.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

type Files = Readonly<Record<string, string | object>>;
/** A module that answers its version at `/m/greeter/version`. */
const greeter = (version: string, main = ''): Files => ({
  'mooncg.json': moduleManifest('greeter', { version, title: 'Greeter' }),
  'index.js':
    main ||
    `export default function setup(ctx) {
  ctx.http.register({ method: 'GET', path: '/version', public: true, handler: () => ({ body: '${version}' }) });
}
`,
});
const BROKEN = `export default function setup() { throw new Error('This version is broken'); }\n`;
const UPLOAD = { 'content-type': 'application/zip', 'x-mooncg-csrf': '1' };

async function setup(): Promise<
  ModuleServer & {
    admin: string;
    folder(files: Files): Promise<string>;
    settle(answer: { status: number; json: unknown }): Promise<ModuleJob>;
    stage(files: Files, target?: string): Promise<ModuleJob>;
    commit(job: ModuleJob, body?: object): Promise<ModuleJob>;
    version(): Promise<{ status: number; text: string }>;
    modulesDir: string;
  }
> {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-module-install-'));
  const context = await startModuleServer(temporary, {});
  cleanup.push(async () => {
    await context.server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { http, admin } = context;
  const folder = async (files: Files) => {
    const name = `src-${Math.random().toString(36).slice(2)}`;
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, name, path)), { recursive: true });
      await writeFile(
        join(root, name, path),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    return join(root, name);
  };
  const settle = async (answer: { status: number; json: unknown }): Promise<ModuleJob> => {
    expect(answer.status).toBe(202);
    let { job } = answer.json as { job: ModuleJob };
    for (let tries = 0; !['succeeded', 'failed', 'rolled-back'].includes(job.state); tries++) {
      if (tries > 200) throw new Error(`The job did not end: ${JSON.stringify(job)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const asked = await http('GET', `/api/v1/modules/-/jobs/${job.id}`, { cookie: admin });
      job = (asked.json as { job: ModuleJob }).job;
    }
    return job;
  };
  const stage = async (files: Files, target?: string) =>
    settle(
      await http('POST', '/api/v1/modules/-/stage', {
        cookie: admin,
        json: { source: { type: 'path', path: await folder(files) }, target },
      }),
    );
  const commit = async (job: ModuleJob, body: object = {}) =>
    settle(
      await http('POST', `/api/v1/modules/-/staged/${job.staged?.id}/commit`, {
        cookie: admin,
        json: body,
      }),
    );
  const version = () => http('GET', '/m/greeter/version');
  return {
    ...context,
    folder,
    settle,
    stage,
    commit,
    version,
    modulesDir: context.server.config.modulesDir,
  };
}

describe('who may install modules', () => {
  const REQUESTS: [string, string, object?][] = [
    ['POST', '/api/v1/modules/-/stage', { source: { type: 'path', path: '/srv/module' } }],
    ['GET', '/api/v1/modules/-/staged'],
    ['POST', '/api/v1/modules/-/staged/0123456789abcdef01234567/commit', {}],
    ['DELETE', '/api/v1/modules/-/staged/0123456789abcdef01234567', {}],
    ['GET', '/api/v1/modules/-/jobs'],
    ['GET', '/api/v1/modules/-/jobs/0123456789abcdef'],
    ['GET', '/api/v1/modules/-/sources'],
    ['POST', '/api/v1/modules/greeter/update', {}],
    ['POST', '/api/v1/modules/greeter/remove', {}],
  ];

  it('refuses whoever does not hold system:modules.manage, also one who manages bundles', async () => {
    const { http, auth, server } = await setup();
    const ada = auth.findUser('ada');
    const principal = { id: `user:${ada?.id}`, kind: 'user' as const, roles: ['admin'] };
    const bundles = auth.createToken(principal, {
      name: 'bundles',
      grants: ['system:bundles.manage'],
    });
    for (const [method, path, json] of REQUESTS) {
      const answer = await http(method, path, { bearer: bundles.secret, json });
      expect([method, path, answer.status]).toEqual([method, path, 403]);
      expect((await http(method, path, { json })).status).toBe(401);
    }
    const upload = await http('PUT', '/api/v1/modules/-/stage', {
      bearer: bundles.secret,
      headers: UPLOAD,
      body: zipOf(greeter('1.0.0')),
    });
    expect(upload.status).toBe(403);
    expect(server.moduleInstaller.jobs()).toEqual([]);
  });

  it('takes a token that holds the permission', async () => {
    const { http, auth, folder, settle } = await setup();
    const ada = auth.findUser('ada');
    const principal = { id: `user:${ada?.id}`, kind: 'user' as const, roles: ['admin'] };
    const token = auth.createToken(principal, {
      name: 'ci',
      grants: ['system:modules.manage'],
    });
    const job = await settle(
      await http('POST', '/api/v1/modules/-/stage', {
        bearer: token.secret,
        json: { source: { type: 'path', path: await folder(greeter('1.0.0')) } },
      }),
    );
    expect(job).toMatchObject({ state: 'succeeded', by: 'ci (token)' });
  });
});

describe('installing a module', () => {
  it('shows a summary that says the code runs inside the server, and installs it disabled', async () => {
    const { http, admin, stage, commit, version, modulesDir } = await setup();
    const staged = await stage(greeter('1.0.0'));
    expect(staged.staged).toMatchObject({
      kind: 'module',
      name: 'greeter',
      version: '1.0.0',
      title: 'Greeter',
      main: 'index.js',
      access: MODULE_ACCESS,
      installCode: 'none',
    });
    expect(MODULE_ACCESS).toMatch(/inside the MoonCG server process with full access/);
    expect(existsSync(join(modulesDir, 'greeter'))).toBe(false);

    const done = await commit(staged);
    expect(done).toMatchObject({ operation: 'install', state: 'succeeded', module: 'greeter' });
    const listed = (await http('GET', '/api/v1/modules', { cookie: admin })).json.modules;
    expect(listed.find((module: { name: string }) => module.name === 'greeter')).toMatchObject({
      enabled: false,
      state: 'disabled',
      version: '1.0.0',
    });
    // Not running: nothing of it answers.
    expect((await version()).status).not.toBe(200);

    await http('POST', '/api/v1/modules/greeter/enable', { cookie: admin, json: {} });
    expect((await version()).text).toBe('1.0.0');
    const sources = await http('GET', '/api/v1/modules/-/sources', { cookie: admin });
    expect(sources.json.sources.greeter).toMatchObject({ type: 'path' });
  });

  it('takes an uploaded archive', async () => {
    const { http, admin, settle, commit } = await setup();
    const job = await settle(
      await http('PUT', '/api/v1/modules/-/stage?filename=greeter.zip', {
        cookie: admin,
        headers: UPLOAD,
        body: zipOf(greeter('1.0.0')),
      }),
    );
    expect(job.staged?.source).toEqual({ type: 'upload', location: 'greeter.zip' });
    expect((await commit(job)).state).toBe('succeeded');
  });

  it('refuses a bundle as a module, and a module as a bundle', async () => {
    const { http, admin, stage, folder } = await setup();
    const bundle = await stage({ 'mooncg.json': manifest('board') });
    expect(bundle.state).toBe('failed');
    expect(bundle.error).toMatch(/Expected a module, found a bundle/);

    const started = await http('POST', '/api/v1/bundles/-/stage', {
      cookie: admin,
      json: { source: { type: 'path', path: await folder(greeter('1.0.0')) } },
    });
    let job = started.json.job as { id: string; state: string; error?: string };
    for (let tries = 0; job.state === 'queued' || job.state === 'running'; tries++) {
      if (tries > 200) throw new Error('The bundle job did not end');
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = (await http('GET', `/api/v1/bundles/-/jobs/${job.id}`, { cookie: admin })).json.job;
    }
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/Expected a bundle, found a module/);
  });

  it('refuses a module without its main file, one that is there already, and a hostile archive', async () => {
    const { http, admin, stage, commit, settle, modulesDir } = await setup();
    const missing = await stage({ 'mooncg.json': moduleManifest('greeter') });
    expect(missing.error).toMatch(/main file "index.js" is missing/);

    await commit(await stage(greeter('1.0.0')));
    const again = await stage(greeter('1.0.0'));
    expect(again.error).toMatch(/There is a module "greeter" already; update it/);

    const hostile = await settle(
      await http('PUT', '/api/v1/modules/-/stage', {
        cookie: admin,
        headers: UPLOAD,
        body: makeZip([
          { name: 'mooncg.json', data: JSON.stringify(moduleManifest('evil')) },
          { name: '../../../../evil.txt', data: 'evil' },
        ]),
      }),
    );
    expect(hostile.state).toBe('failed');
    expect(hostile.error).toContain('evil.txt');
    expect(existsSync(join(dirname(modulesDir), 'evil.txt'))).toBe(false);
    expect(await readdir(modulesDir)).toEqual(['greeter']);
  });

  it('refuses a module that would steer npm unless it is trusted', async () => {
    const { stage } = await setup();
    const files = {
      ...greeter('1.0.0'),
      'package.json': { name: 'greeter', dependencies: { left: '1.0.0' } },
      '.npmrc': 'registry=https://evil.example/',
    };
    const refused = await stage(files);
    expect(refused.error).toMatch(/would make npm do more than fetch packages/);
  });
});

describe('a module that cannot be taken on after it was moved into place', () => {
  it('takes the folder away again when the manager does not take the module, and stays staged', async () => {
    const { http, admin, stage, commit, server, modulesDir } = await setup();
    const staged = await stage(greeter('1.0.0'));
    const add = vi
      .spyOn(server.modules, 'add')
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    const failed = await commit(staged);

    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/database is locked/);
    expect(existsSync(join(modulesDir, 'greeter'))).toBe(false);
    expect(server.modules.get('greeter')).toBeUndefined();
    const sources = await http('GET', '/api/v1/modules/-/sources', { cookie: admin });
    expect(sources.json.sources.greeter).toBeUndefined();
    // Nothing is lost: the staged module can be installed once more.
    add.mockRestore();
    expect((await commit(staged)).state).toBe('succeeded');
    expect(server.modules.get('greeter')).toMatchObject({ version: '1.0.0' });
  });

  it('forgets the module and takes the folder away when where it came from cannot be written', async () => {
    const { stage, commit, server, modulesDir } = await setup();
    const staged = await stage(greeter('1.0.0'));
    // The file is written beside itself first: a folder in that place makes it fail.
    await mkdir(join(server.config.dataDir, 'module-sources.json.tmp'), { recursive: true });

    const failed = await commit(staged);

    expect(failed.state).toBe('failed');
    expect(existsSync(join(modulesDir, 'greeter'))).toBe(false);
    expect(server.modules.get('greeter')).toBeUndefined();
  });

  it('keeps an update that runs when only where it came from cannot be written', async () => {
    const { http, admin, stage, commit, server, version } = await setup();
    await commit(await stage(greeter('1.0.0')));
    await http('POST', '/api/v1/modules/greeter/enable', { cookie: admin, json: {} });
    const staged = await stage(greeter('1.1.0'), 'greeter');
    await mkdir(join(server.config.dataDir, 'module-sources.json.tmp'), { recursive: true });

    expect((await commit(staged)).state).toBe('succeeded');
    expect((await version()).text).toBe('1.1.0');
    expect(server.modules.get('greeter')).toMatchObject({ version: '1.1.0' });
  });
});

describe('updating and removing a module', () => {
  it('updates a running module and starts the new version', async () => {
    const { http, admin, stage, commit, version } = await setup();
    await commit(await stage(greeter('1.0.0')));
    await http('POST', '/api/v1/modules/greeter/enable', { cookie: admin, json: {} });

    const staged = await stage(greeter('1.1.0'), 'greeter');
    expect(staged.staged).toMatchObject({ target: 'greeter', replaces: '1.0.0', enabled: true });
    expect((await commit(staged)).state).toBe('succeeded');
    expect((await version()).text).toBe('1.1.0');
  });

  it('puts the earlier version back when the new one does not start', async () => {
    const { http, admin, stage, commit, version } = await setup();
    await commit(await stage(greeter('1.0.0')));
    await http('POST', '/api/v1/modules/greeter/enable', { cookie: admin, json: {} });

    const done = await commit(await stage(greeter('2.0.0', BROKEN), 'greeter'));
    expect(done).toMatchObject({ state: 'rolled-back' });
    expect(done.error).toMatch(/This version is broken/);
    expect((await version()).text).toBe('1.0.0');
  });

  it('keeps to the On Air lock for an enabled module, and not for a disabled one', async () => {
    const { http, admin, stage, commit, server, version } = await setup();
    await commit(await stage(greeter('1.0.0')));
    await http('POST', '/api/v1/modules/greeter/enable', { cookie: admin, json: {} });
    await server.onAir.set(true, 'test');

    const staged = await stage(greeter('1.1.0'), 'greeter');
    const path = `/api/v1/modules/-/staged/${staged.staged?.id}/commit`;
    const locked = await http('POST', path, { cookie: admin, json: {} });
    expect(locked.status).toBe(409);
    expect(locked.json.error.message).toMatch(/on air/);
    const removal = await http('POST', '/api/v1/modules/greeter/remove', {
      cookie: admin,
      json: {},
    });
    expect(removal.status).toBe(409);
    expect((await version()).text).toBe('1.0.0');

    expect((await commit(staged, { forceOnAir: true })).state).toBe('succeeded');
    expect((await version()).text).toBe('1.1.0');

    await http('POST', '/api/v1/modules/greeter/disable', { cookie: admin, json: {} });
    const off = await http('POST', '/api/v1/modules/greeter/remove', { cookie: admin, json: {} });
    expect(off.status).toBe(202);
  });

  it('removes a module, keeping its configuration unless asked, and forgets it was enabled', async () => {
    const { http, admin, stage, commit, settle, modulesDir, server } = await setup();
    await commit(await stage(greeter('1.0.0')));
    await http('POST', '/api/v1/modules/greeter/enable', { cookie: admin, json: {} });
    const done = await settle(
      await http('POST', '/api/v1/modules/greeter/remove', { cookie: admin, json: {} }),
    );
    expect(done).toMatchObject({ operation: 'remove', state: 'succeeded' });
    expect(existsSync(join(modulesDir, 'greeter'))).toBe(false);
    expect(server.modules.get('greeter')).toBeUndefined();
    expect(await server.storage.modules.enabled()).not.toContain('greeter');

    // Installed again, it is disabled again.
    await commit(await stage(greeter('1.0.0')));
    expect(server.modules.get('greeter')).toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('refuses to update or remove a module that is part of the server', async () => {
    const { http, admin } = await setup();
    const answer = await http('POST', '/api/v1/modules/auth-local/remove', {
      cookie: admin,
      json: {},
    });
    expect(answer.status).toBe(409);
    expect(answer.json.error.message).toMatch(/shipped with MoonCG/);
  });
});
