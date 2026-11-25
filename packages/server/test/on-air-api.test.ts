import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/kernel/config.js';
import type { ServerOptions } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { type AuthServer, authBundles, PASSWORD, startAuthServer } from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: AuthServer | undefined;
const cookies: Record<string, string> = {};

afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

async function start(
  options: Partial<ServerOptions> = {},
  config: Partial<ServerConfig> = {},
): Promise<AuthServer> {
  // Removing a bundle moves it to the backups, which must not end up in a shared folder.
  const started = await startAuthServer(
    temporary,
    { dataDir: await temporary.create({}), ...config },
    options,
  );
  context = started;
  const users = { admin: 'ada', operator: 'olga', viewer: 'vera', nobody: 'nora' };
  for (const [role, name] of Object.entries(users)) {
    if (!started.auth.findUser(name)) {
      await started.auth.createUser({
        name,
        password: PASSWORD,
        roles: role === 'nobody' ? [] : [role],
      });
    }
    cookies[role] = await started.login(name);
  }
  return started;
}

const as = (role: string) => ({ cookie: cookies[role] as string });
const ON_AIR = '/api/v1/on-air';

/** Waits for the job a request started and answers how it ended. */
async function jobOf(server: AuthServer, answer: { json: { job: { id: string } } }) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { json } = await server.http(
      'GET',
      `/api/v1/bundles/-/jobs/${answer.json.job.id}`,
      as('admin'),
    );
    if (['succeeded', 'failed', 'rolled-back'].includes(json.job.state)) return json.job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The job did not finish');
}

describe('GET /api/v1/on-air', () => {
  it('tells everyone who sees the dashboard, and who switched it only to those who manage', async () => {
    const server = await start();
    await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });

    const admin = await server.http('GET', ON_AIR, as('admin'));
    const viewer = await server.http('GET', ON_AIR, as('viewer'));

    expect(admin.json).toEqual({
      onAir: true,
      since: expect.any(String),
      by: 'ada',
      canSwitch: true,
    });
    expect(viewer.json).toEqual({ onAir: true, since: admin.json.since, canSwitch: false });
  });

  it('is off at first', async () => {
    const server = await start();
    expect((await server.http('GET', ON_AIR, as('admin'))).json).toEqual({
      onAir: false,
      canSwitch: true,
    });
  });

  it('is not for someone without the dashboard, and not for a stranger', async () => {
    const server = await start();
    expect((await server.http('GET', ON_AIR, as('nobody'))).status).toBe(403);
    expect((await server.http('GET', ON_AIR)).status).toBe(401);
  });
});

describe('PUT /api/v1/on-air', () => {
  it('takes system:bundles.manage', async () => {
    const server = await start();
    for (const role of ['operator', 'viewer', 'nobody']) {
      const answer = await server.http('PUT', ON_AIR, { ...as(role), json: { onAir: true } });
      expect(answer.status).toBe(403);
    }
    expect((await server.http('PUT', ON_AIR, { json: { onAir: true } })).status).toBe(401);
    expect((await server.http('GET', ON_AIR, as('admin'))).json.onAir).toBe(false);
  });

  it('switches on and off and says where it stands', async () => {
    const server = await start();
    const on = await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });
    const off = await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: false } });

    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ onAir: true, by: 'ada' });
    expect(off.json).toEqual({ onAir: false, canSwitch: true });
    expect(server.lines.some((line) => line.includes('ada switched On Air on'))).toBe(true);
  });

  it.each([{}, { onAir: 'yes' }, { onAir: 1 }, { on: true }])('refuses %j', async (json) => {
    const server = await start();
    const answer = await server.http('PUT', ON_AIR, { ...as('admin'), json });
    expect(answer.status).toBe(400);
  });

  it('is published live to whoever sees the dashboard', async () => {
    const server = await start();
    const socket = await server.socket(as('viewer'), 'system');
    const first = await socket.ask({ t: 'rep.sub', name: 'onAir' });
    expect(first).toMatchObject({ t: 'rep.snap', value: { onAir: false } });

    await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(socket.pushed.at(-1)).toMatchObject({ t: 'rep.patch', name: 'system:onAir' });
    socket.close();
  });

  it('survives a restart of the server', async () => {
    const storage = memoryStorage();
    const first = await start({ storage: { ...storage, close: async () => {} } });
    await first.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });
    await first.server.close();

    const second = await start({ storage });

    expect((await second.http('GET', ON_AIR, as('admin'))).json).toMatchObject({
      onAir: true,
      by: 'ada',
    });
  });
});

describe('while on air', () => {
  /** The usual bundles, and `needy`, which needs `board`. */
  const withDependent = async () => ({
    bundlesDir: await temporary.create({
      ...authBundles(),
      'needy/mooncg.json': manifest('needy', { dependencies: { board: '*' } }),
    }),
  });
  async function onAir(config: Partial<ServerConfig> = {}) {
    const server = await start({}, config);
    await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });
    return server;
  }
  const post = (server: AuthServer, path: string, json: object = {}) =>
    server.http('POST', `/api/v1/bundles/${path}`, { ...as('admin'), json });
  /** A folder with another version of `secret`, for the server to fetch. */
  const nextVersion = (version: string) =>
    temporary.create({ 'mooncg.json': manifest('secret', { version }) });
  const versionOf = (server: AuthServer, name: string) =>
    server.server.manager.get(name)?.manifest?.version;

  it.each(['reload', 'disable'])(
    'refuses to %s a bundle unless the lock is overridden',
    async (action) => {
      const server = await onAir();

      const refused = await post(server, `board/${action}`);
      expect(refused.status).toBe(409);
      expect(refused.json.error).toMatchObject({ code: 'conflict' });
      expect(refused.json.error.message).toContain('on air');
      expect(refused.json.error.message).toContain('forceOnAir');
      expect(server.server.manager.get('board')?.state).toBe('running');
      // `force` is about the bundles that need this one, and about nothing else.
      expect((await post(server, `board/${action}`, { force: true })).status).toBe(409);

      const overridden = await post(server, `board/${action}`, { forceOnAir: true });
      expect(overridden.status).toBe(200);
    },
  );

  it('takes nothing but a plain true as overriding the lock', async () => {
    const server = await onAir();
    for (const forceOnAir of ['true', 1, {}]) {
      expect((await post(server, 'board/reload', { forceOnAir })).status).toBe(409);
    }
  });

  it('asks the same permission of an overriding change as of any other', async () => {
    const server = await onAir();
    const answer = await server.http('POST', '/api/v1/bundles/board/reload', {
      ...as('operator'),
      json: { forceOnAir: true },
    });
    expect(answer.status).toBe(403);
  });

  it('still lets a disabled bundle be enabled', async () => {
    const server = await start();
    await post(server, 'board/disable');
    await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });
    expect((await post(server, 'board/enable')).status).toBe(200);
  });

  it('refuses a removal at once, and removes when the lock is overridden', async () => {
    const server = await onAir();

    const refused = await post(server, 'secret/remove');
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toContain('on air');
    // What removes a bundle others need does not remove one that is on air.
    expect((await post(server, 'secret/remove', { force: true })).status).toBe(409);
    expect(server.server.manager.get('secret')).toBeDefined();

    const overridden = await post(server, 'secret/remove', { forceOnAir: true });
    expect(overridden.status).toBe(202);
    expect((await jobOf(server, overridden)).state).toBe('succeeded');
    expect(server.server.manager.get('secret')).toBeUndefined();
  });

  it('keeps the two overrides of a removal apart: on air, and needed by others', async () => {
    const server = await onAir(await withDependent());

    // Overriding the lock does not take a bundle away from under the ones that need it.
    const needed = await post(server, 'board/remove', { forceOnAir: true });
    expect(needed.status).toBe(409);
    expect(needed.json.error.message).toContain('needed by needy');
    expect(needed.json.error.message).not.toContain('on air');
    const locked = await post(server, 'board/remove', { force: true });
    expect(locked.status).toBe(409);
    expect(locked.json.error.message).toContain('on air');
    expect(server.server.manager.get('board')?.state).toBe('running');

    const both = await post(server, 'board/remove', { force: true, forceOnAir: true });
    expect(both.status).toBe(202);
    expect((await jobOf(server, both)).state).toBe('succeeded');
    expect(server.server.manager.get('board')).toBeUndefined();
  });

  it('gives "force" on a removal the meaning it had before there was a lock', async () => {
    const server = await start({}, await withDependent());

    expect((await post(server, 'board/remove')).status).toBe(409);
    expect((await post(server, 'board/remove', { forceOnAir: true })).status).toBe(409);
    const forced = await post(server, 'board/remove', { force: true });

    expect(forced.status).toBe(202);
    expect((await jobOf(server, forced)).state).toBe('succeeded');
  });

  it('fetches an update, which interrupts nothing, and refuses to put it in place', async () => {
    const server = await onAir();
    const source = { type: 'path', path: await nextVersion('2.0.0') };

    const fetched = await post(server, 'secret/update', { source });
    expect(fetched.status).toBe(202);
    const { staged } = await jobOf(server, fetched);
    expect(staged).toMatchObject({ target: 'secret', version: '2.0.0' });
    const commit = `-/staged/${staged.id}/commit`;

    const refused = await post(server, commit);
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toContain('on air');
    expect(refused.json.error.message).toContain('updating "secret"');
    // What says what becomes of the fetched version, and what to do.
    expect(refused.json.error.message).toContain('stays staged');
    expect(refused.json.error.message).toContain('forceOnAir');
    expect((await post(server, commit, { force: true })).status).toBe(409);
    expect(versionOf(server, 'secret')).toBe('1.0.0');
    const waiting = await server.http('GET', '/api/v1/bundles/-/staged', as('admin'));
    expect(waiting.json.staged).toMatchObject([{ id: staged.id }]);

    const overridden = await post(server, commit, { forceOnAir: true });
    expect(overridden.status).toBe(202);
    expect((await jobOf(server, overridden)).state).toBe('succeeded');
    expect(versionOf(server, 'secret')).toBe('2.0.0');
  });

  it('stages an update from a source and from an upload without any override', async () => {
    const server = await onAir();
    const source = { type: 'path', path: await nextVersion('2.0.0') };

    const staged = await post(server, '-/stage', { source, target: 'secret' });
    const uploaded = await server.http(
      'PUT',
      '/api/v1/bundles/-/stage?filename=secret.zip&target=secret',
      { ...as('admin'), body: new Uint8Array([1, 2, 3]), headers: { 'x-mooncg-csrf': '1' } },
    );

    expect(staged.status).toBe(202);
    expect((await jobOf(server, staged)).state).toBe('succeeded');
    // Taken; that these three bytes are no archive is found out by the job, not by the lock.
    expect(uploaded.status).toBe(202);
    expect((await jobOf(server, uploaded)).error).not.toContain('on air');
  });

  it('puts the update in place once On Air is off, with what was fetched meanwhile', async () => {
    const server = await onAir();
    const source = { type: 'path', path: await nextVersion('2.0.0') };
    const { staged } = await jobOf(server, await post(server, 'secret/update', { source }));

    await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: false } });
    const committed = await post(server, `-/staged/${staged.id}/commit`);

    expect((await jobOf(server, committed)).state).toBe('succeeded');
    expect(versionOf(server, 'secret')).toBe('2.0.0');
  });

  it('refuses to restore a backup over a running bundle unless the lock is overridden', async () => {
    const server = await start();
    const source = { type: 'path', path: await nextVersion('2.0.0') };
    const { staged } = await jobOf(server, await post(server, 'secret/update', { source }));
    await jobOf(server, await post(server, `-/staged/${staged.id}/commit`));
    const { json } = await server.http('GET', '/api/v1/bundles/secret/backups', as('admin'));
    const restore = `secret/backups/${json.backups[0].id}/restore`;
    await server.http('PUT', ON_AIR, { ...as('admin'), json: { onAir: true } });

    expect((await post(server, restore)).status).toBe(409);
    expect((await post(server, restore, { force: true })).status).toBe(409);
    expect(versionOf(server, 'secret')).toBe('2.0.0');

    const overridden = await post(server, restore, { forceOnAir: true });
    expect((await jobOf(server, overridden)).state).toBe('succeeded');
    expect(versionOf(server, 'secret')).toBe('1.0.0');
  });

  it('leaves the buttons for one graphic page alone: they are what an operator has on air', async () => {
    const server = await onAir();
    const socket = await server.socket(as('admin'), 'board', 'graphics/overlay.html');
    const { json } = await server.http('GET', '/api/v1/bundles/board/instances', as('admin'));

    const answer = await post(server, `board/instances/${json.instances[0].id}/reload`);

    expect(answer.status).toBe(204);
    socket.close();
  });

  it('stores settings but does not restart the extension for them, unless the lock is overridden', async () => {
    const bundles = {
      'cfg/mooncg.json': {
        manifest: 1,
        kind: 'bundle',
        name: 'cfg',
        version: '1.0.0',
        extension: 'extension/index.js',
        config: { schema: 'schemas/config.json' },
      },
      'cfg/extension/index.js': 'export default async () => {}',
      'cfg/schemas/config.json': { type: 'object', properties: { title: { type: 'string' } } },
    };
    context = await startAuthServer(temporary, { bundlesDir: await temporary.create(bundles) });
    await context.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
    const admin = { cookie: await context.login('ada') };
    await context.http('PUT', ON_AIR, { ...admin, json: { onAir: true } });

    const answer = await context.http('PUT', '/api/v1/bundles/cfg/config', {
      ...admin,
      json: { values: { title: 'Show' } },
    });

    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ restarted: false });
    expect(answer.json.restartNote).toContain('on air');

    const forced = await context.http('PUT', '/api/v1/bundles/cfg/config', {
      ...admin,
      json: { values: { title: 'Show' }, force: true },
    });
    const overridden = await context.http('PUT', '/api/v1/bundles/cfg/config', {
      ...admin,
      json: { values: { title: 'Show' }, forceOnAir: true },
    });

    expect(forced.json).toMatchObject({ restarted: false });
    expect(overridden.json).toMatchObject({ restarted: true });
    expect(overridden.json).not.toHaveProperty('restartNote');
  });
});

describe('what the bundle list tells about live reload', () => {
  it('shows why a bundle was not reloaded and what waits, to those who are shown the bundle', async () => {
    const server = await start();
    server.server.manager.notePending('board', ['extension']);

    const admin = await server.http('GET', '/api/v1/bundles', as('admin'));
    const viewer = await server.http('GET', '/api/v1/bundles', as('viewer'));
    const board = (answer: typeof admin) =>
      answer.json.bundles.find((bundle: { name: string }) => bundle.name === 'board');

    expect(board(admin)).toMatchObject({ pendingChanges: ['extension'] });
    expect(board(viewer)).toMatchObject({ pendingChanges: ['extension'] });
    expect(board(admin)).not.toHaveProperty('reloadErrors');
  });
});
