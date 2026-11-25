import { describe, expect, it, vi } from 'vitest';
import { type HttpResponseData, type Route, RouteTable } from '../src/http/routes.js';
import { MessageBus } from '../src/messages/bus.js';
import { extensionPrincipal, TRUSTED_EXTENSION_POLICY } from '../src/permissions/authorize.js';
import {
  type ClientMessage,
  encodeMessage,
  isHttpResponse,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../src/protocol/protocol.js';
import { ReplicantRegistry } from '../src/replicant/registry.js';
import { createSession, MAX_PENDING_CALLS } from '../src/session/session.js';

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
const respond = async (): Promise<HttpResponseData> => ({ status: 200, headers: {}, body: null });
const route = (pattern: string, overrides: Partial<Route> = {}): Route => ({
  bundle: 'demo',
  method: 'GET',
  pattern,
  permission: 'bundle:demo:?',
  invoke: respond,
  ...overrides,
});

function extensionSession() {
  const clock = fakeTimers();
  const registry = new ReplicantRegistry();
  registry.declare('demo', 'score', { initial: 0 });
  const bus = new MessageBus({ timers: clock.timers });
  bus.declare('demo', 'reset', {});
  bus.declare('demo', 'tick', {});
  const routes = new RouteTable();
  const sent: ServerMessage[] = [];
  const session = createSession({
    principal: extensionPrincipal('demo'),
    policy: TRUSTED_EXTENSION_POLICY,
    registry,
    bus,
    routes,
    timers: clock.timers,
    bundleExists: () => true,
    send: (msg) => sent.push(msg),
    extension: { capabilities: ['http.routes'], permissions: [] },
  });
  const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
  receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'demo' });
  sent.length = 0;
  const sender = { principal: 'tester', kind: 'user', bundle: 'demo' } as const;
  return { session, sent, receive, registry, bus, routes, sender, ...clock };
}

describe('RouteTable matching', () => {
  it('ignores a trailing slash on the requested path', () => {
    const table = new RouteTable();
    const score = route('/score');
    const nested = route('/teams/:id');
    table.add(score);
    table.add(nested);

    expect(table.match('demo', 'GET', '/score/')?.route).toBe(score);
    expect(table.match('demo', 'GET', '/teams/7/')).toEqual({ route: nested, params: { id: '7' } });
    expect(table.match('demo', 'GET', '/score//')).toBeUndefined();
  });

  it('refuses a pattern with the same shape as a registered one', () => {
    const table = new RouteTable();
    table.add(route('/u/:id'));
    table.add(route('/u/:id/posts/:post'));

    expect(() => table.add(route('/u/:name'))).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(() => table.add(route('/u/:a/posts/:b'))).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(() => table.add(route('/u/all'))).not.toThrow();
    expect(() => table.add(route('/u/:id', { method: 'POST' }))).not.toThrow();
  });

  it('prefers more literal segments, then the route registered first', () => {
    const table = new RouteTable();
    const first = route('/:a/b/:c');
    const second = route('/a/:b/:c');
    const literal = route('/a/b/:c');
    table.add(first);
    table.add(second);
    table.add(literal);

    expect(table.match('demo', 'GET', '/a/b/c')?.route).toBe(literal);
    expect(table.match('demo', 'GET', '/a/x/c')?.route).toBe(second);
    expect(table.match('demo', 'GET', '/x/b/c')?.route).toBe(first);
    table.add(route('/:a/:b/c'));
    expect(table.match('demo', 'GET', '/x/b/c')?.route).toBe(first);
  });

  it('lists the methods registered for a path', () => {
    const table = new RouteTable();
    table.add(route('/score'));
    table.add(route('/score', { method: 'POST' }));
    table.add(route('/other', { method: 'DELETE' }));

    expect(
      table
        .methods('demo', '/score/')
        .map((found) => found.method)
        .sort(),
    ).toEqual(['GET', 'POST']);
    expect(table.methods('demo', '/nope')).toEqual([]);
    expect(table.methods('other', '/score')).toEqual([]);
  });
});

describe('isHttpResponse', () => {
  const response = (overrides: object) => ({ status: 200, headers: {}, body: null, ...overrides });

  it.each([[200], [204], [404], [599]])('accepts status %i', (status) => {
    expect(isHttpResponse(response({ status }))).toBe(true);
  });

  it.each([[100], [101], [199], [600], [200.5], ['200']])('rejects status %j', (status) => {
    expect(isHttpResponse(response({ status }))).toBe(false);
  });

  it.each([
    ['a line break in a value', { 'x-a': 'one\r\nx-b: two' }],
    ['a bare line feed in a value', { 'x-a': 'one\ntwo' }],
    ['a NUL in a value', { 'x-a': 'one\u0000two' }],
    ['a space in a name', { 'x a': 'one' }],
    ['a colon in a name', { 'x:a': 'one' }],
    ['an empty name', { '': 'one' }],
    ['a line break in a name', { 'x\r\na': 'one' }],
  ])('rejects headers with %s', (_label, headers) => {
    expect(isHttpResponse(response({ headers }))).toBe(false);
  });

  it('accepts ordinary headers', () => {
    const headers = { 'content-type': 'text/plain; charset=utf-8', 'X-Custom_1': 'a b\tc é' };
    expect(isHttpResponse(response({ headers }))).toBe(true);
  });
});

describe('a closed session', () => {
  it('ignores every frame, so nothing is registered without an owner', () => {
    const { session, sent, receive, registry, bus, routes } = extensionSession();
    const before = { registry: registry.stats(), bus: bus.stats(), routes: routes.count() };

    session.close();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    receive({ t: 'msg.sub', id: 2, name: 'tick' });
    receive({ t: 'msg.handle', id: 3, name: 'reset' });
    receive({ t: 'http.route', id: 4, method: 'GET', pattern: '/x' });
    receive({
      t: 'rep.op',
      id: 5,
      name: 'score',
      patches: [{ op: 'replace', path: '', value: 9 }],
    });
    session.receive('{nonsense');

    expect(sent).toEqual([]);
    expect({ registry: registry.stats(), bus: bus.stats(), routes: routes.count() }).toEqual(
      before,
    );
    expect(registry.get('demo:score')?.replicant.value).toBe(0);
    expect(session.stats()).toEqual({
      replicants: 0,
      listeners: 0,
      handlers: 0,
      routes: 0,
      calls: 0,
      streams: 0,
    });
  });
});

describe('calls to an extension', () => {
  const request = {
    method: 'GET',
    path: '/x',
    params: {},
    query: {},
    headers: {},
    sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
    body: null,
  } as const;

  it('forgets a request the moment it times out', async () => {
    const { session, receive, bus, sender, advance } = extensionSession();
    receive({ t: 'msg.handle', id: 1, name: 'reset' });

    const asking = bus.request('demo:reset', 1, sender, 50);
    await flush();
    expect(session.stats().calls).toBe(1);
    advance(50);

    await expect(asking).rejects.toMatchObject({ code: 'timeout' });
    expect(session.stats().calls).toBe(0);
  });

  it('refuses further calls as unavailable once too many are unanswered', async () => {
    const { session, receive, routes } = extensionSession();
    receive({ t: 'http.route', id: 1, method: 'GET', pattern: '/x' });
    const target = routes.match('demo', 'GET', '/x')?.route as Route;
    const open = Array.from({ length: MAX_PENDING_CALLS }, () => target.invoke(request));
    for (const call of open) call.catch(() => {});

    await expect(target.invoke(request)).rejects.toMatchObject({ code: 'unavailable' });

    expect(MAX_PENDING_CALLS).toBe(100);
    expect(session.stats().calls).toBe(MAX_PENDING_CALLS);
    session.close();
  });

  it('tells a handler when the bus gives up on a request', async () => {
    const clock = fakeTimers();
    const bus = new MessageBus({ timers: clock.timers });
    bus.declare('demo', 'reset', {});
    const abandoned = vi.fn();
    bus.handle('demo:reset', (_data, _sender, onAbandon) => {
      onAbandon(abandoned);
      return new Promise(() => {});
    });

    const asking = bus.request(
      'demo:reset',
      1,
      { principal: 'p', kind: 'user', bundle: 'demo' },
      10,
    );
    await flush();
    expect(abandoned).not.toHaveBeenCalled();
    clock.advance(10);

    await expect(asking).rejects.toMatchObject({ code: 'timeout' });
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it('does not tell the handler of a request it answered', async () => {
    const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
    bus.declare('demo', 'reset', {});
    const abandoned = vi.fn();
    bus.handle('demo:reset', async (_data, _sender, onAbandon) => {
      onAbandon(abandoned);
      return 1;
    });

    await bus.request('demo:reset', 1, { principal: 'p', kind: 'user', bundle: 'demo' });

    expect(abandoned).not.toHaveBeenCalled();
  });
});
