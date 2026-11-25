import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client/index.js';
import { FakeSocket, NAME, type Score, setup, tick, withScore } from './fake-socket.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const snapshot = (id: number, value: { home: number; away: number }, epoch = 'e2') =>
  ({ t: 'rep.snap', id, name: NAME, rev: 0, value, epoch }) as const;
const sender = { principal: 'op', kind: 'user', bundle: 'scoreboard' } as const;

describe('a replicant whose bundle was restarted', () => {
  it('subscribes again when the server says the replicant is back', async () => {
    const { socket, score } = await withScore();
    const before = socket().sent.filter((msg) => msg.t === 'rep.sub').length;
    socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' });

    socket().receive({ t: 'rep.back', name: NAME });

    const subs = socket().sent.filter((msg) => msg.t === 'rep.sub');
    expect(subs).toHaveLength(before + 1);
    // What was held belongs to a replicant that is gone: only a snapshot will do.
    expect(subs.at(-1)).toEqual({ t: 'rep.sub', id: expect.any(Number), name: NAME });
    expect(score.error).toMatchObject({ code: 'not_found' });
  });

  it('is usable again once the snapshot arrived, and tells its subscribers', async () => {
    const { socket, score } = await withScore();
    const listener = vi.fn();
    score.subscribe(listener);
    listener.mockClear();
    const errors: (string | undefined)[] = [];
    score.onErrorChange(() => errors.push(score.error?.code));
    socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' });
    socket().receive({ t: 'rep.back', name: NAME });

    socket().receive(snapshot(socket().last('rep.sub').id, { home: 4, away: 2 }));
    const write = score.set({ home: 5, away: 2 });
    await tick();

    expect(errors).toEqual(['not_found', undefined]);
    expect(score.value).toEqual({ home: 4, away: 2 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ home: 4, away: 2 }, { rev: 0 });
    const op = socket().last('rep.op');
    socket().receive({ t: 'ack', id: op.id, rev: 1 });
    await expect(write).resolves.toBeUndefined();
  });

  it('follows patches of the new replicant from its first revision', async () => {
    const { socket, score } = await withScore();
    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });
    socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' });
    socket().receive({ t: 'rep.back', name: NAME });
    socket().receive(snapshot(socket().last('rep.sub').id, { home: 0, away: 0 }));

    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '/away', value: 9 }],
    });

    expect(score.value).toEqual({ home: 0, away: 9 });
  });

  it('gives a replicant that was asked for too early a ready that resolves', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const score = client.replicant<Score>('score');
    const early = score.ready;
    socket().receive({
      t: 'err',
      id: socket().last('rep.sub').id,
      code: 'not_found',
      message: 'Replicant "scoreboard:score" is not declared',
    });
    await expect(early).rejects.toMatchObject({ code: 'not_found' });

    socket().receive({ t: 'rep.back', name: NAME });
    socket().receive(snapshot(socket().last('rep.sub').id, { home: 1, away: 1 }));

    await expect(score.ready).resolves.toBeUndefined();
    expect(score.error).toBeUndefined();
    expect(score.value).toEqual({ home: 1, away: 1 });
  });

  it('resolves ready also when the replicant comes back through a reconnect', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const score = client.replicant<Score>('score');
    socket().receive({
      t: 'err',
      id: socket().last('rep.sub').id,
      code: 'not_found',
      message: 'not declared',
    });
    await expect(score.ready).rejects.toMatchObject({ code: 'not_found' });

    socket().close();
    await tick();
    socket().welcome();
    socket().receive(snapshot(socket().last('rep.sub').id, { home: 2, away: 2 }));

    await expect(score.ready).resolves.toBeUndefined();
  });

  it('ignores an announcement for a replicant nobody asked for', async () => {
    const { socket } = await withScore();
    const before = socket().sent.length;
    socket().receive({ t: 'rep.back', name: 'scoreboard:other' });
    expect(socket().sent).toHaveLength(before);
  });
});

describe('a message topic whose bundle was restarted', () => {
  async function listening() {
    const context = setup();
    context.socket().welcome();
    const listener = vi.fn();
    const subscribing = context.client.on('reset', listener);
    await tick();
    context.socket().receive({ t: 'ok', id: context.socket().last('msg.sub').id });
    const stop = await subscribing;
    return { ...context, listener, stop };
  }
  const subs = (context: Awaited<ReturnType<typeof listening>>) =>
    context.socket().sent.filter((msg) => msg.t === 'msg.sub');

  it('listens again when the server says the topic is back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = await listening();
    context.socket().receive({ t: 'msg.gone', name: 'scoreboard:reset', message: 'removed' });

    context.socket().receive({ t: 'msg.back', name: 'scoreboard:reset' });
    await tick();
    context.socket().receive({ t: 'ok', id: context.socket().last('msg.sub').id });
    context.socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 1, sender });

    expect(subs(context)).toHaveLength(2);
    expect(context.listener).toHaveBeenCalledExactlyOnceWith(1, { sender });
  });

  it('does not listen again for a topic whose last listener stopped meanwhile', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = await listening();
    context.socket().receive({ t: 'msg.gone', name: 'scoreboard:reset', message: 'removed' });
    context.stop();

    context.socket().receive({ t: 'msg.back', name: 'scoreboard:reset' });
    await tick();

    expect(subs(context)).toHaveLength(1);
  });

  it('keeps a topic that is not declared at a reconnect, and listens when it is back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = await listening();
    context.socket().close();
    await tick();
    context.socket().welcome();
    context.socket().receive({
      t: 'err',
      id: context.socket().last('msg.sub').id,
      code: 'not_found',
      message: 'Message "scoreboard:reset" is not declared',
    });
    await tick();

    context.socket().receive({ t: 'msg.back', name: 'scoreboard:reset' });
    await tick();
    context.socket().receive({ t: 'ok', id: context.socket().last('msg.sub').id });
    context.socket().receive({ t: 'msg', name: 'scoreboard:reset', data: 2, sender });

    expect(context.listener).toHaveBeenCalledExactlyOnceWith(2, { sender });
    expect(report).not.toHaveBeenCalled();
  });

  it('gives up a topic the server refuses for good', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = await listening();
    context.socket().close();
    await tick();
    context.socket().welcome();
    context.socket().receive({
      t: 'err',
      id: context.socket().last('msg.sub').id,
      code: 'forbidden',
      message: 'no',
    });
    await tick();
    const before = subs(context).length;

    context.socket().receive({ t: 'msg.back', name: 'scoreboard:reset' });
    await tick();

    expect(subs(context)).toHaveLength(before);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('a page that connects while its bundle is not running', () => {
  const refuse = (socket: FakeSocket) => {
    socket.open();
    socket.receive({ t: 'err', code: 'not_found', message: 'Bundle "scoreboard" is not running' });
  };

  it('keeps asking instead of giving up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket, sockets } = setup();
    refuse(socket());
    await tick();
    refuse(socket());
    await tick();

    expect(sockets.length).toBeGreaterThanOrEqual(3);
    expect(client.status).toBe('reconnecting');
  });

  it('is live, with its replicants, once the bundle runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket } = setup();
    const score = client.replicant<Score>('score');
    refuse(socket());
    await tick();

    socket().welcome();
    socket().receive(snapshot(socket().last('rep.sub').id, { home: 1, away: 0 }));

    await expect(client.ready).resolves.toBeUndefined();
    await expect(score.ready).resolves.toBeUndefined();
    expect(client.status).toBe('live');
  });

  it('says once that it waits, however often it is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { socket } = setup();
    refuse(socket());
    await tick();
    refuse(socket());
    await tick();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('not running');
  });

  it('waits longer between attempts the longer the bundle stays away', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      createClient({
        bundle: 'scoreboard',
        url: 'ws://test/ws',
        reconnectDelayMs: 100,
        createSocket: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        },
      });
      refuse(sockets.at(-1) as FakeSocket);
      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(2);
      refuse(sockets.at(-1) as FakeSocket);
      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(2);
      vi.advanceTimersByTime(100);
      expect(sockets).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up at once when asked not to wait', async () => {
    const sockets: FakeSocket[] = [];
    const client = createClient({
      bundle: 'scoreboard',
      url: 'ws://test/ws',
      reconnectDelayMs: 0,
      waitForBundle: false,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    refuse(sockets[0] as FakeSocket);

    await expect(client.ready).rejects.toMatchObject({ code: 'not_found' });
    await tick();
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('offline');
  });

  it('still gives up for good when the server refuses it for another reason', async () => {
    const { client, socket, sockets } = setup();
    socket().open();
    socket().receive({ t: 'err', code: 'forbidden', message: 'Missing permission' });

    await expect(client.ready).rejects.toMatchObject({ code: 'forbidden' });
    await tick();
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('offline');
  });
});

describe('a page told to reload', () => {
  it('reloads, whether it is a graphic or a panel', async () => {
    const reloadPage = vi.fn();
    let socket: FakeSocket | undefined;
    createClient({
      bundle: 'scoreboard',
      url: 'ws://test/ws',
      reloadPage,
      createSocket: (url) => {
        socket = new FakeSocket(url);
        return socket;
      },
    });
    socket?.welcome();

    socket?.receive({ t: 'reload' });

    expect(reloadPage).toHaveBeenCalledTimes(1);
  });
});
