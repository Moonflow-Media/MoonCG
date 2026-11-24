import {
  createSession,
  extensionPrincipal,
  MessageBus,
  ReplicantRegistry,
  RouteTable,
  TRUSTED_EXTENSION_POLICY,
} from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import { createConnection } from '../src/client/client.js';
import { createBundleContext, createLoopback } from '../src/extension/index.js';

/** An extension context on a real server session, with a short timeout for calls. */
function setup() {
  const registry = new ReplicantRegistry();
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  bus.declare('demo', 'ask', {});
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
    extension: { capabilities: ['http.routes'], permissions: [], httpTimeoutMs: 300 },
  });
  loopback.server.onFrame((frame) => session.receive(frame));
  const errors: string[] = [];
  const log = { info: () => {}, warn: () => {}, error: (message: string) => errors.push(message) };
  const connection = createConnection({
    bundle: 'demo',
    url: 'loopback:',
    createSocket: () => loopback.socket,
    onError: (message) => errors.push(message),
  });
  const { context } = createBundleContext({
    connection,
    bundle: { name: 'demo', version: '1.0.0' },
    log,
  });
  const sender = { principal: 'tester', kind: 'user', bundle: 'demo' } as const;
  const ask = () => bus.request('demo:ask', null, sender, 300);
  const get = (path: string) => {
    const match = routes.match('demo', 'GET', path);
    if (!match) throw new Error(`No route for ${path}`);
    return match.route.invoke({
      method: 'GET',
      path,
      params: match.params,
      query: {},
      headers: {},
      sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
      body: null,
    });
  };
  return { context, ask, get, errors };
}

describe('what a request handler returns', () => {
  it('answers null when the handler returns nothing', async () => {
    const { context, ask } = setup();
    await context.handle('ask', (async () => {}) as never);
    await expect(ask()).resolves.toBeNull();
  });

  it.each([
    ['a Date', () => new Date(0)],
    ['NaN', () => Number.NaN],
    ['a function', () => () => {}],
    ['an object with an undefined member', () => ({ a: undefined })],
  ])('rejects the request as internal when the handler returns %s', async (_label, result) => {
    const { context, ask, errors } = setup();
    await context.handle('ask', (async () => result()) as never);

    await expect(ask()).rejects.toMatchObject({ code: 'internal' });
    expect(errors).toHaveLength(1);
  });
});

describe('what a route handler returns', () => {
  it('answers an empty 200 when the handler returns nothing', async () => {
    const { context, get } = setup();
    await context.http.get('/nothing', (() => {}) as never);
    await expect(get('/nothing')).resolves.toEqual({ status: 200, headers: {}, body: null });
  });

  it.each([
    ['a string instead of a response', 'hello'],
    ['an array', [1]],
    ['a status that is not a number', { status: 'ok' }],
    ['an informational status', { status: 101 }],
    ['headers that are not an object', { headers: 'x-a: b' }],
    ['a body that is not JSON', { body: { when: new Date(0) } }],
    ['a body with a function', { body: () => {} }],
  ])('answers internal when the handler returns %s', async (_label, result) => {
    const { context, get, errors } = setup();
    await context.http.get('/bad', (() => result) as never);

    await expect(get('/bad')).rejects.toMatchObject({ code: 'internal' });
    expect(errors).toHaveLength(1);
  });

  it('turns header values that are not text into text', async () => {
    const { context, get } = setup();
    await context.http.get('/n', (() => ({ headers: { 'X-Count': 3 } })) as never);
    await expect(get('/n')).resolves.toMatchObject({ headers: { 'x-count': '3' } });
  });
});
