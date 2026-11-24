import { describe, expect, it, vi } from 'vitest';
import { RouteTable } from '../../src/http/routes.js';
import { MessageBus } from '../../src/messages/bus.js';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  extensionPrincipal,
  type Policy,
  type Principal,
  TRUSTED_EXTENSION_POLICY,
} from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import {
  createSession,
  DEFAULT_HTTP_TIMEOUT_MS,
  type SessionOptions,
} from '../../src/session/session.js';

function fakeTimers() {
  let now = 0;
  let tasks: { at: number; run: () => void }[] = [];
  return {
    timers: {
      setTimeout(run: () => void, ms: number) {
        const task = { at: now + ms, run };
        tasks.push(task);
        return task;
      },
      clearTimeout(handle: unknown) {
        tasks = tasks.filter((task) => task !== handle);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const task of tasks.filter((candidate) => candidate.at <= now)) {
        tasks = tasks.filter((candidate) => candidate !== task);
        task.run();
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const clock = fakeTimers();
  const registry = new ReplicantRegistry();
  registry.declare('scoreboard', 'score', { initial: { n: 0 } });
  registry.declare('team-data', 'teams', { initial: ['red'] });
  registry.declare('system', 'bundles', {
    initial: [],
    readPermission: 'system:dashboard.view',
    readOnly: true,
  });
  const bus = new MessageBus({ timers: clock.timers });
  bus.declare('scoreboard', 'reset', { send: 'operate', listen: 'view' });
  bus.declare('scoreboard', 'tick', {});
  bus.declare('team-data', 'changed', {});
  const routes = new RouteTable();

  const connect = (
    overrides: Partial<SessionOptions> & { bundle?: string; principal?: Principal } = {},
  ) => {
    const sent: ServerMessage[] = [];
    const { bundle = 'scoreboard', ...options } = overrides;
    const session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bus,
      routes,
      timers: clock.timers,
      bundleExists: () => true,
      send: (msg) => sent.push(msg),
      ...options,
    });
    const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle });
    sent.length = 0;
    return { session, sent, receive };
  };
  /** The session of a bundle's extension, as the extension host creates it. */
  const extension = (bundle = 'scoreboard', capabilities: string[] = [], permissions = ['view']) =>
    connect({
      bundle,
      principal: extensionPrincipal(bundle),
      policy: TRUSTED_EXTENSION_POLICY,
      extension: { capabilities, permissions },
    });
  return { registry, bus, routes, connect, extension, ...clock };
}

const viewer: Principal = { id: 'viewer', roles: ['viewer'] };
const viewerPolicy: Policy = { roles: { viewer: ['bundle:scoreboard:view'] } };

describe('messages over a session', () => {
  it('delivers a sent message to subscribers of that topic only, with the sender', () => {
    const { connect } = setup();
    const listener = connect();
    const other = connect();
    const writer = connect({ principal: { id: 'op', roles: ['admin'] } });
    listener.receive({ t: 'msg.sub', id: 1, name: 'reset' });
    other.receive({ t: 'msg.sub', id: 1, name: 'tick' });
    listener.sent.length = 0;
    other.sent.length = 0;

    writer.receive({ t: 'msg.send', id: 2, name: 'reset', data: { hard: true } });

    expect(writer.sent).toEqual([{ t: 'ok', id: 2 }]);
    expect(listener.sent).toEqual([
      {
        t: 'msg',
        name: 'scoreboard:reset',
        data: { hard: true },
        sender: { principal: 'op', kind: 'user', bundle: 'scoreboard' },
      },
    ]);
    expect(other.sent).toEqual([]);
  });

  it('acknowledges subscribing, is idempotent, and stops after unsubscribing', () => {
    const { connect } = setup();
    const { sent, receive } = connect();

    receive({ t: 'msg.sub', id: 1, name: 'tick' });
    receive({ t: 'msg.sub', id: 2, name: 'scoreboard:tick' });
    receive({ t: 'msg.send', id: 3, name: 'tick', data: 1 });
    receive({ t: 'msg.unsub', id: 4, name: 'tick' });
    receive({ t: 'msg.send', id: 5, name: 'tick', data: 2 });

    expect(sent.map((msg) => msg.t)).toEqual(['ok', 'ok', 'msg', 'ok', 'ok', 'ok']);
  });

  it('checks the listen and send permissions of the topic', () => {
    const { connect } = setup();
    const { sent, receive } = connect({ principal: viewer, policy: viewerPolicy });

    receive({ t: 'msg.sub', id: 1, name: 'reset' });
    receive({ t: 'msg.send', id: 2, name: 'reset', data: null });
    receive({ t: 'msg.req', id: 3, name: 'reset', data: null });
    receive({ t: 'msg.sub', id: 4, name: 'tick' });

    expect(sent).toMatchObject([
      { t: 'ok', id: 1 },
      { t: 'err', id: 2, code: 'forbidden' },
      { t: 'err', id: 3, code: 'forbidden' },
      // A topic without a mapped permission is open to whoever holds any permission of the bundle.
      { t: 'ok', id: 4 },
    ]);
  });

  it('answers not_found for an undeclared topic', () => {
    const { connect } = setup();
    const { sent, receive } = connect();
    receive({ t: 'msg.sub', id: 1, name: 'nope' });
    receive({ t: 'msg.send', id: 2, name: 'nope', data: 1 });
    expect(sent).toMatchObject([
      { t: 'err', id: 1, code: 'not_found' },
      { t: 'err', id: 2, code: 'not_found' },
    ]);
  });

  it('tells a subscriber when the topic is removed, and drops its listeners on close', () => {
    const { bus, connect } = setup();
    const kept = connect();
    const closed = connect();
    kept.receive({ t: 'msg.sub', id: 1, name: 'tick' });
    closed.receive({ t: 'msg.sub', id: 1, name: 'tick' });
    kept.sent.length = 0;
    closed.sent.length = 0;

    closed.session.close();
    bus.undeclare('scoreboard');

    expect(kept.sent).toEqual([
      { t: 'msg.gone', name: 'scoreboard:tick', message: expect.any(String) },
    ]);
    expect(closed.sent).toEqual([]);
  });
});

describe('requests over a session', () => {
  it('lets an extension handle requests and returns its answer to the asker', async () => {
    const { connect, extension } = setup();
    const handler = extension();
    const asker = connect({ principal: { id: 'op', roles: ['admin'] } });
    handler.receive({ t: 'msg.handle', id: 1, name: 'reset' });
    expect(handler.sent).toEqual([{ t: 'ok', id: 1 }]);

    asker.receive({ t: 'msg.req', id: 7, name: 'reset', data: { to: 0 } });
    await flush();
    const call = handler.sent.at(-1) as Extract<ServerMessage, { t: 'msg.call' }>;
    expect(call).toMatchObject({
      t: 'msg.call',
      name: 'scoreboard:reset',
      data: { to: 0 },
      sender: { principal: 'op', kind: 'user', bundle: 'scoreboard' },
    });
    handler.receive({ t: 'call.ok', call: call.call, data: 'done' });
    await flush();

    expect(asker.sent).toEqual([{ t: 'msg.res', id: 7, data: 'done' }]);
  });

  it('passes the handler error on, and reports a missing handler', async () => {
    const { connect, extension } = setup();
    const asker = connect();
    asker.receive({ t: 'msg.req', id: 1, name: 'reset', data: null });
    await flush();
    const handler = extension();
    handler.receive({ t: 'msg.handle', id: 1, name: 'reset' });
    asker.receive({ t: 'msg.req', id: 2, name: 'reset', data: null });
    await flush();
    const call = handler.sent.at(-1) as Extract<ServerMessage, { t: 'msg.call' }>;
    handler.receive({ t: 'call.err', call: call.call, code: 'invalid', message: 'bad score' });
    await flush();

    expect(asker.sent).toMatchObject([
      { t: 'err', id: 1, code: 'not_found' },
      { t: 'err', id: 2, code: 'invalid', message: 'bad score' },
    ]);
  });

  it('times out, and fails as unavailable when the handling session closes', async () => {
    const { connect, extension, advance } = setup();
    const handler = extension();
    const asker = connect();
    handler.receive({ t: 'msg.handle', id: 1, name: 'reset' });

    asker.receive({ t: 'msg.req', id: 1, name: 'reset', data: null, timeout: 50 });
    asker.receive({ t: 'msg.req', id: 2, name: 'reset', data: null });
    await flush();
    advance(50);
    await flush();
    handler.session.close();
    await flush();

    expect(asker.sent).toMatchObject([
      { t: 'err', id: 1, code: 'timeout' },
      { t: 'err', id: 2, code: 'unavailable' },
    ]);
  });

  it('only lets extensions handle, and only topics of their own bundle', () => {
    const { connect, extension } = setup();
    const browser = connect();
    const foreign = extension('team-data', ['bundle:scoreboard:write']);

    browser.receive({ t: 'msg.handle', id: 1, name: 'reset' });
    foreign.receive({ t: 'msg.handle', id: 1, name: 'scoreboard:reset' });
    browser.receive({ t: 'call.ok', call: 1, data: 1 });

    expect(browser.sent).toMatchObject([
      { t: 'err', id: 1, code: 'forbidden' },
      { t: 'err', code: 'forbidden' },
    ]);
    expect(foreign.sent).toMatchObject([{ t: 'err', id: 1, code: 'forbidden' }]);
  });

  it('stops handling on msg.unhandle', async () => {
    const { connect, extension } = setup();
    const handler = extension();
    const asker = connect();
    handler.receive({ t: 'msg.handle', id: 1, name: 'reset' });
    handler.receive({ t: 'msg.unhandle', id: 2, name: 'reset' });

    asker.receive({ t: 'msg.req', id: 1, name: 'reset', data: null });
    await flush();

    expect(handler.sent).toEqual([
      { t: 'ok', id: 1 },
      { t: 'ok', id: 2 },
    ]);
    expect(asker.sent).toMatchObject([{ t: 'err', id: 1, code: 'not_found' }]);
  });
});

describe('extension capabilities', () => {
  it('needs no capability inside its own bundle', () => {
    const { extension } = setup();
    const { sent, receive } = extension();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    receive({
      t: 'rep.op',
      id: 2,
      name: 'score',
      patches: [{ op: 'replace', path: '/n', value: 1 }],
    });
    receive({ t: 'msg.sub', id: 3, name: 'tick' });
    receive({ t: 'msg.send', id: 4, name: 'tick', data: 1 });
    expect(sent.filter((msg) => msg.t === 'err')).toEqual([]);
  });

  it('refuses another bundle without the matching capability', () => {
    const { extension } = setup();
    const { sent, receive } = extension('scoreboard', ['bundle:team-data:read']);

    receive({ t: 'rep.sub', id: 1, name: 'team-data:teams' });
    receive({ t: 'msg.sub', id: 2, name: 'team-data:changed' });
    receive({ t: 'rep.op', id: 3, name: 'team-data:teams', patches: [] });
    receive({ t: 'msg.send', id: 4, name: 'team-data:changed', data: 1 });
    receive({ t: 'msg.req', id: 5, name: 'team-data:changed', data: 1 });

    expect(sent).toMatchObject([
      { t: 'rep.snap', id: 1 },
      { t: 'ok', id: 2 },
      {
        t: 'err',
        id: 3,
        code: 'forbidden',
        message: expect.stringContaining('bundle:team-data:write'),
      },
      { t: 'err', id: 4, code: 'forbidden' },
      { t: 'err', id: 5, code: 'forbidden' },
    ]);
  });

  it('refuses reading another bundle without the read capability', () => {
    const { extension } = setup();
    const { sent, receive } = extension('scoreboard', ['bundle:team-data:write']);
    receive({ t: 'rep.sub', id: 1, name: 'team-data:teams' });
    receive({ t: 'msg.sub', id: 2, name: 'team-data:changed' });
    receive({ t: 'msg.send', id: 3, name: 'team-data:changed', data: 1 });
    expect(sent).toMatchObject([
      {
        t: 'err',
        id: 1,
        code: 'forbidden',
        message: expect.stringContaining('bundle:team-data:read'),
      },
      { t: 'err', id: 2, code: 'forbidden' },
      { t: 'ok', id: 3 },
    ]);
  });

  it('does not restrict clients that are not extensions', () => {
    const { connect } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'team-data:teams' });
    expect(sent).toMatchObject([{ t: 'rep.snap', id: 1 }]);
  });
});

describe('read-only replicants', () => {
  it('can be read with their own permission but never written, whatever the grants', () => {
    const { connect } = setup();
    const { sent, receive } = connect({ bundle: 'system' });

    receive({ t: 'rep.sub', id: 1, name: 'bundles' });
    receive({
      t: 'rep.op',
      id: 2,
      name: 'bundles',
      patches: [{ op: 'replace', path: '', value: 1 }],
    });

    expect(sent).toMatchObject([
      { t: 'rep.snap', id: 1, name: 'system:bundles' },
      { t: 'err', id: 2, code: 'forbidden', message: expect.stringContaining('read-only') },
    ]);
  });

  it('requires the declared read permission', () => {
    const { connect } = setup();
    const { sent, receive } = connect({
      bundle: 'system',
      principal: viewer,
      policy: viewerPolicy,
    });
    receive({ t: 'rep.sub', id: 1, name: 'bundles' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'forbidden' }]);
  });
});

describe('HTTP routes over a session', () => {
  const request = {
    method: 'GET',
    path: '/teams/7',
    params: { id: '7' },
    query: {},
    headers: {},
    sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
    body: null,
  } as const;

  it('registers a route for the own bundle and forwards calls to the extension', async () => {
    const { routes, extension } = setup();
    const { sent, receive } = extension('scoreboard', ['http.routes']);

    receive({ t: 'http.route', id: 4, method: 'GET', pattern: '/teams/:id', permission: 'view' });
    const match = routes.match('scoreboard', 'GET', '/teams/7');
    expect(sent).toEqual([{ t: 'ok', id: 4 }]);
    expect(match?.route.permission).toBe('bundle:scoreboard:view');

    const response = match?.route.invoke(request);
    const call = sent.at(-1) as Extract<ServerMessage, { t: 'http.call' }>;
    expect(call).toMatchObject({ t: 'http.call', route: 4, request });
    receive({
      t: 'call.ok',
      call: call.call,
      data: { status: 201, headers: { a: 'b' }, body: 'eA==' },
    });

    await expect(response).resolves.toEqual({ status: 201, headers: { a: 'b' }, body: 'eA==' });
  });

  it('uses the implicit bundle permission without a per-route one', () => {
    const { routes, extension } = setup();
    extension('scoreboard', ['http.routes']).receive({
      t: 'http.route',
      id: 1,
      method: 'POST',
      pattern: '/',
    });
    expect(routes.match('scoreboard', 'POST', '/')?.route.permission).toBe('bundle:scoreboard:?');
  });

  it.each([
    ['a browser client', undefined, 'view', 'forbidden'],
    ['an extension without the http.routes capability', [], 'view', 'forbidden'],
    ['a permission the bundle does not declare', ['http.routes'], 'operate', 'bad_request'],
  ] as const)('refuses a route from %s', (_label, capabilities, permission, code) => {
    const { routes, connect, extension } = setup();
    const { sent, receive } = capabilities ? extension('scoreboard', [...capabilities]) : connect();

    receive({ t: 'http.route', id: 1, method: 'GET', pattern: '/x', permission });

    expect(sent).toMatchObject([{ t: 'err', id: 1, code }]);
    expect(routes.count()).toBe(0);
  });

  it('refuses the same route twice with conflict', () => {
    const { extension } = setup();
    const { sent, receive } = extension('scoreboard', ['http.routes']);
    receive({ t: 'http.route', id: 1, method: 'GET', pattern: '/x' });
    receive({ t: 'http.route', id: 2, method: 'GET', pattern: '/x' });
    expect(sent).toMatchObject([
      { t: 'ok', id: 1 },
      { t: 'err', id: 2, code: 'conflict' },
    ]);
  });

  it('rejects a call with the handler error, a malformed answer, or a timeout', async () => {
    const { routes, extension, advance } = setup();
    const { sent, receive } = extension('scoreboard', ['http.routes']);
    receive({ t: 'http.route', id: 1, method: 'GET', pattern: '/teams/:id' });
    const route = routes.match('scoreboard', 'GET', '/teams/7')?.route;
    const callId = () => (sent.at(-1) as Extract<ServerMessage, { t: 'http.call' }>).call;

    const failed = route?.invoke(request);
    receive({ t: 'call.err', call: callId(), code: 'internal', message: 'boom' });
    const malformed = route?.invoke(request);
    receive({ t: 'call.ok', call: callId(), data: { status: 'fine' } });
    const silent = route?.invoke(request);
    advance(DEFAULT_HTTP_TIMEOUT_MS);

    await expect(failed).rejects.toMatchObject({ code: 'internal' });
    await expect(malformed).rejects.toMatchObject({ code: 'internal' });
    await expect(silent).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('the session as a resource ledger', () => {
  it('counts what a connection registered and releases all of it on close', async () => {
    const { routes, bus, extension, connect } = setup();
    const { session, receive } = extension('scoreboard', ['http.routes']);
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    receive({ t: 'msg.sub', id: 2, name: 'tick' });
    receive({ t: 'msg.sub', id: 3, name: 'reset' });
    receive({ t: 'msg.handle', id: 4, name: 'reset' });
    receive({ t: 'http.route', id: 5, method: 'GET', pattern: '/a' });
    receive({ t: 'http.route', id: 6, method: 'GET', pattern: '/b' });
    const open = routes.match('scoreboard', 'GET', '/a')?.route.invoke({
      method: 'GET',
      path: '/a',
      params: {},
      query: {},
      headers: {},
      sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
      body: null,
    });
    const rejected = vi.fn();
    open?.catch(rejected);

    expect(session.stats()).toEqual({
      replicants: 1,
      listeners: 2,
      handlers: 1,
      routes: 2,
      calls: 1,
    });

    session.close();
    await flush();

    expect(session.stats()).toEqual({
      replicants: 0,
      listeners: 0,
      handlers: 0,
      routes: 0,
      calls: 0,
    });
    expect(routes.count()).toBe(0);
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'unavailable' }));
    const asker = connect();
    asker.receive({ t: 'msg.req', id: 1, name: 'reset', data: null });
    await flush();
    expect(asker.sent).toMatchObject([{ t: 'err', id: 1, code: 'not_found' }]);
    expect(() => bus.handle('scoreboard:reset', async () => 1)).not.toThrow();
  });

  it('answers messages with bad_request when the server has no message bus', () => {
    const registry = new ReplicantRegistry();
    const sent: ServerMessage[] = [];
    const session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bundleExists: () => true,
      send: (msg) => sent.push(msg),
    });
    session.receive(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' }));
    session.receive(encodeMessage({ t: 'msg.sub', id: 1, name: 'tick' }));
    expect(sent.at(-1)).toMatchObject({ t: 'err', id: 1, code: 'bad_request' });
  });
});
