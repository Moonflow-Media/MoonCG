import type { HttpRequestData } from '@mooncg/core';
import { MoonCGError } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from '../src/client/client.js';
import { FakeSocket, setup, tick } from './fake-socket.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function connected() {
  const context = setup();
  context.socket().welcome();
  return context;
}

/** A connection with the extension-only parts, on a fake socket. */
function extensionConnection() {
  const sockets: FakeSocket[] = [];
  const errors: unknown[] = [];
  const connection = createConnection({
    bundle: 'scoreboard',
    url: 'ws://test/ws',
    reconnectDelayMs: 0,
    onError: (_message, error) => errors.push(error),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const socket = () => sockets.at(-1) as FakeSocket;
  socket().welcome();
  return { connection, socket, errors };
}

const sender = { principal: 'op', kind: 'user', bundle: 'scoreboard' } as const;

describe('client.send', () => {
  it('publishes to a topic and resolves when the server confirms', async () => {
    const { client, socket } = connected();
    let done = false;

    const sending = client.send('reset', { hard: true }).then(() => {
      done = true;
    });
    await tick();
    const msg = socket().last('msg.send');
    expect(msg).toMatchObject({ name: 'scoreboard:reset', data: { hard: true } });
    expect(done).toBe(false);
    socket().receive({ t: 'ok', id: msg.id });

    await sending;
    expect(done).toBe(true);
  });

  it('sends null when there is no data, and rejects with the server error', async () => {
    const { client, socket } = connected();
    const sending = client.send('other:reset');
    await tick();
    const msg = socket().last('msg.send');
    expect(msg).toMatchObject({ name: 'other:reset', data: null });
    socket().receive({ t: 'err', id: msg.id, code: 'forbidden', message: 'no' });

    await expect(sending).rejects.toBeInstanceOf(MoonCGError);
    await expect(sending).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('waits for the handshake', async () => {
    const { client, socket } = setup();
    const sending = client.send('reset');
    await tick();
    expect(socket().sent).toEqual([]);

    socket().welcome();
    await tick();
    socket().receive({ t: 'ok', id: socket().last('msg.send').id });

    await expect(sending).resolves.toBeUndefined();
  });
});

describe('client.on', () => {
  it('subscribes, calls the listener with data and sender, and unsubscribes', async () => {
    const { client, socket } = connected();
    const listener = vi.fn();

    const subscribing = client.on('reset', listener);
    await tick();
    const sub = socket().last('msg.sub');
    socket().receive({ t: 'ok', id: sub.id });
    const stop = await subscribing;
    socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 5, sender });
    socket().receive({ t: 'msg', name: 'scoreboard:other', data: 6, sender });

    expect(sub.name).toBe('scoreboard:reset');
    expect(listener).toHaveBeenCalledExactlyOnceWith(5, { sender });

    stop();
    await tick();
    expect(socket().last('msg.unsub').name).toBe('scoreboard:reset');
    socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 7, sender });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribes once per topic and keeps the server subscription while a listener is left', async () => {
    const { client, socket } = connected();
    const first = vi.fn();
    const second = vi.fn();
    const one = client.on('reset', first);
    await tick();
    socket().receive({ t: 'ok', id: socket().last('msg.sub').id });
    const stopFirst = await one;
    const stopSecond = await client.on('reset', second);

    stopFirst();
    await tick();
    socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 1, sender });

    expect(socket().sent.filter((msg) => msg.t === 'msg.sub')).toHaveLength(1);
    expect(socket().sent.some((msg) => msg.t === 'msg.unsub')).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    stopSecond();
  });

  it('rejects when the server refuses the subscription', async () => {
    const { client, socket } = connected();
    const subscribing = client.on('reset', () => {});
    await tick();
    socket().receive({
      t: 'err',
      id: socket().last('msg.sub').id,
      code: 'forbidden',
      message: 'no',
    });
    await expect(subscribing).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('subscribes again after a reconnect', async () => {
    const { client, socket, sockets } = connected();
    const listener = vi.fn();
    const subscribing = client.on('reset', listener);
    await tick();
    socket().receive({ t: 'ok', id: socket().last('msg.sub').id });
    await subscribing;

    socket().close();
    await tick();
    socket().welcome();
    socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 1, sender });

    expect(sockets).toHaveLength(2);
    expect(socket().last('msg.sub').name).toBe('scoreboard:reset');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('contains a throwing listener and asks again for a topic the server removed', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = connected();
    const later = vi.fn();
    const one = client.on('reset', () => {
      throw new Error('listener failure');
    });
    await tick();
    socket().receive({ t: 'ok', id: socket().last('msg.sub').id });
    await one;
    await client.on('reset', later);

    expect(() =>
      socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 1, sender }),
    ).not.toThrow();
    socket().receive({ t: 'msg.gone', name: 'scoreboard:reset', message: 'removed' });
    socket().close();
    await tick();
    socket().welcome();

    expect(later).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    // The bundle may be running again by now, so the page asks once more.
    expect(socket().sent.filter((msg) => msg.t === 'msg.sub')).toHaveLength(1);
  });
});

describe('client.request', () => {
  it('asks the handler and resolves with its answer', async () => {
    const { client, socket } = connected();
    const asking = client.request('reset', { to: 0 }, { timeout: 250 });
    await tick();
    const req = socket().last('msg.req');
    expect(req).toMatchObject({ name: 'scoreboard:reset', data: { to: 0 }, timeout: 250 });
    socket().receive({ t: 'msg.res', id: req.id, data: { ok: true } });
    await expect(asking).resolves.toEqual({ ok: true });
  });

  it('leaves the timeout to the server by default and rejects with its error', async () => {
    const { client, socket } = connected();
    const asking = client.request('reset');
    await tick();
    const req = socket().last('msg.req');
    expect(req).not.toHaveProperty('timeout');
    socket().receive({ t: 'err', id: req.id, code: 'timeout', message: 'too slow' });
    await expect(asking).rejects.toMatchObject({ code: 'timeout', message: 'too slow' });
  });

  it('rejects with disconnected when the socket drops before the answer', async () => {
    const { client, socket } = connected();
    const asking = client.request('reset');
    await tick();
    socket().close();
    await expect(asking).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('extension-only connection features', () => {
  it('registers a request handler and answers calls with its result', async () => {
    const { connection, socket } = extensionConnection();
    const handler = vi.fn(async (data: unknown) => ({ echoed: data }));

    const registering = connection.handle('reset', handler as never);
    await tick();
    const handle = socket().last('msg.handle');
    socket().receive({ t: 'ok', id: handle.id });
    await registering;
    socket().receive({ t: 'msg.call', call: 3, name: 'scoreboard:reset', data: 5, sender });
    await tick();

    expect(handle.name).toBe('scoreboard:reset');
    expect(handler).toHaveBeenCalledExactlyOnceWith(5, { sender });
    expect(socket().last('call.ok')).toEqual({ t: 'call.ok', call: 3, data: { echoed: 5 } });
  });

  it('answers a call with the handler error: typed as it is, anything else as internal', async () => {
    const { connection, socket, errors } = extensionConnection();
    const failure = new Error('secret detail');
    const registering = connection.handle('reset', async (data) => {
      if (data === 'typed') throw new MoonCGError('invalid', 'bad input');
      throw failure;
    });
    await tick();
    socket().receive({ t: 'ok', id: socket().last('msg.handle').id });
    await registering;

    socket().receive({ t: 'msg.call', call: 1, name: 'scoreboard:reset', data: 'typed', sender });
    socket().receive({ t: 'msg.call', call: 2, name: 'scoreboard:reset', data: 'other', sender });
    await tick();

    const answers = socket().sent.filter((msg) => msg.t === 'call.err');
    expect(answers).toEqual([
      { t: 'call.err', call: 1, code: 'invalid', message: 'bad input' },
      { t: 'call.err', call: 2, code: 'internal', message: expect.not.stringContaining('secret') },
    ]);
    expect(errors).toEqual([failure]);
  });

  it('answers a call for a topic it does not handle with not_found', async () => {
    const { socket } = extensionConnection();
    socket().receive({ t: 'msg.call', call: 1, name: 'scoreboard:reset', data: 1, sender });
    await tick();
    expect(socket().last('call.err')).toMatchObject({ call: 1, code: 'not_found' });
  });

  it('registers an HTTP route and answers its calls', async () => {
    const { connection, socket } = extensionConnection();
    const request: HttpRequestData = {
      method: 'GET',
      path: '/teams/7',
      params: { id: '7' },
      query: {},
      headers: {},
      sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
      body: null,
    };
    const handler = vi.fn(async () => ({ status: 200, headers: {}, body: 'eA==' }));

    const registering = connection.route('GET', '/teams/:id', handler, 'view');
    await tick();
    const route = socket().last('http.route');
    socket().receive({ t: 'ok', id: route.id });
    await registering;
    socket().receive({ t: 'http.call', call: 9, route: route.id, request });
    socket().receive({ t: 'http.call', call: 10, route: route.id + 100, request });
    await tick();

    expect(route).toMatchObject({ method: 'GET', pattern: '/teams/:id', permission: 'view' });
    expect(handler).toHaveBeenCalledExactlyOnceWith(request, undefined);
    expect(socket().last('call.ok')).toEqual({
      t: 'call.ok',
      call: 9,
      data: { status: 200, headers: {}, body: 'eA==' },
    });
    expect(socket().last('call.err')).toMatchObject({ call: 10, code: 'not_found' });
  });

  it('keeps a handler of the old connection away from a call of the new one with the same id', async () => {
    const { connection, socket } = extensionConnection();
    const request: HttpRequestData = {
      method: 'POST',
      path: '/upload',
      params: {},
      query: {},
      headers: {},
      sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
      body: null,
      stream: true,
    };
    const finish: (() => void)[] = [];
    const bodies: (ReadableStream<Uint8Array> | undefined)[] = [];
    const registering = connection.route(
      'POST',
      '/upload',
      async (_request, body) => {
        bodies.push(body);
        await new Promise<void>((resolve) => finish.push(resolve));
        return { status: 204, headers: {}, body: null };
      },
      undefined,
      { stream: true },
    );
    await tick();
    const route = socket().last('http.route');
    socket().receive({ t: 'ok', id: route.id });
    await registering;

    socket().receive({ t: 'http.call', call: 1, route: route.id, request });
    await tick();
    const old = socket();
    old.close();
    await tick();
    socket().welcome();
    socket().receive({ t: 'http.call', call: 1, route: route.id, request });
    await tick();
    expect(socket()).not.toBe(old);

    // The handler of the old connection finishes now.
    finish[0]?.();
    await tick();
    expect(socket().sent.filter((msg) => msg.t === 'http.cancel' || msg.t === 'call.ok')).toEqual(
      [],
    );
    // The body of the new call still arrives.
    socket().receive({ t: 'http.data', call: 1, data: 'AQID' });
    socket().receive({ t: 'http.end', call: 1 });
    const reader = bodies[1]?.getReader();
    expect((await reader?.read())?.value).toEqual(new Uint8Array([1, 2, 3]));
    finish[1]?.();
    await tick();
    expect(socket().last('call.ok')).toMatchObject({ call: 1, data: { status: 204 } });
  });

  it('rejects a registration the server refuses', async () => {
    const { connection, socket } = extensionConnection();
    const registering = connection.route('GET', '/x', async () => ({
      status: 200,
      headers: {},
      sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
      body: null,
    }));
    await tick();
    socket().receive({
      t: 'err',
      id: socket().last('http.route').id,
      code: 'forbidden',
      message: 'no',
    });
    await expect(registering).rejects.toMatchObject({ code: 'forbidden' });
  });
});
