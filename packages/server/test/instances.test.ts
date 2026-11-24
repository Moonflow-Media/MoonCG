import { encodeMessage, PROTOCOL_VERSION } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerOptions } from '../src/server.js';
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

const OVERLAY = 'graphics/overlay.html';
const STUDIO = 'graphics/studio.html';

/** The bundles of the other tests, with a graphic for operators that takes one instance. */
async function start(options: Partial<ServerOptions> = {}): Promise<AuthServer> {
  const bundles: Record<string, string | object> = authBundles();
  bundles['board/mooncg.json'] = manifest('board', {
    permissions: { view: 'See the board', operate: 'Change the board' },
    defaultRoles: { operator: ['view', 'operate'], viewer: ['view'] },
    graphics: [
      { id: 'overlay', file: OVERLAY, width: 1920, height: 1080, requires: 'view' },
      {
        id: 'studio',
        file: STUDIO,
        width: 1920,
        height: 1080,
        requires: 'operate',
        singleInstance: true,
      },
    ],
  });
  delete bundles['board/extension/index.js'];
  const started = await startAuthServer(
    temporary,
    { bundlesDir: await temporary.create({ ...bundles, 'board/graphics/studio.html': 'studio' }) },
    options,
  );
  context = started;
  const users = { admin: 'ada', operator: 'olga', viewer: 'vera', nobody: 'nora' };
  for (const [role, name] of Object.entries(users)) {
    await started.auth.createUser({
      name,
      password: PASSWORD,
      roles: role === 'nobody' ? [] : [role],
    });
    cookies[role] = await started.login(name);
  }
  return started;
}

const cookie = (role: string) => ({ cookie: cookies[role] as string });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The value of a replicant as a fresh subscription gets it, or the code it is refused with. */
async function read(server: AuthServer, role: string, name: string, bundle = 'board') {
  const socket = await server.socket(cookie(role), bundle);
  const answer = await socket.ask({ t: 'rep.sub', name });
  socket.close();
  return answer.t === 'rep.snap' ? answer.value : answer.t === 'err' ? answer.code : answer.t;
}

describe('connected graphics', () => {
  it('lists a graphic page while it is connected, to whoever may open the graphic', async () => {
    const server = await start();
    expect(await read(server, 'viewer', '$instances.overlay')).toEqual([]);

    const page = await server.socket(cookie('viewer'), 'board', OVERLAY);
    const listed = await read(server, 'viewer', '$instances.overlay');
    // Who has it open is not for everyone who may open the graphic: no principal in here.
    expect(listed).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    ]);

    page.close();
    await tick();
    expect(await read(server, 'viewer', '$instances.overlay')).toEqual([]);
  });

  it('does not count a page that names no graphic, or a file that is none', async () => {
    const server = await start();
    await server.socket(cookie('viewer'), 'board');
    await server.socket(cookie('viewer'), 'board', 'graphics/style.css');
    expect(await read(server, 'viewer', '$instances.overlay')).toEqual([]);
  });

  it('shows the instances of a graphic only to those who may open it', async () => {
    const server = await start();
    await server.socket(cookie('operator'), 'board', STUDIO);
    expect(await read(server, 'operator', '$instances.studio')).toHaveLength(1);
    // A viewer sees the bundle, but not this graphic.
    expect(await read(server, 'viewer', '$instances.studio')).toBe('forbidden');
    // Whoever holds nothing of the bundle is told what they are told about any other name.
    expect(await read(server, 'nobody', 'board:$instances.studio', 'system')).toBe('not_found');
    expect(await read(server, 'nobody', 'board:$instances.nothing', 'system')).toBe('not_found');
  });

  it('lets nobody write the list', async () => {
    const server = await start();
    const socket = await server.socket(cookie('admin'));
    const answer = await socket.ask({
      t: 'rep.op',
      name: '$instances.overlay',
      patches: [{ op: 'replace', path: '', value: [] }],
    });
    expect(answer).toMatchObject({ t: 'err', code: 'forbidden' });
  });

  it('refuses a second instance of a graphic that takes one, until the first is gone', async () => {
    const server = await start();
    const first = await server.socket(cookie('operator'), 'board', STUDIO);
    await expect(server.socket(cookie('admin'), 'board', STUDIO)).rejects.toThrow(
      'hello was refused: conflict',
    );
    expect(await read(server, 'operator', '$instances.studio')).toHaveLength(1);

    first.close();
    await tick();
    await server.socket(cookie('admin'), 'board', STUDIO);
    expect(await read(server, 'operator', '$instances.studio')).toHaveLength(1);
  });

  it('takes any number of instances of a graphic that does not say otherwise', async () => {
    const server = await start();
    await server.socket(cookie('viewer'), 'board', OVERLAY);
    await server.socket(cookie('operator'), 'board', OVERLAY);
    expect(await read(server, 'viewer', '$instances.overlay')).toHaveLength(2);
  });

  it('refuses a page of a graphic its principal may not open', async () => {
    const server = await start();
    await expect(server.socket(cookie('viewer'), 'board', STUDIO)).rejects.toThrow(
      'hello was refused: forbidden',
    );
  });

  it('says in the bundle list which graphics take one instance', async () => {
    const server = await start();
    const answer = await server.http('GET', '/api/v1/bundles', cookie('admin'));
    const board = answer.json.bundles.find((bundle: { name: string }) => bundle.name === 'board');
    expect(
      board.graphics.map((graphic: { id: string; singleInstance: boolean }) => [
        graphic.id,
        graphic.singleInstance,
      ]),
    ).toEqual([
      ['overlay', false],
      ['studio', true],
    ]);
  });

  it('keeps listing a connected page across a reload of its bundle', async () => {
    const server = await start();
    await server.socket(cookie('viewer'), 'board', OVERLAY);
    await server.server.manager.reload('board');
    expect(await read(server, 'viewer', '$instances.overlay')).toHaveLength(1);
  });
});

describe('who has a graphic open', () => {
  it('is told to whoever may manage bundles, and to nobody else', async () => {
    const server = await start();
    const page = await server.socket(cookie('viewer'), 'board', OVERLAY);
    const [{ id }] = (await read(server, 'viewer', '$instances.overlay')) as [{ id: string }];
    const answer = await server.http('GET', '/api/v1/bundles/board/instances', cookie('admin'));
    expect(answer.json).toEqual({
      instances: [
        {
          id,
          graphic: 'overlay',
          principal: expect.stringMatching(/^user:/),
          kind: 'user',
          name: 'vera',
          since: expect.any(String),
        },
      ],
    });
    const path = '/api/v1/bundles/board/instances';
    expect((await server.http('GET', path, cookie('operator'))).status).toBe(403);
    expect((await server.http('GET', path, cookie('nobody'))).status).toBe(404);
    expect((await server.http('GET', path)).status).toBe(401);
    page.close();
  });
});

describe('a graphic that takes one instance', () => {
  it('lets the same principal take its own place: the page before is told and let go', async () => {
    const server = await start();
    const first = await server.socket(cookie('operator'), 'board', STUDIO);
    const second = await server.socket(cookie('operator'), 'board', STUDIO);
    await tick();
    expect(first.pushed).toEqual([{ t: 'graphic.end', reason: 'replaced' }]);
    expect(await read(server, 'operator', '$instances.studio')).toHaveLength(1);
    // Someone else still has to wait, as before.
    await expect(server.socket(cookie('admin'), 'board', STUDIO)).rejects.toThrow('conflict');
    // The page that was let go holds nothing: closing it frees nothing of the new one.
    first.close();
    await tick();
    expect(await read(server, 'operator', '$instances.studio')).toHaveLength(1);
    second.close();
  });

  it('is freed by an operator who disconnects the page that holds it', async () => {
    const server = await start();
    const page = await server.socket(cookie('operator'), 'board', STUDIO);
    const [{ id }] = (await read(server, 'operator', '$instances.studio')) as [{ id: string }];
    const disconnect = (role: string, instance = id) =>
      server.http('POST', `/api/v1/bundles/board/instances/${instance}/disconnect`, {
        ...cookie(role),
        json: {},
      });
    expect((await disconnect('operator')).status).toBe(403);
    expect((await disconnect('nobody')).status).toBe(404);
    expect((await disconnect('admin', 'no-such-instance')).status).toBe(404);
    expect(page.pushed).toEqual([]);

    expect((await disconnect('admin')).status).toBe(204);
    await tick();
    expect(page.pushed).toEqual([{ t: 'graphic.end', reason: 'disconnected' }]);
    expect(await read(server, 'operator', '$instances.studio')).toEqual([]);
    const next = await server.socket(cookie('admin'), 'board', STUDIO);
    next.close();
    page.close();
  });

  it('is freed when the page that holds it stops answering', async () => {
    const server = await start({ socketHeartbeatMs: 30 });
    // A page whose machine went away without closing the connection: it answers no ping.
    const dead = new WebSocket(`ws://127.0.0.1:${server.server.port}/ws`, {
      headers: cookie('operator'),
      autoPong: false,
    });
    await new Promise((resolve) => dead.once('open', resolve));
    dead.send(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'board', graphic: STUDIO }));
    await new Promise((resolve) => dead.once('message', resolve));
    await expect(server.socket(cookie('admin'), 'board', STUDIO)).rejects.toThrow('conflict');

    const closed = new Promise((resolve) => dead.once('close', resolve));
    await closed;
    const next = await server.socket(cookie('admin'), 'board', STUDIO);
    // A page that answers stays, however many pings pass.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await read(server, 'admin', '$instances.studio')).toHaveLength(1);
    next.close();
  });
});

describe('reloading an instance', () => {
  async function withInstance() {
    const server = await start();
    const page = await server.socket(cookie('viewer'), 'board', OVERLAY);
    const [instance] = (await read(server, 'viewer', '$instances.overlay')) as { id: string }[];
    const path = `/api/v1/bundles/board/instances/${instance?.id}/reload`;
    return { server, page, path };
  }

  it('tells the page to load itself again, for whoever may manage bundles', async () => {
    const { server, page, path } = await withInstance();
    const answer = await server.http('POST', path, { ...cookie('admin'), json: {} });
    expect(answer.status).toBe(204);
    await tick();
    expect(page.pushed).toContainEqual({ t: 'reload' });
  });

  it('is refused to whoever may not manage bundles, and the page hears nothing', async () => {
    const { server, page, path } = await withInstance();
    expect((await server.http('POST', path, { ...cookie('operator'), json: {} })).status).toBe(403);
    expect((await server.http('POST', path, { json: {} })).status).toBe(401);
    await tick();
    expect(page.pushed).toEqual([]);
  });

  it('answers 404 to whoever holds nothing of the bundle, as for a bundle that is not there', async () => {
    const { server, path } = await withInstance();
    const refused = await server.http('POST', path, { ...cookie('nobody'), json: {} });
    const missing = await server.http('POST', path.replace('board', 'nowhere'), {
      ...cookie('nobody'),
      json: {},
    });
    expect(refused.status).toBe(404);
    expect(refused.text).toBe(missing.text);
  });

  it('answers 404 for an instance that is not there or belongs to another bundle', async () => {
    const { server, path } = await withInstance();
    const unknown = '/api/v1/bundles/board/instances/00000000-0000-4000-8000-000000000000/reload';
    expect((await server.http('POST', unknown, { ...cookie('admin'), json: {} })).status).toBe(404);
    const other = path.replace('board', 'secret');
    expect((await server.http('POST', other, { ...cookie('admin'), json: {} })).status).toBe(404);
  });

  it('needs what every request that changes something needs', async () => {
    const { server, page, path } = await withInstance();
    const plain = await server.http('POST', path, cookie('admin'));
    expect(plain.status).toBe(403);
    const marked = await server.http('POST', path, {
      ...cookie('admin'),
      headers: { 'x-mooncg-csrf': '1' },
    });
    expect(marked.status).toBe(204);
    await tick();
    expect(page.pushed).toEqual([{ t: 'reload' }]);
  });
});
