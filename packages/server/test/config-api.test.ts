import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuthServer, authBundles, PASSWORD, startAuthServer } from './auth-helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
let context: AuthServer | undefined;
let dataDir = '';
const cookies: Record<string, string> = {};

afterEach(async () => {
  await context?.server.close();
  context = undefined;
  await temporary.cleanup();
});

const SECRET = 'hunter2-api-key';
const LIST_SECRET = 'list-secret-key-42';
const SCHEMA = {
  $defs: { key: { type: 'string', 'x-secret': true } },
  type: 'object',
  properties: {
    // A secret that no property name leads to: behind a reference, inside a list.
    keys: { type: 'array', items: { $ref: '#/$defs/key' } },
    league: { type: 'string', default: 'First' },
    periods: { type: 'integer', minimum: 1 },
    explode: { type: 'boolean' },
    apiKey: { type: 'string', minLength: 4, 'x-secret': true },
  },
  additionalProperties: false,
};

/** Tells its configuration to whoever asks: the test's way to see what the extension got. */
const EXTENSION = `export default async function start(ctx) {
  ctx.log.info('Starting with the key ' + ctx.config.apiKey);
  ctx.log.info('The keys are ' + JSON.stringify(ctx.config.keys));
  if (ctx.config.explode) throw new Error('The key ' + ctx.config.apiKey + ' was refused');
  await ctx.http.get('/config', () => ({ body: ctx.config }));
}`;

/** A bundle with a config schema next to the bundles of the other tests. */
async function start(stored?: string): Promise<AuthServer> {
  const bundles: Record<string, string | object> = authBundles();
  bundles['venue/mooncg.json'] = manifest('venue', {
    title: 'Venue',
    extension: 'extension/index.js',
    capabilities: ['http.routes'],
    permissions: { view: 'See the venue' },
    defaultRoles: { operator: ['view'], viewer: ['view'] },
    replicants: { note: { default: 'kept' } },
    config: { schema: 'config.schema.json' },
  });
  bundles['venue/config.schema.json'] = SCHEMA;
  bundles['venue/extension/index.js'] = EXTENSION;
  const bundlesDir = await temporary.create(bundles);
  dataDir = await temporary.create({});
  if (stored !== undefined) {
    await mkdir(join(dataDir, 'config'), { recursive: true });
    await writeFile(join(dataDir, 'config', 'venue.json'), stored);
  }
  const started = await startAuthServer(temporary, { bundlesDir, dataDir });
  context = started;
  const users = { admin: 'ada', operator: 'olga', nobody: 'nora' };
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
const CONFIG = '/api/v1/bundles/venue/config';
const stateOf = (server: AuthServer, name = 'venue') =>
  server.server.bundles.find((bundle) => bundle.name === name)?.state;
const stored = async () =>
  JSON.parse(await readFile(join(dataDir, 'config', 'venue.json'), 'utf8'));
/** What the running extension was started with, as its own route tells it. */
const seenByExtension = async (server: AuthServer) =>
  (await server.http('GET', '/b/venue/api/config', cookie('admin'))).json;

describe('reading a bundle configuration', () => {
  it('answers the schema and the values without the secrets', async () => {
    const server = await start(JSON.stringify({ league: 'A', apiKey: SECRET }));
    const answer = await server.http('GET', CONFIG, cookie('admin'));
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      schema: SCHEMA,
      values: { league: 'A' },
      secretFields: ['/keys', '/apiKey'],
      secrets: ['/apiKey'],
      problems: [],
      bundle: expect.objectContaining({ name: 'venue', state: 'running' }),
    });
    expect(answer.text).not.toContain(SECRET);
  });

  it('takes system:settings.manage, whatever else the caller holds', async () => {
    const server = await start();
    expect((await server.http('GET', CONFIG)).status).toBe(401);
    expect((await server.http('GET', CONFIG, cookie('operator'))).status).toBe(403);
    expect((await server.http('GET', CONFIG, cookie('nobody'))).status).toBe(403);
    const write = { json: { values: {} } };
    expect((await server.http('PUT', CONFIG, { ...cookie('operator'), ...write })).status).toBe(
      403,
    );
    // Whoever may not manage settings learns nothing about which bundles exist.
    const missing = '/api/v1/bundles/nothing/config';
    expect((await server.http('GET', missing, cookie('operator'))).status).toBe(403);
    expect((await server.http('GET', missing, cookie('admin'))).status).toBe(404);
  });

  it('answers 404 for a bundle that has no configuration', async () => {
    const server = await start();
    const answer = await server.http('GET', '/api/v1/bundles/board/config', cookie('admin'));
    expect(answer.status).toBe(404);
  });

  it('lists the bundles that have a configuration to whoever may manage settings', async () => {
    const server = await start();
    const answer = await server.http('GET', '/api/v1/config', cookie('admin'));
    expect(answer.json).toEqual({
      bundles: [expect.objectContaining({ name: 'venue', title: 'Venue', state: 'running' })],
    });
    expect((await server.http('GET', '/api/v1/config', cookie('operator'))).status).toBe(403);
  });
});

describe('the configuration an extension gets', () => {
  it('is what is stored, secrets included, with the defaults of the schema', async () => {
    const server = await start(JSON.stringify({ apiKey: SECRET }));
    expect(await seenByExtension(server)).toEqual({ league: 'First', apiKey: SECRET });
  });

  it('is empty for a bundle without a schema', async () => {
    const server = await start();
    expect(stateOf(server, 'board')).toBe('running');
  });
});

describe('writing a bundle configuration', () => {
  it('stores the values, restarts the extension and answers without the secret', async () => {
    const server = await start();
    const answer = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      json: { values: { league: 'B', periods: 3, apiKey: SECRET } },
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      values: { league: 'B', periods: 3 },
      secrets: ['/apiKey'],
      bundle: { name: 'venue', state: 'running' },
    });
    expect(answer.text).not.toContain(SECRET);
    expect(await stored()).toEqual({ league: 'B', periods: 3, apiKey: SECRET });
    expect(await seenByExtension(server)).toEqual({ league: 'B', periods: 3, apiKey: SECRET });
  });

  it('restarts the extension only: pages keep the replicants they follow', async () => {
    const server = await start();
    const page = await server.socket(cookie('operator'), 'venue');
    expect(await page.ask({ t: 'rep.sub', name: 'note' })).toMatchObject({ value: 'kept' });

    const answer = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      json: { values: { league: 'B' } },
    });
    expect(answer.json.bundle.state).toBe('running');
    expect(await seenByExtension(server)).toEqual({ league: 'B' });
    // Nothing was taken away from the page, and it still hears of changes.
    expect(page.pushed).toEqual([]);
    const write = await page.ask({
      t: 'rep.op',
      name: 'note',
      patches: [{ op: 'replace', path: '', value: 'still here' }],
    });
    expect(write.t).not.toBe('err');
    page.close();
  });

  it('keeps a secret that is left out, and removes one given as null', async () => {
    const server = await start(JSON.stringify({ apiKey: SECRET }));
    const put = (values: object) =>
      server.http('PUT', CONFIG, { ...cookie('admin'), json: { values } });
    expect((await put({ league: 'C' })).json.secrets).toEqual(['/apiKey']);
    expect(await seenByExtension(server)).toEqual({ league: 'C', apiKey: SECRET });
    expect((await put({ league: 'C', apiKey: null })).json.secrets).toEqual([]);
    expect(await stored()).toEqual({ league: 'C' });
  });

  it('refuses what does not fit the schema, names no secret and changes nothing', async () => {
    const server = await start(JSON.stringify({ league: 'A', apiKey: SECRET }));
    const answer = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      json: { values: { periods: 0, apiKey: 'abc' } },
    });
    expect(answer.status).toBe(400);
    expect(answer.json.error.code).toBe('invalid');
    expect(answer.json.error.message).toContain('/periods: must be >= 1');
    expect(answer.text).not.toContain('abc');
    expect(await stored()).toEqual({ league: 'A', apiKey: SECRET });
    expect(await seenByExtension(server)).toEqual({ league: 'A', apiKey: SECRET });

    const shapeless = await server.http('PUT', CONFIG, { ...cookie('admin'), json: { nope: 1 } });
    expect(shapeless.status).toBe(400);
  });

  it('needs what every request that changes something needs', async () => {
    const server = await start();
    const answer = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      body: JSON.stringify({ values: { league: 'X' } }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(answer.status).toBe(403);
    expect(await seenByExtension(server)).toEqual({ league: 'First' });
  });
});

describe('a stored configuration that does not fit', () => {
  it('fails that bundle with a readable error and leaves the server up', async () => {
    const server = await start(JSON.stringify({ periods: 0, apiKey: SECRET }));
    expect(stateOf(server)).toBe('failed');
    expect(stateOf(server, 'board')).toBe('running');
    const list = await server.http('GET', '/api/v1/bundles', cookie('admin'));
    const venue = list.json.bundles.find((bundle: { name: string }) => bundle.name === 'venue');
    expect(venue.lastError).toBe('config: /periods: must be >= 1');

    // The page that repairs it still gets the configuration, with what is wrong.
    const described = await server.http('GET', CONFIG, cookie('admin'));
    expect(described.json.problems).toEqual(['config: /periods: must be >= 1']);
    expect(described.json.bundle.state).toBe('failed');

    const repaired = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      json: { values: { periods: 2 } },
    });
    expect(repaired.json.bundle.state).toBe('running');
    expect(await seenByExtension(server)).toEqual({ league: 'First', periods: 2, apiKey: SECRET });
  });
});

describe('what the answer to a write says about the restart', () => {
  const put = (server: AuthServer, values: object) =>
    server.http('PUT', CONFIG, { ...cookie('admin'), json: { values } });

  it('says that the extension was restarted', async () => {
    const server = await start();
    expect((await put(server, { league: 'B' })).json).toMatchObject({ restarted: true });
  });

  it('stores the values of a disabled bundle and says that nothing was restarted', async () => {
    const server = await start();
    await server.server.manager.disable('venue');
    const answer = await put(server, { league: 'B' });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      values: { league: 'B' },
      restarted: false,
      restartNote: 'The bundle is disabled. The settings apply when it is started.',
      bundle: { state: 'disabled' },
    });
    expect(await stored()).toEqual({ league: 'B' });
  });

  it('answers 200 and says why when the values are stored but the restart was refused', async () => {
    const server = await start();
    // A change of the bundle's state that is under way when the write arrives.
    const { manager } = server.server;
    const original = manager.restartExtension.bind(manager);
    manager.restartExtension = async (name: string) => {
      await manager.disable(name);
      return original(name);
    };
    const answer = await put(server, { league: 'B' });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      restarted: false,
      restartNote: expect.stringContaining('Bundle "venue" is disabled'),
    });
    expect(await stored()).toEqual({ league: 'B' });
  });

  it('says so when the extension did not start again', async () => {
    const server = await start(JSON.stringify({ apiKey: SECRET }));
    const answer = await put(server, { explode: true });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      restarted: false,
      restartNote: 'Extension failed to start: The key *** was refused',
      bundle: { state: 'failed' },
    });
  });
});

describe('a secret behind a reference, in a list', () => {
  it('is in no answer and no log line either', async () => {
    const server = await start();
    const answer = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      json: { values: { keys: [LIST_SECRET] } },
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ values: {}, secrets: ['/keys'] });
    expect(await seenByExtension(server)).toMatchObject({ keys: [LIST_SECRET] });
    expect(server.lines.join('\n')).toContain('The keys are ["***"]');
    for (const path of ['/api/v1/logs', CONFIG]) {
      const read = await server.http('GET', path, cookie('admin'));
      expect(read.text).not.toContain(LIST_SECRET);
    }
    expect(answer.text + server.lines.join('\n')).not.toContain(LIST_SECRET);
  });
});

describe('a secret', () => {
  it('is in no log line, no bundle error, no answer and no frame, whatever the extension does', async () => {
    const server = await start(JSON.stringify({ apiKey: SECRET }));
    // The extension logged the key at start, and now fails with the key in its error.
    const answer = await server.http('PUT', CONFIG, {
      ...cookie('admin'),
      json: { values: { explode: true } },
    });
    expect(answer.json.bundle.state).toBe('failed');
    expect(answer.text).not.toContain(SECRET);
    expect(answer.json.bundle.lastError).toBe('Extension failed to start: The key *** was refused');

    expect(server.lines.join('\n')).toContain('Starting with the key ***');
    expect(server.lines.join('\n')).not.toContain(SECRET);
    for (const path of ['/api/v1/logs', '/api/v1/bundles', '/api/v1/config', CONFIG]) {
      const read = await server.http('GET', path, cookie('admin'));
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(SECRET);
    }
    const socket = await server.socket(cookie('admin'), 'system');
    const bundles = await socket.ask({ t: 'rep.sub', name: 'bundles' });
    socket.close();
    expect(JSON.stringify(bundles)).toContain('The key *** was refused');
    expect(JSON.stringify(bundles)).not.toContain(SECRET);
  });
});
