import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/kernel/config.js';
import { type AuthServer, PASSWORD, startAuthServer } from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: AuthServer | undefined;
let admin = { cookie: '' };

afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

const WAIT_MS = 8000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` answers something, asking every few milliseconds. */
async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
) {
  const end = Date.now() + WAIT_MS;
  for (;;) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await pause(25);
  }
}

const EXTENSION = `export default async function start(ctx) {
  await ctx.replicant('starts').update((draft) => {
    draft.n++;
  });
}`;

const demo = (extra: object = {}) =>
  manifest('demo', {
    extension: 'extension/index.js',
    panels: [{ id: 'control', title: 'Control', file: 'dashboard/control.html' }],
    graphics: [{ id: 'overlay', file: 'graphics/overlay.html', width: 1920, height: 1080 }],
    replicants: { starts: { default: { n: 0 } } },
    ...extra,
  });

async function start(config: Partial<ServerConfig> = {}) {
  const bundlesDir = await temporary.create({
    'demo/mooncg.json': demo(),
    'demo/extension/index.js': EXTENSION,
    'demo/dashboard/control.html': 'control',
    'demo/graphics/overlay.html': 'overlay',
    'other/mooncg.json': manifest('other', {
      panels: [{ id: 'p', title: 'P', file: 'dashboard/p.html' }],
    }),
    'other/dashboard/p.html': 'p',
  });
  const server = await startAuthServer(temporary, { bundlesDir, watch: true, ...config });
  context = server;
  await server.auth.createUser({ name: 'ada', password: PASSWORD, roles: ['admin'] });
  admin = { cookie: await server.login('ada') };
  await server.server.watchers?.ready();
  const edit = async (path: string, content: string | object) => {
    await mkdir(join(bundlesDir, path, '..'), { recursive: true });
    await writeFile(
      join(bundlesDir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };
  const listed = async (name = 'demo') => {
    const { json } = await server.http('GET', '/api/v1/bundles', admin);
    return json.bundles.find((bundle: { name: string }) => bundle.name === name);
  };
  const reloaded = (socket: { pushed: { t: string }[] }) =>
    socket.pushed.some((msg) => msg.t === 'reload');
  return { ...server, bundlesDir, edit, listed, reloaded };
}

describe('live reload with the watcher on', () => {
  it('is off unless the configuration turns it on', async () => {
    const server = await start({ watch: false });
    const panel = await server.socket(admin, 'demo');

    await server.edit('demo/dashboard/control.html', 'changed');
    await pause(600);

    expect(server.server.watchers).toBeUndefined();
    expect(server.reloaded(panel)).toBe(false);
    panel.close();
  });

  it('reloads the panels of the bundle whose dashboard file changed, and nothing else', async () => {
    const server = await start();
    const panel = await server.socket(admin, 'demo');
    const graphic = await server.socket(admin, 'demo', 'graphics/overlay.html');
    const other = await server.socket(admin, 'other');

    await server.edit('demo/dashboard/control.html', 'changed');
    await until(() => server.reloaded(panel), 'the panel to be told to reload');
    await pause(100);

    expect(server.reloaded(graphic)).toBe(false);
    expect(server.reloaded(other)).toBe(false);
    for (const socket of [panel, graphic, other]) socket.close();
  });

  it('marks an open graphic as out of date instead of reloading it', async () => {
    const server = await start();
    const graphic = await server.socket(admin, 'demo', 'graphics/overlay.html');
    const dashboard = await server.socket(admin, 'system');
    await dashboard.ask({ t: 'rep.sub', name: 'demo:$instances.overlay' });

    await server.edit('demo/graphics/overlay.html', 'changed');
    const patch = await until(
      () =>
        dashboard.pushed.find(
          (msg) => msg.t === 'rep.patch' && JSON.stringify(msg).includes('outOfDate'),
        ),
      'the instance to be marked',
    );

    expect(patch).toBeDefined();
    expect(server.reloaded(graphic)).toBe(false);
    graphic.close();
    dashboard.close();
  });

  it('reloads an open graphic in dev mode', async () => {
    const server = await start({ dev: true });
    const graphic = await server.socket(admin, 'demo', 'graphics/overlay.html');

    await server.edit('demo/graphics/overlay.html', 'changed');

    await until(() => server.reloaded(graphic), 'the graphic to be told to reload');
    graphic.close();
  });

  it('restarts the extension when its code changes, and keeps the replicants', async () => {
    const server = await start();
    const socket = await server.socket(admin, 'demo');
    const first = await socket.ask({ t: 'rep.sub', name: 'starts' });
    expect(first).toMatchObject({ value: { n: 1 } });

    await server.edit('demo/extension/index.js', `${EXTENSION}\n// changed`);

    await until(
      () => socket.pushed.some((msg) => msg.t === 'rep.patch' && msg.rev === 2),
      'the extension to start again',
    );
    // The replicant was never taken away: the page did not have to ask again.
    expect(socket.pushed.some((msg) => msg.t === 'rep.gone')).toBe(false);
    socket.close();
  });

  it('applies a changed manifest and tells a connected page that its replicants are back', async () => {
    const server = await start();
    const socket = await server.socket(admin, 'demo');
    await socket.ask({ t: 'rep.sub', name: 'starts' });

    await server.edit('demo/mooncg.json', demo({ title: 'Demo', version: '1.1.0' }));

    await until(async () => (await server.listed())?.version === '1.1.0', 'the new manifest');
    await until(
      () => socket.pushed.some((msg) => msg.t === 'rep.back' && msg.name === 'demo:starts'),
      'the replicant to be announced again',
    );
    expect(socket.pushed.map((msg) => msg.t)).toContain('rep.gone');
    expect(await socket.ask({ t: 'rep.sub', name: 'starts' })).toMatchObject({ t: 'rep.snap' });
    socket.close();
  });

  it('keeps the bundle running on an invalid manifest and says why, until it is fixed', async () => {
    const server = await start();

    await server.edit('demo/mooncg.json', '{ "manifest": 1,');
    const broken = await until(async () => {
      const bundle = await server.listed();
      return bundle?.reloadErrors ? bundle : undefined;
    }, 'the error to show');

    expect(broken).toMatchObject({ state: 'running', version: '1.0.0' });
    expect(broken.reloadErrors[0]).toContain('not valid JSON');
    expect(broken.panels).toHaveLength(1);

    await server.edit('demo/mooncg.json', demo({ version: '1.2.0' }));
    const fixed = await until(async () => {
      const bundle = await server.listed();
      return bundle?.version === '1.2.0' && bundle.state === 'running' ? bundle : undefined;
    }, 'the fixed manifest');
    expect(fixed).not.toHaveProperty('reloadErrors');
  });

  it('holds changes back while on air and applies them when that ends', async () => {
    const server = await start();
    const panel = await server.socket(admin, 'demo');
    await server.http('PUT', '/api/v1/on-air', { ...admin, json: { onAir: true } });

    await server.edit('demo/dashboard/control.html', 'changed');
    await until(async () => (await server.listed())?.pendingChanges, 'the change to be noted');
    expect((await server.listed()).pendingChanges).toEqual(['dashboard']);
    expect(server.reloaded(panel)).toBe(false);

    await server.http('PUT', '/api/v1/on-air', { ...admin, json: { onAir: false } });

    await until(() => server.reloaded(panel), 'the panel to be told to reload');
    expect(await server.listed()).not.toHaveProperty('pendingChanges');
    panel.close();
  });

  it('lets go of a bundle folder before its files are swapped, and watches the new ones', async () => {
    const server = await start();
    const live = join(server.bundlesDir, 'demo');
    const aside = join(server.bundlesDir, '..', `aside-${Date.now()}`);
    const next = await temporary.create({
      'demo/mooncg.json': demo({ version: '2.0.0' }),
      'demo/extension/index.js': EXTENSION,
      'demo/dashboard/control.html': 'control 2',
      'demo/graphics/overlay.html': 'overlay 2',
    });

    // Renaming a folder that is being watched fails on Windows.
    const result = await server.server.manager.replace('demo', {
      apply: async () => {
        await rename(live, aside);
        await rename(join(next, 'demo'), live);
      },
      revert: async () => {},
    });
    await rm(aside, { recursive: true, force: true });

    expect(result.outcome).toBe('replaced');
    await server.server.watchers?.ready();
    const panel = await server.socket(admin, 'demo');
    await server.edit('demo/dashboard/control.html', 'control 3');
    await until(() => server.reloaded(panel), 'the new folder to be watched');
    panel.close();
  });

  it('holds on to nothing once the server is closed', async () => {
    const server = await start();
    await server.server.close();
    context = undefined;

    await expect(
      rename(server.bundlesDir, `${server.bundlesDir}-moved`).then(() =>
        rm(`${server.bundlesDir}-moved`, { recursive: true }),
      ),
    ).resolves.toBeUndefined();
    expect(server.server.watchers?.watching()).toEqual([]);
  });
});
