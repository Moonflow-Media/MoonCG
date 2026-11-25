import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../src/http/base64.js';
import { RouteTable } from '../../src/http/routes.js';
import { extensionPrincipal, TRUSTED_EXTENSION_POLICY } from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  MAX_STREAM_CHUNK_BYTES,
  PROTOCOL_VERSION,
  type ServerMessage,
  STREAM_WINDOW,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import { createSession, MAX_STREAMED_BODIES } from '../../src/session/session.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const request = {
  method: 'POST',
  path: '/upload',
  params: {},
  query: {},
  headers: {},
  sender: { principal: 'tester', kind: 'user', bundle: 'demo' },
  body: null,
} as const;

/** An extension's session with one route; `sent` is what the server sends the extension. */
let lastRoutes: RouteTable | undefined;

function setup(route: Partial<Extract<ClientMessage, { t: 'http.route' }>> = { stream: true }) {
  const routes = new RouteTable();
  lastRoutes = routes;
  const sent: ServerMessage[] = [];
  const session = createSession({
    principal: extensionPrincipal('demo'),
    policy: TRUSTED_EXTENSION_POLICY,
    registry: new ReplicantRegistry(),
    bundleExists: () => true,
    send: (msg) => sent.push(msg),
    routes,
    timers: { setTimeout, clearTimeout },
    extension: { capabilities: ['http.routes'], permissions: [] },
  });
  const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
  receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'demo' });
  receive({ t: 'http.route', id: 1, method: 'POST', pattern: '/upload', ...route });
  sent.length = 0;
  const matched = routes.match('demo', 'POST', '/upload');
  if (!matched) throw new Error('route missing');
  const of = <T extends ServerMessage['t']>(t: T) =>
    sent.filter((msg) => msg.t === t) as Extract<ServerMessage, { t: T }>[];
  return { session, sent, receive, route: matched.route, of };
}

async function* pieces(count: number, size = MAX_STREAM_CHUNK_BYTES) {
  for (let index = 0; index < count; index++) yield new Uint8Array(size).fill(index);
}

describe('streamed request bodies', () => {
  it('registers whether a route streams and its limit', () => {
    const { route } = setup({ stream: true, maxBytes: null });
    expect(route.stream).toBe(true);
    expect(route.maxBodyBytes).toBeNull();
    expect(setup({}).route.stream).toBe(false);
  });

  it('sends no more than the window before the extension asks for more', async () => {
    const { route, sent, receive, of } = setup();
    const answer = route.invoke(request, { body: pieces(10) });
    await flush();

    const call = of('http.call')[0];
    expect(call?.request).toMatchObject({ body: null, stream: true });
    expect(of('http.data')).toHaveLength(STREAM_WINDOW);

    const id = call?.call as number;
    for (let pulled = 1; pulled <= 6; pulled++) {
      receive({ t: 'http.pull', call: id });
      await flush();
      expect(of('http.data')).toHaveLength(Math.min(STREAM_WINDOW + pulled, 10));
    }
    expect(of('http.end')).toHaveLength(1);
    expect(base64ToBytes(of('http.data')[9]?.data as string)[0]).toBe(9);

    receive({ t: 'call.ok', call: id, data: { status: 200, headers: {}, body: null } });
    await expect(answer).resolves.toEqual({ status: 200, headers: {}, body: null });
    expect(sent.at(-1)).toMatchObject({ t: 'http.end' });
  });

  it('splits large pieces into chunks of at most 64 KiB', async () => {
    const { route, receive, of } = setup();
    void route.invoke(request, { body: pieces(1, MAX_STREAM_CHUNK_BYTES * 2 + 1) });
    await flush();
    const id = of('http.call')[0]?.call as number;
    receive({ t: 'http.pull', call: id });
    await flush();
    const sizes = of('http.data').map((msg) => base64ToBytes(msg.data).length);
    expect(sizes).toEqual([MAX_STREAM_CHUNK_BYTES, MAX_STREAM_CHUNK_BYTES, 1]);
  });

  it('stops sending when the extension cancels, and fails nothing', async () => {
    const { route, receive, of, session } = setup();
    const answer = route.invoke(request, { body: pieces(100) });
    await flush();
    const id = of('http.call')[0]?.call as number;
    receive({ t: 'http.cancel', call: id });
    receive({ t: 'http.pull', call: id });
    await flush();
    expect(of('http.data')).toHaveLength(STREAM_WINDOW);
    receive({ t: 'call.ok', call: id, data: { status: 413, headers: {}, body: null } });
    await expect(answer).resolves.toMatchObject({ status: 413 });
    expect(session.stats().streams).toBe(0);
  });

  it('fails the call and tells the extension when the body breaks off', async () => {
    const { route, of, session } = setup();
    async function* broken() {
      yield new Uint8Array(10);
      throw new Error('client went away');
    }
    const answer = route.invoke(request, { body: broken() });
    await expect(answer).rejects.toMatchObject({ code: 'unavailable' });
    expect(of('http.abort')).toHaveLength(1);
    expect(session.stats()).toMatchObject({ calls: 0, streams: 0 });
  });

  it('tells the extension when the client goes away', async () => {
    const { route, of } = setup();
    const controller = new AbortController();
    const answer = route.invoke(request, { body: pieces(100), signal: controller.signal });
    await flush();
    controller.abort();
    await expect(answer).rejects.toMatchObject({ code: 'unavailable' });
    expect(of('http.abort')).toHaveLength(1);
  });

  it('does not hand a body to a route that does not stream', async () => {
    const { route, of } = setup({});
    void route.invoke(request, { body: pieces(1) });
    await flush();
    expect(of('http.call')[0]?.request).not.toHaveProperty('stream');
    expect(of('http.data')).toHaveLength(0);
  });
});

describe('streamed answers', () => {
  async function answered() {
    const context = setup({});
    const answer = context.route.invoke(request);
    const id = context.of('http.call')[0]?.call as number;
    context.receive({
      t: 'call.ok',
      call: id,
      data: { status: 200, headers: {}, body: null, stream: true },
    });
    const reply = await answer;
    if (!reply.pieces) throw new Error('no stream');
    const iterator = reply.pieces[Symbol.asyncIterator]();
    return { ...context, id, iterator };
  }

  it('hands the pieces on and asks for one more for each one read', async () => {
    const { iterator, receive, id, of } = await answered();
    receive({ t: 'http.data', call: id, data: bytesToBase64(new Uint8Array([1, 2])) });
    receive({ t: 'http.data', call: id, data: bytesToBase64(new Uint8Array([3])) });
    expect(of('http.pull')).toHaveLength(0);

    expect((await iterator.next()).value).toEqual(new Uint8Array([1, 2]));
    expect(of('http.pull')).toHaveLength(1);
    const waiting = iterator.next();
    receive({ t: 'http.end', call: id });
    expect((await waiting).value).toEqual(new Uint8Array([3]));
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('ends the exchange when the extension sends more than the window', async () => {
    const { iterator, receive, id, session } = await answered();
    for (let index = 0; index <= STREAM_WINDOW; index++) {
      receive({ t: 'http.data', call: id, data: bytesToBase64(new Uint8Array([index])) });
    }
    await expect(
      (async () => {
        for (;;) if ((await iterator.next()).done) return;
      })(),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(session.stats().streams).toBe(0);
  });

  it('fails what is being read when the extension aborts or goes away', async () => {
    const first = await answered();
    first.receive({ t: 'http.abort', call: first.id, message: 'generator threw' });
    await expect(first.iterator.next()).rejects.toMatchObject({ code: 'unavailable' });

    const second = await answered();
    const waiting = second.iterator.next();
    second.session.close();
    await expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('tells the extension to stop when the reader stops', async () => {
    const { iterator, of, id, receive, session } = await answered();
    await iterator.return?.();
    expect(of('http.cancel')).toEqual([{ t: 'http.cancel', call: id }]);
    expect(session.stats().streams).toBe(0);
    // Late pieces are refused once more.
    receive({ t: 'http.data', call: id, data: bytesToBase64(new Uint8Array([1])) });
    expect(of('http.cancel')).toHaveLength(2);
  });

  it('cancels a streamed answer nobody waits for any more', async () => {
    const { receive, of } = setup({});
    receive({
      t: 'call.ok',
      call: 99,
      data: { status: 200, headers: {}, body: null, stream: true },
    });
    expect(of('http.cancel')).toEqual([{ t: 'http.cancel', call: 99 }]);
  });
});

describe('limits on streamed bodies', () => {
  /** A body that never sends anything, as a client that has stalled. */
  const stalled = (): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  });

  it('does not let slow uploads take the slots of other calls', async () => {
    const { route, receive, of, session } = setup();
    const uploads = Array.from({ length: 100 }, () => route.invoke(request, { body: stalled() }));
    for (const upload of uploads) upload.catch(() => {});
    await flush();

    // Only the first few reach the extension; the rest are refused at once.
    expect(of('http.call')).toHaveLength(MAX_STREAMED_BODIES);
    const refused = await Promise.allSettled(uploads.slice(MAX_STREAMED_BODIES));
    expect(refused.every((result) => result.status === 'rejected')).toBe(true);
    expect(session.stats()).toMatchObject({ streams: MAX_STREAMED_BODIES });

    // Any other call still goes through.
    receive({ t: 'http.route', id: 2, method: 'GET', pattern: '/plain' });
    const plain = routeOf('/plain');
    const answer = plain.invoke({ ...request, method: 'GET', path: '/plain' });
    const call = of('http.call').at(-1)?.call as number;
    receive({ t: 'call.ok', call, data: { status: 204, headers: {}, body: null } });
    await expect(answer).resolves.toMatchObject({ status: 204 });
  });

  it('caps streamed answers together with streamed uploads', async () => {
    const { route, receive, of, session } = setup();
    for (let index = 0; index < MAX_STREAMED_BODIES; index++) {
      route.invoke(request, { body: stalled() }).catch(() => {});
    }
    await flush();
    receive({ t: 'http.route', id: 2, method: 'GET', pattern: '/plain' });
    const plain = routeOf('/plain');
    const answer = plain.invoke({ ...request, method: 'GET', path: '/plain' });
    const call = of('http.call').at(-1)?.call as number;
    receive({ t: 'call.ok', call, data: { status: 200, headers: {}, body: null, stream: true } });

    await expect(answer).rejects.toMatchObject({ code: 'unavailable' });
    expect(of('http.cancel')).toContainEqual({ t: 'http.cancel', call });
    expect(session.stats().streams).toBe(MAX_STREAMED_BODIES);
  });

  it('counts only calls whose bodies stream as streams', async () => {
    const { session, receive, of } = setup();
    receive({ t: 'http.route', id: 2, method: 'GET', pattern: '/plain' });
    const plain = routeOf('/plain');
    const answer = plain.invoke({ ...request, method: 'GET', path: '/plain' });
    expect(session.stats()).toMatchObject({ calls: 1, streams: 0 });
    const call = of('http.call').at(-1)?.call as number;
    receive({ t: 'call.ok', call, data: { status: 204, headers: {}, body: null } });
    await answer;
  });

  it('refuses header values that Node cannot send', async () => {
    for (const value of ['café', 'aĀ', '€', 'x\x7f', 'a\r\nb: c']) {
      const { route, receive, of } = setup({});
      const answer = route.invoke(request);
      const call = of('http.call')[0]?.call as number;
      receive({ t: 'call.ok', call, data: { status: 200, headers: { 'x-v': value }, body: null } });
      if (value === 'café') await expect(answer).resolves.toMatchObject({ status: 200 });
      else await expect(answer).rejects.toMatchObject({ code: 'internal' });
    }
  });
});

/** The route of a pattern, after the extension registered it on the session. */
function routeOf(pattern: string) {
  const matched = lastRoutes?.match('demo', 'GET', pattern);
  if (!matched) throw new Error('route missing');
  return matched.route;
}

describe('stream messages on the wire', () => {
  it('round-trip in both directions', () => {
    const messages = [
      { t: 'http.data', call: 1, data: 'AAEC' },
      { t: 'http.end', call: 1 },
      { t: 'http.pull', call: 1 },
      { t: 'http.cancel', call: 1 },
      { t: 'http.abort', call: 1, message: 'gone' },
    ] as const;
    for (const msg of messages) {
      expect(decodeClientMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
      expect(decodeServerMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
    }
  });

  it('refuses pieces that are too large or not base64, and limits without a stream', () => {
    const big = 'A'.repeat((MAX_STREAM_CHUNK_BYTES / 3 + 2) * 4);
    expect(decodeClientMessage(JSON.stringify({ t: 'http.data', call: 1, data: big })).ok).toBe(
      false,
    );
    expect(decodeClientMessage('{"t":"http.data","call":1,"data":"*"}').ok).toBe(false);
    expect(decodeClientMessage('{"t":"http.data","call":1,"data":""}').ok).toBe(false);
    expect(
      decodeClientMessage('{"t":"http.route","id":1,"method":"POST","pattern":"/","maxBytes":10}')
        .ok,
    ).toBe(false);
    expect(
      decodeClientMessage(
        '{"t":"http.route","id":1,"method":"POST","pattern":"/","stream":true,"maxBytes":-1}',
      ).ok,
    ).toBe(false);
  });

  it('takes a piece of exactly 64 KiB and refuses one byte more', () => {
    const piece = (size: number) =>
      decodeClientMessage(
        JSON.stringify({ t: 'http.data', call: 1, data: bytesToBase64(new Uint8Array(size)) }),
      ).ok;
    expect(piece(MAX_STREAM_CHUNK_BYTES)).toBe(true);
    expect(piece(MAX_STREAM_CHUNK_BYTES - 1)).toBe(true);
    expect(piece(MAX_STREAM_CHUNK_BYTES + 1)).toBe(false);
    expect(piece(MAX_STREAM_CHUNK_BYTES + 2)).toBe(false);
  });

  it('encodes base64 the same with and without Buffer', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    for (let length = 0; length <= bytes.length; length++) {
      const part = bytes.subarray(0, length);
      expect(base64ToBytes(bytesToBase64(part))).toEqual(part);
    }
  });
});
