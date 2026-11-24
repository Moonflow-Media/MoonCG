import {
  createSession,
  extensionPrincipal,
  ReplicantRegistry,
  RouteTable,
  TRUSTED_EXTENSION_POLICY,
} from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import { createConnection } from '../src/client/client.js';
import { createBundleContext, createLoopback } from '../src/extension/index.js';

describe('a route handler', () => {
  it('learns who calls it and can check that caller against the bundle permissions', async () => {
    const routes = new RouteTable();
    const loopback = createLoopback();
    const session = createSession({
      principal: extensionPrincipal('demo'),
      policy: TRUSTED_EXTENSION_POLICY,
      registry: new ReplicantRegistry(),
      routes,
      timers: { setTimeout, clearTimeout },
      bundleExists: () => true,
      send: (msg) => loopback.server.send(JSON.stringify(msg)),
      extension: { capabilities: ['http.routes'], permissions: ['operate'] },
      checkPermission: (principal, permission) =>
        principal === 'user:op' && permission === 'bundle:demo:operate',
    });
    loopback.server.onFrame((frame) => session.receive(frame));
    const connection = createConnection({
      bundle: 'demo',
      url: 'loopback:',
      createSocket: () => loopback.socket,
    });
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const { context } = createBundleContext({
      connection,
      bundle: { name: 'demo', version: '1.0.0' },
      log,
    });
    await context.http.get('/who', async (request) => ({
      body: {
        sender: request.sender,
        operate: await context.permissions.check(request.sender, 'operate'),
      },
    }));

    const call = async (principal: string) => {
      const match = routes.match('demo', 'GET', '/who');
      const sender = { principal, kind: 'user', bundle: 'demo' } as const;
      const answer = await match?.route.invoke({
        method: 'GET',
        path: '/who',
        params: {},
        query: {},
        headers: {},
        body: null,
        sender,
      });
      return JSON.parse(Buffer.from(answer?.body ?? '', 'base64').toString('utf8'));
    };
    expect(await call('user:op')).toEqual({
      sender: { principal: 'user:op', kind: 'user', bundle: 'demo' },
      operate: true,
    });
    expect((await call('user:guest')).operate).toBe(false);
  });
});
