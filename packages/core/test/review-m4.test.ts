import { describe, expect, it } from 'vitest';
import { MessageBus } from '../src/messages/bus.js';
import type { Policy, Principal } from '../src/permissions/authorize.js';
import {
  type ClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../src/protocol/protocol.js';
import { ReplicantRegistry } from '../src/replicant/registry.js';
import { createSession } from '../src/session/session.js';

const policy: Policy = {
  roles: {
    board: ['bundle:board:view'],
    dashboard: ['system:dashboard.view'],
  },
};

function connect(principal: Principal, exists: (bundle: string) => boolean = () => true) {
  const registry = new ReplicantRegistry();
  registry.declare('board', 'score', { initial: 0, readPermission: 'bundle:board:view' });
  registry.declare('board', 'secret', { initial: 0, readPermission: 'bundle:board:operate' });
  registry.declare('other', 'data', { initial: 0, readPermission: 'bundle:other:view' });
  registry.declare('system', 'bundles', {
    initial: [],
    readPermission: 'system:bundles.manage',
    readOnly: true,
  });
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  bus.declare('other', 'ping', { send: 'view', listen: 'view' });
  const sent: ServerMessage[] = [];
  const session = createSession({
    principal,
    policy,
    registry,
    bus,
    bundleExists: exists,
    send: (msg) => sent.push(msg),
  });
  const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
  return { sent, receive };
}

const viewer: Principal = { id: 'user:v', kind: 'user', roles: ['board', 'dashboard'] };

describe('a bundle the principal holds nothing of', () => {
  it('looks exactly like a bundle that does not exist', () => {
    const { sent, receive } = connect(viewer);
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'board' });
    receive({ t: 'rep.sub', id: 1, name: 'other:data' });
    receive({ t: 'rep.sub', id: 2, name: 'nowhere:data' });
    receive({ t: 'rep.op', id: 3, name: 'other:data', patches: [] });
    receive({ t: 'msg.sub', id: 4, name: 'other:ping' });
    receive({ t: 'msg.send', id: 5, name: 'other:ping', data: null });
    receive({ t: 'msg.sub', id: 6, name: 'nowhere:ping' });
    expect(sent.slice(1)).toEqual([
      { t: 'err', id: 1, code: 'not_found', message: 'Replicant "other:data" is not declared' },
      { t: 'err', id: 2, code: 'not_found', message: 'Replicant "nowhere:data" is not declared' },
      { t: 'err', id: 3, code: 'not_found', message: 'Replicant "other:data" is not declared' },
      { t: 'err', id: 4, code: 'not_found', message: 'Message "other:ping" is not declared' },
      { t: 'err', id: 5, code: 'not_found', message: 'Message "other:ping" is not declared' },
      { t: 'err', id: 6, code: 'not_found', message: 'Message "nowhere:ping" is not declared' },
    ]);
  });

  it('still answers forbidden where the principal sees the bundle but lacks the permission', () => {
    const { sent, receive } = connect(viewer);
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'board' });
    receive({ t: 'rep.sub', id: 1, name: 'secret' });
    receive({ t: 'rep.sub', id: 2, name: 'system:bundles' });
    expect(sent.slice(1)).toMatchObject([
      { t: 'err', id: 1, code: 'forbidden' },
      { t: 'err', id: 2, code: 'forbidden' },
    ]);
  });

  it('refuses hello like for a bundle that is not running', () => {
    const hidden = connect(viewer);
    hidden.receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'other' });
    const missing = connect(viewer, (bundle) => bundle !== 'nowhere');
    missing.receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'nowhere' });
    expect(hidden.sent).toEqual([
      { t: 'err', code: 'not_found', message: 'Bundle "other" is not running' },
    ]);
    expect(missing.sent).toEqual([
      { t: 'err', code: 'not_found', message: 'Bundle "nowhere" is not running' },
    ]);
    // The server's own namespace is entered with a system permission, not a bundle's.
    const system = connect(viewer);
    system.receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'system' });
    expect(system.sent).toEqual([{ t: 'welcome', v: PROTOCOL_VERSION }]);
  });
});

describe('an HTTP call to an extension', () => {
  const request = {
    method: 'GET',
    path: '/x',
    params: {},
    query: {},
    headers: {},
    body: null,
  };

  it('carries who is calling', () => {
    const msg = {
      t: 'http.call',
      call: 1,
      route: 2,
      request: { ...request, sender: { principal: 'user:u1', kind: 'user', bundle: 'board' } },
    };
    expect(decodeServerMessage(JSON.stringify(msg))).toEqual({ ok: true, msg });
  });

  it('is refused without a sender', () => {
    const msg = { t: 'http.call', call: 1, route: 2, request };
    expect(decodeServerMessage(JSON.stringify(msg)).ok).toBe(false);
  });
});
