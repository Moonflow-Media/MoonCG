import {
  MessageBus,
  type Policy,
  type Principal,
  ReplicantRegistry,
  RouteTable,
} from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { type AppOptions, createApp } from '../src/http/app.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const api = `export default async function start(ctx) {
  await ctx.http.get('/hello/:name', (request) => ({
    body: { hello: request.params.name, q: request.query.q ?? null, agent: request.headers['x-agent'] ?? null },
  }));
  await ctx.http.post('/echo', (request) => ({
    status: 201,
    headers: { 'x-length': String(request.body?.length ?? 0), 'content-type': 'text/plain' },
    body: request.text(),
  }));
  await ctx.http.get('/', () => ({ body: 'root' }));
  await ctx.http.put('/bytes', () => ({ body: new Uint8Array([1, 2, 3]) }));
  await ctx.http.get('/boom', () => { throw new Error('secret detail'); });
  await ctx.http.get('/never', () => new Promise(() => {}));
  await ctx.http.post('/json', (request) => ({ body: request.json() }));
  await ctx.http.get('/secret', () => ({ body: 'for operators' }), { permission: 'operate' });
}`;

const files = () => ({
  'demo/mooncg.json': manifest('demo', {
    extension: 'extension/index.js',
    capabilities: ['http.routes'],
    permissions: { operate: 'Operate' },
    panels: [{ id: 'p', title: 'Panel', file: 'dashboard/panel.html' }],
  }),
  'demo/extension/index.js': api,
  'demo/dashboard/panel.html': 'demo panel',
  'plain/mooncg.json': manifest('plain'),
});

async function setup(overrides: Partial<AppOptions> = {}) {
  const dir = await temporary.create(files());
  const registry = new ReplicantRegistry();
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  const routes = new RouteTable();
  const { logger, lines } = memoryLogger();
  const host = new InlineHost({ registry, bus, routes, logger, httpTimeoutMs: 150 });
  const manager = new BundleManager({ bundlesDir: dir, registry, bus, host, logger });
  await manager.start();
  cleanup.push(() => manager.close());
  const app = await createApp({
    bundles: () => manager.list(),
    routes,
    lifecycle: manager,
    sdkFile: undefined,
    maxBodyBytes: 1024,
    ...overrides,
  });
  cleanup.push(() => app.close());
  return { app, manager, lines };
}

/** May open the dashboard and use the bundle, but neither operate it nor manage bundles. */
const viewer: Principal = { id: 'viewer', roles: ['viewer'] };
const viewerPolicy: Policy = {
  roles: { viewer: ['system:dashboard.view', 'bundle:demo:access'] },
};
const asViewer = { policy: viewerPolicy, resolvePrincipal: () => viewer };

describe('bundle HTTP routes', () => {
  it('passes parameters, query and headers to the handler and returns its JSON', async () => {
    const { app } = await setup();

    const response = await app.inject({
      url: '/b/demo/api/hello/J%C3%BCrgen?q=1',
      headers: { 'x-agent': 'test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.json()).toEqual({ hello: 'Jürgen', q: '1', agent: 'test' });
  });

  it('passes the body on and returns status, headers and text', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/b/demo/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"é": 1}',
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['x-length']).toBe('9');
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.body).toBe('{"é": 1}');
  });

  it('serves the root route and binary bodies', async () => {
    const { app } = await setup();
    const root = await app.inject({ url: '/b/demo/api' });
    const slash = await app.inject({ url: '/b/demo/api/' });
    const bytes = await app.inject({ method: 'PUT', url: '/b/demo/api/bytes' });

    expect([root.body, slash.body]).toEqual(['root', 'root']);
    expect(bytes.headers['content-type']).toBe('application/octet-stream');
    expect([...bytes.rawPayload]).toEqual([1, 2, 3]);
  });

  it.each([
    ['an unknown route', 'GET', '/b/demo/api/nope'],
    ['a bundle without routes', 'GET', '/b/plain/api/hello/x'],
    ['an unknown bundle', 'GET', '/b/ghost/api/hello/x'],
  ])('answers 404 for %s', async (_label, method, url) => {
    const { app } = await setup();
    const response = await app.inject({ method: method as 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('answers 500 for a failing handler without leaking the error, and logs it', async () => {
    const { app, lines } = await setup();

    const response = await app.inject({ url: '/b/demo/api/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
    expect(response.json()).toMatchObject({ error: { code: 'internal' } });
    expect(lines.join('\n')).toContain('secret detail');
  });

  it('answers 504 when the handler does not answer in time', async () => {
    const { app } = await setup();
    const response = await app.inject({ url: '/b/demo/api/never' });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: { code: 'timeout' } });
  });

  it('answers 400 for a body the handler cannot parse and 413 for one that is too large', async () => {
    const { app } = await setup();

    const malformed = await app.inject({ method: 'POST', url: '/b/demo/api/json', payload: '{' });
    const large = await app.inject({
      method: 'POST',
      url: '/b/demo/api/echo',
      payload: 'x'.repeat(2000),
    });

    expect(malformed.statusCode).toBe(400);
    expect(large.statusCode).toBe(413);
  });

  it('checks the bundle permission, or the one the route asks for', async () => {
    const { app } = await setup(asViewer);
    const nobody = await setup({ policy: { roles: {} }, resolvePrincipal: () => viewer });

    expect((await app.inject({ url: '/b/demo/api/hello/x' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/b/demo/api/secret' })).statusCode).toBe(403);
    expect((await nobody.app.inject({ url: '/b/demo/api/hello/x' })).statusCode).toBe(403);
  });

  it('stops answering when the bundle is disabled', async () => {
    const { app, manager } = await setup();
    await manager.disable('demo');
    expect((await app.inject({ url: '/b/demo/api/hello/x' })).statusCode).toBe(404);
  });
});

describe('bundle lifecycle API', () => {
  it('disables a bundle: its files and its entry in the list go away', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/b/demo/dashboard/panel.html' })).statusCode).toBe(200);

    const response = await app.inject({ method: 'POST', url: '/api/v1/bundles/demo/disable' });
    const { bundles } = (await app.inject({ url: '/api/v1/bundles' })).json();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      bundle: { name: 'demo', state: 'disabled', version: '1.0.0', errors: [] },
    });
    expect((await app.inject({ url: '/b/demo/dashboard/panel.html' })).statusCode).toBe(404);
    expect(bundles[0]).toMatchObject({ name: 'demo', state: 'disabled', panels: [] });
  });

  it('enables and reloads a bundle', async () => {
    const { app } = await setup();
    await app.inject({ method: 'POST', url: '/api/v1/bundles/demo/disable' });

    const enabled = await app.inject({ method: 'POST', url: '/api/v1/bundles/demo/enable' });
    const reloaded = await app.inject({ method: 'POST', url: '/api/v1/bundles/demo/reload' });

    expect(enabled.json()).toMatchObject({ bundle: { state: 'running' } });
    expect(reloaded.json()).toMatchObject({ bundle: { state: 'running' } });
    expect((await app.inject({ url: '/b/demo/api/hello/x' })).statusCode).toBe(200);
  });

  it.each([
    ['an unknown bundle', '/api/v1/bundles/ghost/reload', 404, 'not_found'],
    ['a change that does not fit the state', '/api/v1/bundles/demo/enable', 409, 'conflict'],
    ['an unknown action', '/api/v1/bundles/demo/explode', 404, 'not_found'],
  ])('answers with an error for %s', async (_label, url, status, code) => {
    const { app } = await setup();
    const response = await app.inject({ method: 'POST', url });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
  });

  it('needs the permission to manage bundles', async () => {
    const { app, manager } = await setup(asViewer);
    const response = await app.inject({ method: 'POST', url: '/api/v1/bundles/demo/disable' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain('system:bundles.manage');
    expect(manager.isRunning('demo')).toBe(true);
  });

  it('is only reachable by POST', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/v1/bundles/demo/disable' })).statusCode).toBe(404);
  });

  it('reports the state and last error of each bundle in the list', async () => {
    const { app, manager } = await setup();
    await manager.disable('plain');
    const { bundles } = (await app.inject({ url: '/api/v1/bundles' })).json();
    expect(
      bundles.map((bundle: { name: string; state: string }) => [bundle.name, bundle.state]),
    ).toEqual([
      ['demo', 'running'],
      ['plain', 'disabled'],
    ]);
  });
});
