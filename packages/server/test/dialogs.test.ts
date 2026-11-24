import { afterEach, describe, expect, it } from 'vitest';
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

/** A bundle with a dialog for operators and one for whoever holds anything of the bundle. */
async function start(): Promise<AuthServer> {
  const bundles: Record<string, string | object> = authBundles();
  delete bundles['board/extension/index.js'];
  bundles['board/mooncg.json'] = manifest('board', {
    permissions: { view: 'See the board', operate: 'Change the board' },
    defaultRoles: { operator: ['view', 'operate'], viewer: ['view'] },
    panels: [{ id: 'control', title: 'Control', file: 'dashboard/control.html' }],
    dialogs: [
      {
        id: 'confirm-reset',
        title: 'Reset?',
        file: 'dashboard/confirm.html',
        width: 4,
        requires: 'operate',
      },
      { id: 'about', file: 'dashboard/about.html' },
    ],
  });
  bundles['board/dashboard/confirm.html'] = 'confirm dialog';
  bundles['board/dashboard/about.html'] = 'about dialog';
  const started = await startAuthServer(temporary, {
    bundlesDir: await temporary.create(bundles),
  });
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

describe('dialogs', () => {
  it('lists the dialogs a user may open with the bundle, with their URL', async () => {
    const server = await start();
    const dialogsFor = async (role: string) => {
      const answer = await server.http('GET', '/api/v1/bundles', cookie(role));
      return answer.json.bundles.find((bundle: { name: string }) => bundle.name === 'board')
        .dialogs;
    };
    expect(await dialogsFor('operator')).toEqual([
      {
        id: 'confirm-reset',
        title: 'Reset?',
        width: 4,
        url: '/b/board/dashboard/confirm.html',
      },
      { id: 'about', width: 3, url: '/b/board/dashboard/about.html' },
    ]);
    expect(await dialogsFor('viewer')).toEqual([
      { id: 'about', width: 3, url: '/b/board/dashboard/about.html' },
    ]);
  });

  it('serves a dialog file under the rules of a panel', async () => {
    const server = await start();
    const get = (role: string, file: string) =>
      server.http('GET', `/b/board/dashboard/${file}`, cookie(role));

    const allowed = await get('operator', 'confirm.html');
    expect(allowed.status).toBe(200);
    expect(allowed.text).toBe('confirm dialog');
    // Framed by the dashboard, and by nothing else.
    expect(allowed.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");

    expect((await get('viewer', 'confirm.html')).status).toBe(403);
    expect((await get('viewer', 'about.html')).status).toBe(200);
    expect((await get('nobody', 'about.html')).status).toBe(404);
    expect((await server.http('GET', '/b/board/dashboard/about.html')).status).toBe(401);
  });
});
