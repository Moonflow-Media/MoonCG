import { PROTOCOL_VERSION } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ClientOptions, createClient, graphicFromPath } from '../src/client/index.js';
import { FakeSocket, tick } from './fake-socket.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(options: ClientOptions = {}) {
  const sockets: FakeSocket[] = [];
  const duplicate: boolean[] = [];
  let reloads = 0;
  const client = createClient({
    bundle: 'scoreboard',
    url: 'ws://test/ws',
    reconnectDelayMs: 0,
    duplicateRetryMs: 0,
    graphic: 'graphics/overlay.html',
    onDuplicate: (is) => duplicate.push(is),
    reloadPage: () => {
      reloads++;
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  const socket = () => sockets.at(-1) as FakeSocket;
  return { client, sockets, socket, duplicate, reloads: () => reloads };
}

const REFUSED = { t: 'err', code: 'conflict', message: 'This graphic is already open' } as const;

describe('graphicFromPath', () => {
  it.each([
    ['/b/scoreboard/graphics/overlay.html', 'graphics/overlay.html'],
    ['/b/scoreboard/graphics/lower%20third/index.html', 'graphics/lower third/index.html'],
    ['/b/scoreboard/dashboard/control.html', undefined],
    ['/b/scoreboard/graphics/', undefined],
    ['/b/scoreboard/graphics/%2e%2e/x.html', undefined],
    ['/b/scoreboard/graphics/%zz.html', undefined],
    ['/somewhere/else', undefined],
  ])('reads %s as %s', (path, file) => {
    expect(graphicFromPath(path)).toBe(file);
  });
});

describe('a client on a graphic page', () => {
  it('says in hello which graphic it is', () => {
    const { socket } = setup();
    socket().open();
    expect(socket().sent).toEqual([
      { t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard', graphic: 'graphics/overlay.html' },
    ]);
  });

  it('says nothing of a graphic on any other page', () => {
    const { socket } = setup({ graphic: undefined });
    socket().open();
    expect(socket().sent).toEqual([{ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' }]);
  });

  it('reloads the page when the server asks for it', () => {
    const { socket, reloads } = setup();
    socket().welcome();
    socket().receive({ t: 'reload' });
    expect(reloads()).toBe(1);
  });

  it('reports a duplicate, loads nothing, and tries again until it gets the place', async () => {
    const { client, sockets, socket, duplicate } = setup();
    const score = client.replicant('score');
    let loaded = false;
    void score.ready.then(() => {
      loaded = true;
    });
    socket().open();
    socket().receive(REFUSED);
    expect(duplicate).toEqual([true]);
    expect(sockets[0]?.closed).toBe(true);

    // It asks again; refused again, it says nothing new.
    await tick();
    expect(sockets).toHaveLength(2);
    socket().open();
    socket().receive(REFUSED);
    expect(duplicate).toEqual([true]);
    expect(loaded).toBe(false);
    expect(socket().sent.some((msg) => msg.t === 'rep.sub')).toBe(false);

    // The other instance is gone: this one is welcome, and the graphic comes to life.
    await tick();
    socket().welcome();
    expect(duplicate).toEqual([true, false]);
    await client.ready;
    const sub = socket().last('rep.sub');
    socket().receive({
      t: 'rep.snap',
      id: sub.id,
      name: 'scoreboard:score',
      rev: 0,
      value: 1,
      epoch: 'e',
    });
    await score.ready;
    expect(score.value).toBe(1);
  });

  it('waits the time it was given before asking again', async () => {
    vi.useFakeTimers();
    const { sockets, socket } = setup({ duplicateRetryMs: 3000 });
    socket().open();
    socket().receive(REFUSED);
    await vi.advanceTimersByTimeAsync(2999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it('stops for good when hello is refused for another reason', async () => {
    const { client, sockets, socket, duplicate } = setup();
    socket().open();
    socket().receive({ t: 'err', code: 'forbidden', message: 'Missing permission' });
    await expect(client.ready).rejects.toMatchObject({ code: 'forbidden' });
    await tick();
    expect(sockets).toHaveLength(1);
    expect(duplicate).toEqual([]);
  });

  it.each([['replaced'], ['disconnected']] as const)(
    'stops for good, without asking again, when the server says it was %s',
    async (reason) => {
      const ended: string[] = [];
      const { client, sockets, socket, duplicate } = setup({ onEnded: (why) => ended.push(why) });
      socket().open();
      socket().welcome();
      await client.ready;
      const score = client.replicant('score');
      socket().receive({ t: 'graphic.end', reason });
      expect(ended).toEqual([reason]);
      expect(socket().closed).toBe(true);
      await tick();
      // No loop: two pages of one account would otherwise throw each other out for ever.
      expect(sockets).toHaveLength(1);
      expect(duplicate).toEqual([]);
      expect(score.error).toMatchObject({ code: 'conflict' });
    },
  );

  it('takes a conflict for final on a page that is no graphic', async () => {
    const { client, sockets, socket, duplicate } = setup({ graphic: undefined });
    socket().open();
    socket().receive(REFUSED);
    await expect(client.ready).rejects.toMatchObject({ code: 'conflict' });
    await tick();
    expect(sockets).toHaveLength(1);
    expect(duplicate).toEqual([]);
  });
});
