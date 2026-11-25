import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD } from './auth-helpers.js';
import {
  FAKE_IDP,
  type ModuleServer,
  moduleManifest,
  startModuleServer,
} from './module-helpers.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: ModuleServer | undefined;

afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

type Listed = {
  name: string;
  state: string;
  enabled: boolean;
  builtin: boolean;
  internal: boolean;
  error?: string;
  providers: string[];
  routes: number;
  permissions: { permission: string; description: string }[];
  config: boolean;
};
async function listed(server: ModuleServer, cookie = server.admin): Promise<Listed[]> {
  const answer = await server.http('GET', '/api/v1/modules', { cookie });
  expect(answer.status).toBe(200);
  return answer.json.modules;
}
const named = async (server: ModuleServer, name: string) =>
  (await listed(server)).find((module) => module.name === name);

/** A module that registers one of everything and counts how often it started and stopped. */
const HELLO = {
  'hello/mooncg.json': moduleManifest('hello', { title: 'Hello', version: '2.1.0' }),
  'hello/index.js': `export default function setup(ctx) {
  const seen = (globalThis.__hello ??= { started: 0, stopped: [], late: undefined });
  seen.started++;
  const use = ctx.permissions.define('use', 'Use the greeting');
  ctx.http.register({
    method: 'GET',
    path: '/greet/:who',
    permission: use,
    handler: (request) => ({
      body: {
        hello: request.params.who,
        principal: request.principal,
        headers: Object.keys(request.headers).sort(),
        query: request.query,
      },
    }),
  });
  ctx.http.register({ method: 'GET', path: '/health', public: true, handler: () => ({ body: 'ok' }) });
  ctx.http.register({
    method: 'POST',
    path: '/echo',
    public: true,
    handler: (request) => ({
      status: 201,
      headers: { 'x-hello': 'yes', connection: 'close' },
      body: { got: Buffer.from(request.body ?? []).toString('utf8') },
    }),
  });
  ctx.http.register({
    method: 'GET',
    path: '/boom',
    public: true,
    handler: () => {
      throw new Error('The handler broke');
    },
  });
  ctx.onDispose(() => seen.stopped.push('onDispose'));
  seen.late = () => ctx.permissions.define('late', 'Too late');
  return () => seen.stopped.push('returned');
}
`,
};
const hello = () =>
  (globalThis as { __hello?: { started: number; stopped: string[]; late?: () => string } }).__hello;

afterEach(() => {
  delete (globalThis as { __hello?: unknown }).__hello;
});

describe('modules', () => {
  it('lists a module in the modules folder as disabled until someone enables it', async () => {
    context = await startModuleServer(temporary, HELLO);
    expect(await named(context, 'hello')).toMatchObject({
      name: 'hello',
      title: 'Hello',
      version: '2.1.0',
      state: 'disabled',
      enabled: false,
      builtin: false,
    });
    expect(hello()).toBeUndefined();
  });

  it('runs the local login as an internal module that cannot be disabled', async () => {
    context = await startModuleServer(temporary, {});
    expect(await named(context, 'auth-local')).toMatchObject({
      state: 'running',
      internal: true,
      builtin: true,
    });
    const answer = await context.http('POST', '/api/v1/modules/auth-local/disable', {
      cookie: context.admin,
      json: {},
    });
    expect(answer.status).toBe(409);
    expect(await context.login('ada')).toContain('mooncg_session=');
  });

  it('starts an enabled module with the server and says what it registered', async () => {
    context = await startModuleServer(temporary, HELLO, ['hello']);
    expect(await named(context, 'hello')).toMatchObject({
      state: 'running',
      enabled: true,
      routes: 4,
      permissions: [{ permission: 'system:module.hello.use', description: 'Use the greeting' }],
    });
    expect(hello()?.started).toBe(1);
  });

  it('enables and disables at run time, remembers the choice and takes everything away again', async () => {
    context = await startModuleServer(temporary, HELLO);
    const { admin, http, server } = context;
    const enabled = await http('POST', '/api/v1/modules/hello/enable', { cookie: admin, json: {} });
    expect(enabled.status).toBe(200);
    expect(enabled.json.module).toMatchObject({ name: 'hello', state: 'running', enabled: true });
    expect(await server.storage.modules.enabled()).toEqual(['hello']);
    expect((await http('GET', '/m/hello/health')).text).toBe('ok');

    const disabled = await http('POST', '/api/v1/modules/hello/disable', {
      cookie: admin,
      json: {},
    });
    expect(disabled.json.module).toMatchObject({ state: 'disabled', enabled: false, routes: 0 });
    expect(await server.storage.modules.enabled()).toEqual([]);
    // What it returned stops it first, then what it registered, last first.
    expect(hello()?.stopped).toEqual(['returned', 'onDispose']);
    expect((await http('GET', '/m/hello/health', { cookie: admin })).status).toBe(404);
    const known = await http('GET', '/api/v1/permissions', { cookie: admin });
    expect(JSON.stringify(known.json)).not.toContain('system:module.hello.use');
    // Its context is closed: nothing is registered by a module that has stopped.
    expect(() => hello()?.late?.()).toThrow(/stopped/);
  });

  it('answers 404 for a module that is not there', async () => {
    context = await startModuleServer(temporary, HELLO);
    for (const name of ['nope', 'Hello', '..']) {
      const answer = await context.http('POST', `/api/v1/modules/${name}/enable`, {
        cookie: context.admin,
        json: {},
      });
      expect(answer.status, name).toBe(404);
    }
  });

  it('is managed by holders of system:modules.manage only', async () => {
    context = await startModuleServer(temporary, HELLO);
    const { auth, http, login } = context;
    auth.createRole('bundler', ['system:bundles.manage', 'system:settings.manage']);
    await auth.createUser({ name: 'bea', password: PASSWORD, roles: ['bundler', 'operator'] });
    const bea = await login('bea');
    for (const [method, path] of [
      ['GET', '/api/v1/modules'],
      ['POST', '/api/v1/modules/hello/enable'],
      ['POST', '/api/v1/modules/hello/disable'],
      ['GET', '/api/v1/modules/hello/config'],
      ['PUT', '/api/v1/modules/hello/config'],
    ] as const) {
      const body = method === 'GET' ? {} : { json: {} };
      expect((await http(method, path, { cookie: bea, ...body })).status, path).toBe(403);
      expect((await http(method, path, body)).status, path).toBe(401);
    }
    expect(hello()).toBeUndefined();
  });

  it('asks a state-changing request for proof that it was meant, like every other route', async () => {
    context = await startModuleServer(temporary, HELLO);
    const { admin, http } = context;
    const forged = await http('POST', '/api/v1/modules/hello/enable', {
      cookie: admin,
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(forged.status).toBe(403);
    const foreign = await http('POST', '/api/v1/modules/hello/enable', {
      cookie: admin,
      json: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect(hello()).toBeUndefined();
  });
});

describe('a module that fails', () => {
  const failing = (name: string, code: string, extra: object = {}) => ({
    [`${name}/mooncg.json`]: moduleManifest(name, extra),
    [`${name}/index.js`]: code,
  });

  it('leaves the server running and shows as failed with its error', async () => {
    context = await startModuleServer(
      temporary,
      {
        ...HELLO,
        ...failing(
          'thrower',
          `export default function setup(ctx) {
  ctx.http.register({ method: 'GET', path: '/x', public: true, handler: () => ({ body: 'x' }) });
  ctx.auth.registerProvider({ id: 'thrower', name: 'T', authorize: () => '', callback: () => ({}) });
  throw new Error('The setup broke');
}`,
        ),
        ...failing('syntax', 'export default function ( {'),
        ...failing('no-setup', 'export const nothing = 1;'),
        ...failing('rejects', 'export default async () => { throw new Error("Later"); };'),
        ...failing('no-main', 'export default () => {};', { main: 'missing.js' }),
        ...failing('too-new', 'export default () => {};', { engine: { mooncg: '^99.0.0' } }),
        'wrong-name/mooncg.json': moduleManifest('other'),
        'a-bundle/mooncg.json': { manifest: 1, kind: 'bundle', name: 'a-bundle', version: '1.0.0' },
        'broken/mooncg.json': '{ not json',
        'notes.txt': 'not a module',
      },
      [
        'hello',
        'thrower',
        'syntax',
        'no-setup',
        'rejects',
        'no-main',
        'too-new',
        'wrong-name',
        'a-bundle',
        'broken',
      ],
    );
    const modules = await listed(context);
    const state = Object.fromEntries(modules.map((module) => [module.name, module.state]));
    expect(state).toEqual({
      'a-bundle': 'failed',
      'auth-local': 'running',
      broken: 'failed',
      hello: 'running',
      'no-main': 'failed',
      'no-setup': 'failed',
      rejects: 'failed',
      syntax: 'failed',
      thrower: 'failed',
      'too-new': 'failed',
      'wrong-name': 'failed',
    });
    const error = (name: string) => modules.find((module) => module.name === name)?.error;
    expect(error('thrower')).toContain('The setup broke');
    expect(error('rejects')).toContain('Later');
    expect(error('no-setup')).toMatch(/default export/);
    expect(error('too-new')).toMatch(/needs MoonCG/);
    expect(error('wrong-name')).toMatch(/folder of the same name/);
    expect(error('a-bundle')).toMatch(/Expected a module/);
    // What the module registered before it threw is gone with it.
    expect(modules.find((module) => module.name === 'thrower')).toMatchObject({
      routes: 0,
      providers: [],
    });
    expect((await context.http('GET', '/m/thrower/x', { cookie: context.admin })).status).toBe(404);
    expect((await context.http('GET', '/auth/thrower/start')).status).toBe(404);
    // And everything else works.
    expect((await context.http('GET', '/m/hello/health')).text).toBe('ok');
    expect(
      context.lines.some((line) => /Module "thrower" failed.*The setup broke/.test(line)),
    ).toBe(true);
  });

  it('fails when a route says neither who may call it nor that anybody may', async () => {
    context = await startModuleServer(
      temporary,
      failing(
        'open-route',
        `export default (ctx) => ctx.http.register({ method: 'GET', path: '/x', handler: () => ({}) });`,
      ),
      ['open-route'],
    );
    expect((await named(context, 'open-route'))?.error).toMatch(/permission.*public/);
  });

  it("cannot define or require what is not its own or the system's", async () => {
    context = await startModuleServer(
      temporary,
      {
        ...failing('grabby', `export default (ctx) => ctx.permissions.define('a.b', 'x');`),
        ...failing(
          'borrower',
          `export default (ctx) => ctx.http.register({ method: 'GET', path: '/x', permission: 'system:module.hello.use', handler: () => ({}) });`,
        ),
        ...failing(
          'wild',
          `export default (ctx) => ctx.http.register({ method: 'GET', path: '/x', permission: '*', handler: () => ({}) });`,
        ),
        ...failing(
          'system-user',
          `export default (ctx) => ctx.http.register({ method: 'GET', path: '/x', permission: 'system:logs.view', handler: () => ({ body: 'logs' }) });`,
        ),
      },
      ['grabby', 'borrower', 'wild', 'system-user'],
    );
    expect((await named(context, 'grabby'))?.state).toBe('failed');
    expect((await named(context, 'borrower'))?.state).toBe('failed');
    expect((await named(context, 'wild'))?.state).toBe('failed');
    expect((await named(context, 'system-user'))?.state).toBe('running');
  });

  it('can be tried again once it is repaired, without a restart', async () => {
    const files = failing('flaky', 'export default () => { throw new Error("Not yet"); };');
    context = await startModuleServer(temporary, files, ['flaky']);
    expect((await named(context, 'flaky'))?.state).toBe('failed');
    const { modulesDir } = context.server.config;
    await temporary.add(modulesDir, {
      'flaky/index.js': `export default (ctx) => ctx.http.register({ method: 'GET', path: '/ok', public: true, handler: () => ({ body: 'fine' }) });`,
    });
    const answer = await context.http('POST', '/api/v1/modules/flaky/enable', {
      cookie: context.admin,
      json: {},
    });
    expect(answer.json.module).toMatchObject({ state: 'running' });
    expect(answer.json.module.error).toBeUndefined();
    expect((await context.http('GET', '/m/flaky/ok')).text).toBe('fine');
  });

  it('refuses a second provider of an id, whoever registered the first', async () => {
    context = await startModuleServer(
      temporary,
      {
        ...FAKE_IDP,
        ...failing(
          'second',
          `export default (ctx) => ctx.auth.registerProvider({ id: 'fake', name: 'Second', authorize: () => 'https://evil.example', callback: () => ({ subject: 'x' }) });`,
        ),
        ...failing(
          'local-thief',
          `export default (ctx) => ctx.auth.registerProvider({ id: 'local', name: 'Local', authorize: () => 'https://evil.example', callback: () => ({ subject: 'x' }) });`,
        ),
      },
      ['fake-idp', 'second', 'local-thief'],
    );
    expect((await named(context, 'fake-idp'))?.providers).toEqual(['fake', 'open']);
    expect((await named(context, 'second'))?.error).toMatch(/taken/);
    expect((await named(context, 'local-thief'))?.state).toBe('failed');
  });
});

describe('the routes of a module', () => {
  async function start() {
    context = await startModuleServer(temporary, HELLO, ['hello']);
    const { auth, login } = context;
    await auth.createUser({ name: 'vera', password: PASSWORD, roles: ['viewer'] });
    return { ...context, vera: await login('vera') };
  }

  it('checks the permission the route names before the handler runs', async () => {
    const { http, admin, vera, auth } = await start();
    expect((await http('GET', '/m/hello/greet/world')).status).toBe(401);
    expect((await http('GET', '/m/hello/greet/world', { cookie: vera })).status).toBe(403);
    const answer = await http('GET', '/m/hello/greet/world?a=1&token=x', { cookie: admin });
    expect(answer.status).toBe(200);
    expect(answer.json.hello).toBe('world');
    expect(answer.json.principal).toMatchObject({ kind: 'user' });
    // The handler sees neither the cookie nor a token of the caller.
    expect(answer.json.headers).not.toContain('cookie');
    expect(answer.json.headers).not.toContain('authorization');
    expect(answer.json.query).toEqual({ a: '1' });
    // A role can be granted what the module defined, and then it is enough.
    auth.grant('viewer', 'system:module.hello.use');
    expect((await http('GET', '/m/hello/greet/world', { cookie: vera })).status).toBe(200);
  });

  it('shows what the modules defined among the permissions there are', async () => {
    const { http, admin, vera } = await start();
    const answer = await http('GET', '/api/v1/permissions', { cookie: admin });
    expect(answer.json.permissions).toContainEqual({
      permission: 'system:module.hello.use',
      description: 'Use the greeting',
      module: 'hello',
    });
    expect(answer.json.permissions).toContainEqual(
      expect.objectContaining({ permission: 'system:modules.manage' }),
    );
    expect((await http('GET', '/api/v1/permissions', { cookie: vera })).status).toBe(403);
  });

  it('serves a public route to anybody, and tells an anonymous caller nothing else', async () => {
    const { http, admin } = await start();
    expect((await http('GET', '/m/hello/health')).status).toBe(200);
    // Whether a route or a module exists is told only to someone who is signed in.
    expect((await http('GET', '/m/hello/nope')).status).toBe(401);
    expect((await http('GET', '/m/nope/health')).status).toBe(401);
    expect((await http('GET', '/m/hello/nope', { cookie: admin })).status).toBe(404);
    expect((await http('GET', '/m/nope/health', { cookie: admin })).status).toBe(404);
    const wrong = await http('DELETE', '/m/hello/health', { cookie: admin, json: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD');
  });

  it('goes through the same origin and forgery checks as every route', async () => {
    const { http, admin } = await start();
    const sent = await http('POST', '/m/hello/echo', { cookie: admin, json: { a: 1 } });
    expect(sent.status).toBe(201);
    expect(sent.json).toEqual({ got: '{"a":1}' });
    expect(sent.headers.get('x-hello')).toBe('yes');
    const forged = await http('POST', '/m/hello/echo', {
      cookie: admin,
      body: 'a=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(forged.status).toBe(403);
    const foreign = await http('POST', '/m/hello/echo', {
      json: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
  });

  it('answers 500 without details when a handler throws, and keeps running', async () => {
    const { http } = await start();
    const answer = await http('GET', '/m/hello/boom');
    expect(answer.status).toBe(500);
    expect(answer.text).not.toContain('The handler broke');
    expect((await http('GET', '/m/hello/health')).status).toBe(200);
  });
});

describe('the configuration of a module', () => {
  const SECRET = 'module-client-secret-1';
  const CONFIGURED = {
    'venue/mooncg.json': moduleManifest('venue', { config: { schema: 'config.schema.json' } }),
    'venue/config.schema.json': {
      type: 'object',
      properties: {
        greeting: { type: 'string', default: 'Hi' },
        clientSecret: { type: 'string', 'x-secret': true },
      },
      additionalProperties: false,
    },
    'venue/index.js': `export default (ctx) => {
  ctx.logger.info('The secret is ' + ctx.config.clientSecret);
  ctx.http.register({ method: 'GET', path: '/config', public: true, handler: () => ({ body: { ...ctx.config } }) });
};`,
  };

  it('starts the module with what is stored and the defaults of the schema', async () => {
    context = await startModuleServer(temporary, CONFIGURED, ['venue']);
    expect((await context.http('GET', '/m/venue/config')).json).toEqual({ greeting: 'Hi' });
    expect(await named(context, 'venue')).toMatchObject({ config: true });
  });

  it('stores it beside the configuration of the bundles, never shows a secret, and starts the module again', async () => {
    context = await startModuleServer(temporary, CONFIGURED, ['venue']);
    const { http, admin, server, lines } = context;
    const saved = await http('PUT', '/api/v1/modules/venue/config', {
      cookie: admin,
      json: { values: { greeting: 'Hello', clientSecret: SECRET } },
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(SECRET);
    expect(saved.json).toMatchObject({
      values: { greeting: 'Hello' },
      secretFields: ['/clientSecret'],
      secrets: ['/clientSecret'],
      restarted: true,
      module: { name: 'venue', state: 'running' },
    });
    const stored = join(server.config.dataDir, 'config', 'modules', 'venue.json');
    expect(JSON.parse(await readFile(stored, 'utf8'))).toEqual({
      greeting: 'Hello',
      clientSecret: SECRET,
    });
    // The module itself gets the secret; nobody else does, not even the log.
    expect((await http('GET', '/m/venue/config')).json).toEqual({
      greeting: 'Hello',
      clientSecret: SECRET,
    });
    const shown = await http('GET', '/api/v1/modules/venue/config', { cookie: admin });
    expect(shown.text).not.toContain(SECRET);
    expect(shown.json.values).toEqual({ greeting: 'Hello' });
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.some((line) => line.includes('The secret is ***'))).toBe(true);
  });

  it('refuses values that do not fit, and a module without a schema', async () => {
    context = await startModuleServer(temporary, { ...CONFIGURED, ...HELLO }, ['venue']);
    const { http, admin } = context;
    const wrong = await http('PUT', '/api/v1/modules/venue/config', {
      cookie: admin,
      json: { values: { greeting: 5 } },
    });
    expect(wrong.status).toBe(400);
    expect((await http('GET', '/api/v1/modules/hello/config', { cookie: admin })).status).toBe(404);
  });

  it('fails a module whose stored configuration does not fit its schema', async () => {
    const dataDir = await temporary.create({ 'config/modules/venue.json': { greeting: 5 } });
    context = await startModuleServer(temporary, CONFIGURED, ['venue'], { dataDir });
    expect(await named(context, 'venue')).toMatchObject({ state: 'failed' });
  });
});

describe('what a module cannot do to the server', () => {
  it('cannot take the place of a module the server ships', async () => {
    context = await startModuleServer(
      temporary,
      {
        'auth-local/mooncg.json': moduleManifest('auth-local'),
        'auth-local/index.js': 'export default () => { globalThis.__hello = { started: 99 }; };',
      },
      ['auth-local'],
    );
    expect(await named(context, 'auth-local')).toMatchObject({ internal: true, state: 'running' });
    expect(hello()).toBeUndefined();
    expect(context.lines.some((line) => /is ignored: MoonCG ships a module/.test(line))).toBe(true);
  });

  it('cannot keep the server from starting with a setup that never ends', async () => {
    context = await startModuleServer(
      temporary,
      {
        'hangs/mooncg.json': moduleManifest('hangs'),
        'hangs/index.js': `export default (ctx) => {
  ctx.http.register({ method: 'GET', path: '/x', public: true, handler: () => ({ body: 'x' }) });
  return new Promise(() => {});
};`,
      },
      ['hangs'],
      {},
      { moduleSetupTimeoutMs: 50 },
    );
    const module = await named(context, 'hangs');
    expect(module).toMatchObject({ state: 'failed', routes: 0 });
    expect(module?.error).toMatch(/did not finish within 50 ms/);
    expect((await context.http('GET', '/m/hangs/x', { cookie: context.admin })).status).toBe(404);
  });

  it('answers with the code of a typed error a handler throws, also one of its own copy of the SDK', async () => {
    context = await startModuleServer(
      temporary,
      {
        'typed/mooncg.json': moduleManifest('typed'),
        // A module with its own node_modules has its own class of this name: the server
        // cannot know the error by its class, only by what it looks like.
        'typed/index.js': `class MoonCGError extends Error {
  name = 'MoonCGError';
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export default (ctx) => {
  const fail = (path, error) =>
    ctx.http.register({ method: 'GET', path, public: true, handler: () => { throw error; } });
  fail('/gone', new MoonCGError('conflict', 'Not now'));
  fail('/odd', new MoonCGError('teapot', 'No such code'));
  fail('/plain', Object.assign(new Error('Looks like one'), { code: 'forbidden' }));
};`,
      },
      ['typed'],
    );
    const answer = await context.http('GET', '/m/typed/gone');
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual({ error: { code: 'conflict', message: 'Not now' } });
    // Anything else is a bug of the module, and says nothing.
    for (const path of ['/m/typed/odd', '/m/typed/plain']) {
      const other = await context.http('GET', path);
      expect(other.status, path).toBe(500);
      expect(other.text, path).not.toMatch(/No such code|Looks like one/);
    }
  });
});
