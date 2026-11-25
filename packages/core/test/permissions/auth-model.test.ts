import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../src/messages/bus.js';
import {
  ANONYMOUS_PRINCIPAL,
  ANY_BUNDLE_PERMISSION,
  authorize,
  BUNDLES_MANAGE,
  bundlePermission,
  DASHBOARD_VIEW,
  effectiveGrants,
  extensionPrincipal,
  isGrantPattern,
  LOGS_VIEW,
  type Policy,
  type Principal,
  SETTINGS_MANAGE,
  TOKENS_MANAGE,
  TRUSTED_EXTENSION_POLICY,
  USERS_MANAGE,
} from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import { createSession, type SessionOptions } from '../../src/session/session.js';

const policy: Policy = {
  roles: {
    admin: ['*'],
    operator: ['system:dashboard.view', 'bundle:scoreboard:view', 'bundle:scoreboard:operate'],
    viewer: ['bundle:*:view'],
    sysop: ['system:bundles.manage'],
  },
};
const as = (...roles: string[]): Principal => ({ id: 'user:u1', kind: 'user', roles });

describe('system permissions', () => {
  it('names every system permission', () => {
    expect([
      DASHBOARD_VIEW,
      BUNDLES_MANAGE,
      USERS_MANAGE,
      TOKENS_MANAGE,
      SETTINGS_MANAGE,
      LOGS_VIEW,
    ]).toEqual([
      'system:dashboard.view',
      'system:bundles.manage',
      'system:users.manage',
      'system:tokens.manage',
      'system:settings.manage',
      'system:logs.view',
    ]);
  });

  it('has an anonymous principal that holds nothing', () => {
    expect(ANONYMOUS_PRINCIPAL).toEqual({ id: 'anonymous', kind: 'anonymous', roles: [] });
    expect(authorize(ANONYMOUS_PRINCIPAL, DASHBOARD_VIEW, policy)).toBe(false);
    expect(authorize(ANONYMOUS_PRINCIPAL, bundlePermission('scoreboard', undefined), policy)).toBe(
      false,
    );
  });
});

describe('a bundle resource without a declared permission', () => {
  const implicit = bundlePermission('scoreboard', undefined);

  it('maps to "any permission of that bundle"', () => {
    expect(implicit).toBe(`bundle:scoreboard:${ANY_BUNDLE_PERMISSION}`);
  });

  it('is open to whoever holds at least one permission of the bundle', () => {
    expect(authorize(as('operator'), implicit, policy)).toBe(true);
    expect(authorize(as('viewer'), implicit, policy)).toBe(true);
    expect(authorize(as('admin'), implicit, policy)).toBe(true);
  });

  it('is closed to whoever holds none, including holders of system permissions', () => {
    expect(authorize(as('sysop'), implicit, policy)).toBe(false);
    expect(authorize(as(), implicit, policy)).toBe(false);
    expect(authorize(as('operator'), bundlePermission('timer', undefined), policy)).toBe(false);
  });

  it('cannot be granted itself', () => {
    expect(isGrantPattern(implicit)).toBe(false);
    const odd: Policy = { roles: { odd: [implicit] } };
    expect(authorize({ id: 'x', roles: ['odd'] }, implicit, odd)).toBe(false);
  });
});

describe('isGrantPattern', () => {
  it('accepts permissions and wildcards', () => {
    for (const grant of [
      '*',
      'system:users.manage',
      'bundle:scoreboard:operate',
      'bundle:*:view',
      'bundle:scoreboard:*',
    ]) {
      expect(isGrantPattern(grant), grant).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const grant of [
      '',
      'system',
      'bundle:x',
      'bundle:x:y:z',
      'other:x',
      'bundle:x:?',
      'a b',
    ]) {
      expect(isGrantPattern(grant), grant).toBe(false);
    }
  });
});

describe('a principal limited to its own grants (an API token)', () => {
  const token = (roles: string[], only: string[]): Principal => ({
    id: 'token:t1',
    kind: 'token',
    roles,
    only,
  });

  it('holds a permission only if its creator and the token both do', () => {
    const limited = token(['operator'], ['bundle:scoreboard:view']);
    expect(authorize(limited, 'bundle:scoreboard:view', policy)).toBe(true);
    expect(authorize(limited, 'bundle:scoreboard:operate', policy)).toBe(false);
    expect(authorize(limited, DASHBOARD_VIEW, policy)).toBe(false);
  });

  it('loses what its creator no longer holds', () => {
    const stale = token(['viewer'], ['bundle:scoreboard:operate', 'bundle:scoreboard:view']);
    expect(authorize(stale, 'bundle:scoreboard:operate', policy)).toBe(false);
    expect(authorize(stale, 'bundle:scoreboard:view', policy)).toBe(true);
  });

  it('reaches an undeclared bundle resource only through a permission both sides hold', () => {
    const implicit = bundlePermission('scoreboard', undefined);
    expect(authorize(token(['operator'], ['bundle:scoreboard:view']), implicit, policy)).toBe(true);
    expect(authorize(token(['viewer'], ['bundle:scoreboard:operate']), implicit, policy)).toBe(
      false,
    );
    expect(authorize(token(['admin'], ['bundle:timer:view']), implicit, policy)).toBe(false);
    expect(authorize(token(['viewer'], ['*']), implicit, policy)).toBe(true);
  });

  it('lists what a principal effectively holds, for comparing two moments', () => {
    expect(effectiveGrants(as('operator', 'sysop'), policy)).toEqual({
      grants: [
        'bundle:scoreboard:operate',
        'bundle:scoreboard:view',
        'system:bundles.manage',
        'system:dashboard.view',
      ],
    });
    expect(effectiveGrants(token(['viewer'], ['bundle:b:view', 'bundle:a:view']), policy)).toEqual({
      grants: ['bundle:*:view'],
      only: ['bundle:a:view', 'bundle:b:view'],
    });
  });
});

describe('the protocol', () => {
  it('has a version', () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });

  it('carries the kind of principal in a sender', () => {
    const msg: ServerMessage = {
      t: 'msg',
      name: 'scoreboard:reset',
      data: null,
      sender: { principal: 'user:u1', kind: 'user', bundle: 'scoreboard' },
    };
    expect(decodeServerMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
  });

  it('refuses a sender without a known kind', () => {
    const bad = { t: 'msg', name: 'a:b', data: null, sender: { principal: 'x', bundle: 'a' } };
    expect(decodeServerMessage(JSON.stringify(bad)).ok).toBe(false);
    const odd = { ...bad, sender: { principal: 'x', bundle: 'a', kind: 'robot' } };
    expect(decodeServerMessage(JSON.stringify(odd)).ok).toBe(false);
  });

  it('decodes a permission check and its answer', () => {
    const check: ClientMessage = {
      t: 'perm.check',
      id: 3,
      principal: 'user:u1',
      permission: 'operate',
    };
    expect(decodeClientMessage(encodeMessage(check))).toEqual({ ok: true, msg: check });
    expect(decodeClientMessage(JSON.stringify({ ...check, permission: 7 })).ok).toBe(false);
    const answer: ServerMessage = { t: 'perm.res', id: 3, allowed: true };
    expect(decodeServerMessage(encodeMessage(answer))).toEqual({ ok: true, msg: answer });
    expect(decodeServerMessage(JSON.stringify({ ...answer, allowed: 'yes' })).ok).toBe(false);
  });
});

describe('a session', () => {
  function connect(options: Partial<SessionOptions> = {}) {
    const registry = new ReplicantRegistry();
    const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
    bus.declare('scoreboard', 'reset', {});
    const sent: ServerMessage[] = [];
    const session = createSession({
      principal: as('admin'),
      policy,
      registry,
      bus,
      bundleExists: () => true,
      send: (msg) => sent.push(msg),
      ...options,
    });
    const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' });
    sent.length = 0;
    return { sent, receive, bus };
  }

  it('names the kind of principal that sent a message', () => {
    const { receive, bus } = connect({
      principal: { id: 'token:t1', kind: 'token', roles: ['admin'] },
    });
    const seen: unknown[] = [];
    bus.subscribe('scoreboard:reset', (_data, sender) => seen.push(sender));
    receive({ t: 'msg.send', id: 1, name: 'reset', data: null });
    expect(seen).toEqual([{ principal: 'token:t1', kind: 'token', bundle: 'scoreboard' }]);
  });

  it('treats a principal without a kind as a user and an extension as an extension', () => {
    const plain = connect({ principal: { id: 'local', roles: ['admin'] } });
    const seen: unknown[] = [];
    plain.bus.subscribe('scoreboard:reset', (_data, sender) => seen.push(sender));
    plain.receive({ t: 'msg.send', id: 1, name: 'reset', data: null });
    expect(extensionPrincipal('scoreboard').kind).toBe('extension');
    expect(seen).toEqual([{ principal: 'local', kind: 'user', bundle: 'scoreboard' }]);
  });

  const extension = (checkPermission?: SessionOptions['checkPermission']) =>
    connect({
      principal: extensionPrincipal('scoreboard'),
      policy: TRUSTED_EXTENSION_POLICY,
      extension: { capabilities: [], permissions: ['view', 'operate'] },
      checkPermission,
    });

  it('answers an extension whether a principal holds a permission of its bundle', () => {
    const asked: string[] = [];
    const { sent, receive } = extension((principal, permission) => {
      asked.push(`${principal} ${permission}`);
      return principal === 'user:op';
    });
    receive({ t: 'perm.check', id: 1, principal: 'user:op', permission: 'operate' });
    receive({ t: 'perm.check', id: 2, principal: 'user:guest', permission: 'operate' });
    expect(sent).toEqual([
      { t: 'perm.res', id: 1, allowed: true },
      { t: 'perm.res', id: 2, allowed: false },
    ]);
    expect(asked).toEqual([
      'user:op bundle:scoreboard:operate',
      'user:guest bundle:scoreboard:operate',
    ]);
  });

  it('denies every check when the server offers no way to look principals up', () => {
    const { sent, receive } = extension();
    receive({ t: 'perm.check', id: 1, principal: 'user:op', permission: 'operate' });
    expect(sent).toEqual([{ t: 'perm.res', id: 1, allowed: false }]);
  });

  it('refuses a check for a permission the bundle does not declare', () => {
    const { sent, receive } = extension(() => true);
    receive({ t: 'perm.check', id: 1, principal: 'user:op', permission: 'delete' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'bad_request' }]);
  });

  it('refuses a check from anything but an extension', () => {
    const { sent, receive } = connect({ checkPermission: () => true });
    receive({ t: 'perm.check', id: 1, principal: 'user:op', permission: 'operate' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'forbidden' }]);
  });
});
