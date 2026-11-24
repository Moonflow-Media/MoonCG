import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, type RequestOptions, startWithRoles, type TestSocket } from './auth-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

/**
 * The deny matrix: every built-in role, a role with a wildcard grant, an API token and nobody
 * at all, against every kind of resource, over HTTP and over a real socket. One table states
 * what each may do; nothing else may.
 *
 * - `token` is an API token of the admin limited to `bundle:board:view`.
 * - `wild` is a user whose only role grants `bundle:*:view`.
 */

const PRINCIPALS = [
  'admin',
  'operator',
  'viewer',
  'graphics',
  'token',
  'wild',
  'anonymous',
] as const;
type Who = (typeof PRINCIPALS)[number];
const SIGNED_IN = PRINCIPALS.filter((who) => who !== 'anonymous');

const temporary = temporaryBundles();
let context: Awaited<ReturnType<typeof startWithRoles>>;
const credentials = new Map<Who, RequestOptions>();
const sockets = new Map<Who, TestSocket>();

beforeAll(async () => {
  context = await startWithRoles(temporary);
  const { auth, http, login, cookies } = context;
  for (const role of ['admin', 'operator', 'viewer', 'graphics'] as const) {
    credentials.set(role, { cookie: cookies[role] });
  }
  auth.createRole('wild', ['bundle:*:view']);
  await auth.createUser({ name: 'will', password: PASSWORD, roles: ['wild'] });
  credentials.set('wild', { cookie: await login('will') });
  const created = await http('POST', '/api/v1/tokens', {
    cookie: cookies.admin,
    json: { name: 'OBS', grants: ['bundle:board:view'] },
  });
  credentials.set('token', { bearer: created.json.secret });
  credentials.set('anonymous', {});
  for (const who of SIGNED_IN) {
    const { cookie, bearer } = credentials.get(who) as RequestOptions;
    const headers: Record<string, string> =
      bearer === undefined ? { cookie: cookie as string } : { authorization: `Bearer ${bearer}` };
    sockets.set(who, await context.socket(headers));
  }
});
afterAll(async () => {
  for (const socket of sockets.values()) socket.close();
  await context.server.close();
  await temporary.cleanup();
});

const as = (who: Who) => credentials.get(who) as RequestOptions;
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Each row: what is asked, and the status for admin, operator, viewer, graphics, token, wild
 * and anonymous. 404 where the principal holds nothing of the bundle: it is not there for
 * them. 403 where they see the bundle but lack the permission.
 */
const HTTP: [string, string, number[]][] = [
  ['GET', '/', [200, 200, 200, 403, 403, 403, 302]],
  // The dashboard's built files are for whoever is signed in, like the SDK.
  ['GET', '/ui/app.js', [200, 200, 200, 200, 200, 200, 401]],
  ['GET', '/sdk/mooncg.js', [200, 200, 200, 200, 200, 200, 401]],
  ['GET', '/api/v1/bundles', [200, 200, 200, 403, 403, 403, 401]],
  ['GET', '/api/v1/me', [200, 200, 200, 200, 200, 200, 401]],
  // A panel that requires `operate`, a graphic that requires `view`.
  ['GET', '/b/board/dashboard/control.html', [200, 200, 403, 403, 403, 403, 401]],
  ['GET', '/b/board/graphics/overlay.html', [200, 200, 200, 200, 200, 200, 401]],
  // A file without a manifest entry: any permission of the bundle is enough.
  ['GET', '/b/board/graphics/style.css', [200, 200, 200, 200, 200, 200, 401]],
  // A bundle only the admin and the wildcard role hold something of.
  ['GET', '/b/secret/graphics/g.html', [200, 404, 404, 404, 404, 200, 401]],
  ['GET', '/b/secret/graphics/style.css', [404, 404, 404, 404, 404, 404, 401]],
  ['GET', '/b/absent/graphics/g.html', [404, 404, 404, 404, 404, 404, 401]],
  // Bundle API routes: one without a permission, one that requires `operate`.
  ['GET', '/b/board/api/public', [200, 200, 200, 200, 200, 200, 401]],
  ['POST', '/b/board/api/score', [200, 200, 403, 403, 403, 403, 401]],
  ['GET', '/b/secret/api/anything', [404, 404, 404, 404, 404, 404, 401]],
  ['POST', '/api/v1/bundles/secret/reload', [200, 403, 403, 403, 403, 403, 401]],
  ['GET', '/api/v1/users', [200, 403, 403, 403, 403, 403, 401]],
  ['POST', '/api/v1/users', [400, 403, 403, 403, 403, 403, 401]],
  ['GET', '/api/v1/roles', [200, 403, 403, 403, 403, 403, 401]],
  ['POST', '/api/v1/roles', [400, 403, 403, 403, 403, 403, 401]],
  ['GET', '/api/v1/tokens', [200, 403, 403, 403, 403, 403, 401]],
  ['POST', '/api/v1/tokens', [400, 403, 403, 403, 403, 403, 401]],
  // Only a user signed in with a password has one to change; the empty body is refused.
  ['POST', '/api/v1/me/password', [400, 400, 400, 400, 403, 400, 401]],
];
const CHANGING = HTTP.filter(([method]) => method === 'POST').map(([, path]) => path);

describe('deny matrix over HTTP', () => {
  describe.each(HTTP)('%s %s', (method, path, expected) => {
    it.each(PRINCIPALS.map((who, index) => [who, expected[index] as number] as const))(
      'as %s answers %i',
      async (who, status) => {
        const answer = await context.http(method, path, {
          ...as(who),
          ...(method === 'POST' ? { headers: JSON_HEADERS, body: '{}' } : {}),
        });
        expect(answer.status).toBe(status);
        if (status === 401 || status === 403) {
          expect(answer.json).toMatchObject({ error: { code: 'forbidden' } });
        }
      },
    );
  });

  it('never serves a refused file', async () => {
    const answer = await context.http('GET', '/b/board/dashboard/control.html', as('viewer'));
    expect(answer.text).not.toContain('board control');
  });

  it('answers a hidden bundle with the very body of a missing one', async () => {
    const hidden = await context.http('GET', '/b/secret/graphics/g.html', as('token'));
    const absent = await context.http('GET', '/b/absent/graphics/g.html', as('token'));
    expect(hidden.text).toBe(absent.text);
  });
});

describe('request forgery and origin, for every state-changing route', () => {
  const cookieUsers = SIGNED_IN.filter((who) => who !== 'token');

  describe.each(CHANGING)('POST %s', (path) => {
    it.each(cookieUsers)(
      'with the cookie of %s but neither JSON nor the header is refused',
      async (who) => {
        const answer = await context.http('POST', path, as(who));
        expect(answer.status).toBe(403);
        expect(answer.json.error.message).toMatch(/X-MoonCG-CSRF/);
      },
    );

    it.each(PRINCIPALS)('from another origin as %s is refused', async (who) => {
      const answer = await context.http('POST', path, {
        ...as(who),
        headers: { ...JSON_HEADERS, origin: 'http://evil.example' },
        body: '{}',
      });
      expect(answer.status).toBe(403);
      expect(answer.json.error.message).toMatch(/origin/);
    });
  });

  it('does not ask a bearer token for the header: it is judged by its permissions', async () => {
    const answer = await context.http('POST', '/api/v1/bundles/secret/reload', as('token'));
    expect(answer.status).toBe(403);
    expect(answer.json.error.message).toMatch(/system:bundles\.manage/);
  });
});

describe('framing', () => {
  it.each([
    ['/login', 'anonymous', "frame-ancestors 'none'", 'DENY'],
    ['/', 'admin', "frame-ancestors 'none'", 'DENY'],
    ['/b/board/dashboard/control.html', 'operator', "frame-ancestors 'self'", 'SAMEORIGIN'],
    ['/b/board/graphics/overlay.html', 'token', "frame-ancestors 'self'", 'SAMEORIGIN'],
  ] as const)('%s as %s is sent with %s', async (path, who, policy, frameOptions) => {
    const answer = await context.http('GET', path, as(who));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-security-policy')).toContain(policy);
    expect(answer.headers.get('x-frame-options')).toBe(frameOptions);
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

type Outcome = true | 'forbidden' | 'not_found';
const NO: Outcome = 'forbidden';
const GONE: Outcome = 'not_found';

/** Each row: the request, and the outcome for admin, operator, viewer, graphics, token, wild. */
const SOCKET: [string, Parameters<TestSocket['ask']>[0], Outcome[]][] = [
  [
    'subscribe to a replicant that requires view',
    { t: 'rep.sub', name: 'score' },
    [true, true, true, true, true, true],
  ],
  [
    'write a replicant that requires operate',
    { t: 'rep.op', name: 'score', patches: [{ op: 'replace', path: '/home', value: 1 }] },
    [true, true, NO, NO, NO, NO],
  ],
  // No permission in the manifest: any permission of the bundle is enough.
  [
    'subscribe to a replicant without a permission',
    { t: 'rep.sub', name: 'notes' },
    [true, true, true, true, true, true],
  ],
  [
    'listen to a message that requires view',
    { t: 'msg.sub', name: 'reset' },
    [true, true, true, true, true, true],
  ],
  [
    'send a message that requires operate',
    { t: 'msg.send', name: 'reset', data: null },
    [true, true, NO, NO, NO, NO],
  ],
  [
    'read the state of every bundle',
    { t: 'rep.sub', name: 'system:bundles' },
    [true, NO, NO, NO, NO, NO],
  ],
  [
    'follow the change counter',
    { t: 'rep.sub', name: 'system:revision' },
    [true, true, true, NO, NO, NO],
  ],
  // A bundle the principal holds nothing of is not there for it.
  [
    'subscribe to a replicant of a hidden bundle',
    { t: 'rep.sub', name: 'secret:data' },
    [true, GONE, GONE, GONE, GONE, true],
  ],
  [
    'subscribe to a replicant of a missing bundle',
    { t: 'rep.sub', name: 'absent:data' },
    [GONE, GONE, GONE, GONE, GONE, GONE],
  ],
  [
    'write a read-only system replicant',
    { t: 'rep.op', name: 'system:revision', patches: [{ op: 'replace', path: '', value: 1 }] },
    [NO, NO, NO, NO, NO, NO],
  ],
];

describe('deny matrix over a socket', () => {
  it('refuses the upgrade without credentials, and with made-up ones', async () => {
    expect(await context.upgrade()).toBe(401);
    expect(await context.upgrade({ cookie: 'mooncg_session=made-up' })).toBe(401);
    expect(await context.upgrade({ authorization: 'Bearer mcg_made-up' })).toBe(401);
  });

  it.each(SIGNED_IN)('accepts the upgrade as %s', (who) => {
    expect(sockets.has(who)).toBe(true);
  });

  describe.each(SOCKET)('%s', (_what, request, expected) => {
    it.each(SIGNED_IN.map((who, index) => [who, expected[index] as Outcome] as const))(
      'as %s: %s',
      async (who, outcome) => {
        const answer = await (sockets.get(who) as TestSocket).ask(request);
        if (outcome === true) expect(answer.t).not.toBe('err');
        else expect(answer).toMatchObject({ t: 'err', code: outcome });
      },
    );
  });

  it('refuses hello for a hidden bundle like for a missing one', async () => {
    const headers = { cookie: (as('viewer') as { cookie: string }).cookie };
    await expect(context.socket(headers, 'secret')).rejects.toThrow('hello was refused: not_found');
    await expect(context.socket(headers, 'absent')).rejects.toThrow('hello was refused: not_found');
  });
});

describe('what a principal is shown', () => {
  const names = (answer: { json: { bundles: { name: string }[] } }) =>
    answer.json.bundles.map((bundle) => bundle.name);

  it('lists only the bundles a principal holds a permission of', async () => {
    const admin = await context.http('GET', '/api/v1/bundles', as('admin'));
    const operator = await context.http('GET', '/api/v1/bundles', as('operator'));
    const viewer = await context.http('GET', '/api/v1/bundles', as('viewer'));
    expect(names(admin)).toEqual(['board', 'secret']);
    expect(names(operator)).toEqual(['board']);
    expect(names(viewer)).toEqual(['board']);
    expect(admin.json.canManage).toBe(true);
    expect(operator.json.canManage).toBe(false);
  });

  it('lists only the panels and graphics a principal may open', async () => {
    const operator = await context.http('GET', '/api/v1/bundles', as('operator'));
    const viewer = await context.http('GET', '/api/v1/bundles', as('viewer'));
    expect(operator.json.bundles[0].panels).toHaveLength(1);
    expect(viewer.json.bundles[0].panels).toEqual([]);
    expect(viewer.json.bundles[0].graphics).toHaveLength(1);
  });
});
