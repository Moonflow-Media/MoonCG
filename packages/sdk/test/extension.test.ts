import {
  createSession,
  extensionPrincipal,
  type HttpRequestData,
  MessageBus,
  MoonCGError,
  ReplicantRegistry,
  RouteTable,
  TRUSTED_EXTENSION_POLICY,
} from '@mooncg/core';
import { describe, expect, it, vi } from 'vitest';
import { createConnection } from '../src/client/client.js';
import { type BundleContext, createBundleContext, createLoopback } from '../src/extension/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (base64: string | null) =>
  base64 === null ? null : Buffer.from(base64, 'base64').toString('utf8');
const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

/** An extension context wired to a real server session through an in-process loopback. */
function setup(capabilities: string[] = ['http.routes']) {
  const registry = new ReplicantRegistry();
  const { replicant } = registry.declare('demo', 'score', { initial: { home: 0 } });
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  bus.declare('demo', 'reset', {});
  bus.declare('demo', 'tick', {});
  const routes = new RouteTable();

  const loopback = createLoopback();
  const session = createSession({
    principal: extensionPrincipal('demo'),
    policy: TRUSTED_EXTENSION_POLICY,
    registry,
    bus,
    routes,
    timers: { setTimeout, clearTimeout },
    bundleExists: () => true,
    send: (msg) => loopback.server.send(JSON.stringify(msg)),
    extension: { capabilities, permissions: ['view'] },
  });
  loopback.server.onFrame((frame) => session.receive(frame));
  loopback.server.onClose(() => session.close());

  const lines: string[] = [];
  const log = {
    info: (message: string) => lines.push(`info ${message}`),
    warn: (message: string) => lines.push(`warn ${message}`),
    error: (message: string) => lines.push(`error ${message}`),
  };
  const connection = createConnection({
    bundle: 'demo',
    url: 'loopback:',
    createSocket: () => loopback.socket,
    onError: (message, error) => log.error(`${message}: ${(error as Error).message}`),
  });
  const { context, dispose } = createBundleContext({
    connection,
    bundle: { name: 'demo', version: '1.2.3' },
    log,
  });
  const call = (method: 'GET' | 'POST', path: string, request: Partial<HttpRequestData> = {}) => {
    const match = routes.match('demo', method, path);
    if (!match) throw new Error(`No route for ${method} ${path}`);
    return match.route.invoke({
      method,
      path,
      params: match.params,
      query: {},
      headers: {},
      body: null,
      ...request,
    });
  };
  const sender = { principal: 'tester', bundle: 'demo' };
  return { context, dispose, session, replicant, bus, routes, lines, call, sender };
}

describe('createBundleContext', () => {
  it('describes the bundle and has an empty config', () => {
    const { context } = setup();
    expect(context.bundle).toEqual({ name: 'demo', version: '1.2.3' });
    expect(context.config).toEqual({});
  });

  it('reads and writes replicants through the server session', async () => {
    const { context, replicant } = setup();
    const score = context.replicant<{ home: number }>('score');
    const seen: number[] = [];
    score.subscribe((value) => seen.push(value.home));

    await score.ready;
    await score.update((draft) => {
      draft.home = 3;
    });
    replicant.applyOp({ patches: [{ op: 'replace', path: '/home', value: 4 }] });

    expect(replicant.rev).toBe(2);
    expect(seen).toEqual([0, 3, 4]);
    expect(score.value).toEqual({ home: 4 });
  });

  it('sends and receives messages', async () => {
    const { context, bus, sender } = setup();
    const heard = vi.fn();
    const fromBus = vi.fn();
    bus.subscribe('demo:tick', fromBus);

    const stop = await context.on('reset', heard);
    await context.send('tick', { n: 1 });
    bus.publish('demo:reset', 'now', sender);
    stop();
    await tick();
    bus.publish('demo:reset', 'again', sender);

    expect(fromBus).toHaveBeenCalledExactlyOnceWith(
      { n: 1 },
      { principal: 'extension:demo', bundle: 'demo' },
    );
    expect(heard).toHaveBeenCalledExactlyOnceWith('now', { sender });
  });

  it('handles requests and can ask others', async () => {
    const { context, bus, sender } = setup();
    await context.handle('reset', async (data, meta) => ({ data, by: meta.sender.principal }));

    await expect(bus.request('demo:reset', 7, sender)).resolves.toEqual({ data: 7, by: 'tester' });
    await expect(context.request('reset', 8)).resolves.toEqual({ data: 8, by: 'extension:demo' });
    await expect(context.request('tick')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('serves HTTP routes with parameters and a JSON answer', async () => {
    const { context, call } = setup();
    await context.http.get('/teams/:id', (request) => ({
      body: { id: request.params.id ?? null, q: request.query.q ?? null },
    }));

    const response = await call('GET', '/teams/7', { query: { q: 'x' } });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(text(response.body) as string)).toEqual({ id: '7', q: 'x' });
  });

  it('gives the handler the body as bytes, text and JSON', async () => {
    const { context, call } = setup();
    await context.http.post('/echo', (request) => ({
      status: 201,
      headers: { 'x-length': String(request.body?.length ?? 0) },
      body: { text: request.text(), json: request.json() as never },
    }));

    const response = await call('POST', '/echo', { body: base64('{"é":1}') });

    expect(response.status).toBe(201);
    expect(response.headers['x-length']).toBe('8');
    expect(JSON.parse(text(response.body) as string)).toEqual({ text: '{"é":1}', json: { é: 1 } });
  });

  it('answers text, bytes and nothing at all with fitting content types', async () => {
    const { context, call } = setup();
    await context.http.get('/text', () => ({ body: 'héllo' }));
    await context.http.get('/bytes', () => ({ body: new Uint8Array([0, 255, 16]) }));
    await context.http.get('/empty', () => ({ status: 204 }));
    await context.http.get('/custom', () => ({
      headers: { 'Content-Type': 'text/csv' },
      body: 'a,b',
    }));

    const plain = await call('GET', '/text');
    const bytes = await call('GET', '/bytes');
    const empty = await call('GET', '/empty');
    const custom = await call('GET', '/custom');

    expect([plain.headers['content-type'], text(plain.body)]).toEqual([
      'text/plain; charset=utf-8',
      'héllo',
    ]);
    expect(bytes.headers['content-type']).toBe('application/octet-stream');
    expect([...Buffer.from(bytes.body as string, 'base64')]).toEqual([0, 255, 16]);
    expect(empty).toEqual({ status: 204, headers: {}, body: null });
    expect(custom.headers).toEqual({ 'content-type': 'text/csv' });
  });

  it('turns a failing handler into an error without leaking it, and logs it', async () => {
    const { context, call, lines } = setup();
    await context.http.get('/boom', () => {
      throw new Error('secret detail');
    });
    await context.http.post('/json', (request) => ({ body: request.json() as never }));
    await context.http.get('/typed', () => {
      throw new MoonCGError('not_found', 'no such team');
    });

    await expect(call('GET', '/boom')).rejects.toMatchObject({
      code: 'internal',
      message: expect.not.stringContaining('secret'),
    });
    await expect(call('POST', '/json', { body: base64('{') })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(call('GET', '/typed')).rejects.toMatchObject({ code: 'not_found' });
    expect(lines.filter((line) => line.startsWith('error'))).toEqual([
      'error the handler of the route failed: secret detail',
    ]);
  });

  it('registers every method and passes the route permission on', async () => {
    const { context, routes } = setup();
    const handler = () => ({});
    await context.http.get('/r', handler);
    await context.http.post('/r', handler);
    await context.http.put('/r', handler);
    await context.http.patch('/r', handler);
    await context.http.delete('/r', handler, { permission: 'view' });

    expect(routes.count('demo')).toBe(5);
    expect(routes.match('demo', 'DELETE', '/r')?.route.permission).toBe('bundle:demo:view');
    await expect(context.http.get('/r', handler)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects route registration without the http.routes capability', async () => {
    const { context } = setup([]);
    await expect(context.http.get('/r', () => ({}))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('runs dispose callbacks in reverse order and releases everything on the server', async () => {
    const { context, dispose, session, lines } = setup();
    await context.replicant('score').ready;
    await context.on('tick', () => {});
    await context.handle('reset', async () => null);
    await context.http.get('/r', () => ({}));
    const order: string[] = [];
    context.onDispose(() => {
      order.push('first');
    });
    context.onDispose(async () => {
      await tick();
      order.push('second');
    });
    context.onDispose(() => {
      throw new Error('cleanup failure');
    });
    expect(session.stats()).toMatchObject({ replicants: 1, listeners: 1, handlers: 1, routes: 1 });

    await dispose();

    expect(order).toEqual(['second', 'first']);
    expect(lines).toContain('error A dispose callback failed: cleanup failure');
    expect(session.stats()).toEqual({
      replicants: 0,
      listeners: 0,
      handlers: 0,
      routes: 0,
      calls: 0,
    });
  });
});

/** Compile-time only: the generated `ReplicantMap` also types `ctx.replicant()`. */
export type ContextReplicant = ReturnType<BundleContext['replicant']>;
