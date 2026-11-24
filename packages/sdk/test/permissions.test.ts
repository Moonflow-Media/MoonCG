import {
  createSession,
  extensionPrincipal,
  MessageBus,
  ReplicantRegistry,
  type Sender,
  TRUSTED_EXTENSION_POLICY,
} from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import { createConnection } from '../src/client/client.js';
import { createBundleContext, createLoopback } from '../src/extension/index.js';

/** An extension context on a real session whose server knows who holds what. */
function setup(holders: Record<string, string[]>) {
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  bus.declare('demo', 'reset', {});
  const loopback = createLoopback();
  const session = createSession({
    principal: extensionPrincipal('demo'),
    policy: TRUSTED_EXTENSION_POLICY,
    registry: new ReplicantRegistry(),
    bus,
    timers: { setTimeout, clearTimeout },
    bundleExists: () => true,
    send: (msg) => loopback.server.send(JSON.stringify(msg)),
    extension: { capabilities: [], permissions: ['view', 'operate'] },
    checkPermission: (principal, permission) => holders[principal]?.includes(permission) ?? false,
  });
  loopback.server.onFrame((frame) => session.receive(frame));
  loopback.server.onClose(() => session.close());
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
  return { context, bus };
}

const sender = (principal: string): Sender => ({ principal, kind: 'user', bundle: 'demo' });

describe('ctx.permissions.check', () => {
  it('tells whether a sender holds a permission of the bundle', async () => {
    const { context } = setup({ 'user:op': ['bundle:demo:operate'] });
    await expect(context.permissions.check(sender('user:op'), 'operate')).resolves.toBe(true);
    await expect(context.permissions.check(sender('user:op'), 'view')).resolves.toBe(false);
    await expect(context.permissions.check(sender('user:guest'), 'operate')).resolves.toBe(false);
  });

  it('rejects for a permission the manifest does not declare', async () => {
    const { context } = setup({});
    await expect(context.permissions.check(sender('user:op'), 'delete')).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('works inside a request handler, with the sender it was given', async () => {
    const { context, bus } = setup({ 'user:op': ['bundle:demo:operate'] });
    await context.handle('reset', async (_data, { sender: from }) => ({
      kind: from.kind,
      allowed: await context.permissions.check(from, 'operate'),
    }));
    await expect(bus.request('demo:reset', null, sender('user:op'))).resolves.toEqual({
      kind: 'user',
      allowed: true,
    });
    await expect(bus.request('demo:reset', null, sender('user:guest'))).resolves.toEqual({
      kind: 'user',
      allowed: false,
    });
  });
});
