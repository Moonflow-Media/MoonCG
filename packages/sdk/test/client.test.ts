import { MoonCGError, PROTOCOL_VERSION } from '@mooncg/core';
import { describe, expect, it, vi } from 'vitest';
import { bundleFromPath, createClient } from '../src/client/index.js';
import { type FakeSocket, NAME, type Score, setup, tick, withScore } from './fake-socket.js';

describe('bundleFromPath', () => {
  it('reads the bundle from a /b/<bundle>/ page URL', () => {
    expect(bundleFromPath('/b/scoreboard/dashboard/control.html')).toBe('scoreboard');
    expect(bundleFromPath('/b/team-data/graphics/x/y.html')).toBe('team-data');
  });

  it('returns undefined for other paths', () => {
    expect(bundleFromPath('/')).toBeUndefined();
    expect(bundleFromPath('/api/v1/bundles')).toBeUndefined();
    expect(bundleFromPath('/b/Bad_Name/dashboard/a.html')).toBeUndefined();
  });
});

describe('createClient', () => {
  it('fails clearly when the bundle and URL cannot be derived', () => {
    expect(() => createClient({ url: 'ws://test/ws' })).toThrow(/bundle/);
    expect(() => createClient({ bundle: 'scoreboard' })).toThrow(/url/);
  });

  it('says hello with its bundle and protocol version once the socket opens', () => {
    const { socket, sockets } = setup();
    expect(sockets).toHaveLength(1);
    expect(socket().url).toBe('ws://test/ws');
    expect(socket().sent).toEqual([]);

    socket().open();

    expect(socket().sent).toEqual([{ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' }]);
  });

  it('becomes ready on welcome', async () => {
    const { client, socket } = setup();
    socket().welcome();
    await expect(client.ready).resolves.toBeUndefined();
  });

  it('rejects ready and stays down when the server speaks another protocol version', async () => {
    const { client, socket, sockets } = setup();
    socket().open();
    socket().receive({ t: 'welcome', v: PROTOCOL_VERSION + 1 });

    await expect(client.ready).rejects.toMatchObject({ code: 'bad_request' });
    await tick();
    expect(socket().closed).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it('rejects ready when the server refuses the hello', async () => {
    const { client, socket, sockets } = setup();
    socket().open();
    socket().receive({ t: 'err', code: 'bad_request', message: 'Unsupported protocol version' });

    await expect(client.ready).rejects.toBeInstanceOf(MoonCGError);
    await tick();
    expect(sockets).toHaveLength(1);
  });
});

describe('replicant', () => {
  it('subscribes after the handshake and exposes a frozen snapshot', async () => {
    const { client, socket } = setup();
    const score = client.replicant<Score>('score');
    expect(score.name).toBe(NAME);
    expect(score.value).toBeUndefined();
    socket().open();
    expect(socket().sent.some((msg) => msg.t === 'rep.sub')).toBe(false);

    socket().receive({ t: 'welcome', v: PROTOCOL_VERSION });
    const sub = socket().last('rep.sub');
    expect(sub.name).toBe(NAME);
    socket().receive({
      t: 'rep.snap',
      epoch: 'e1',
      id: sub.id,
      name: NAME,
      rev: 4,
      value: { home: 2, away: 1 },
    });

    await score.ready;
    expect(score.value).toEqual({ home: 2, away: 1 });
    expect(Object.isFrozen(score.value)).toBe(true);
  });

  it('returns the same handle and subscribes once per replicant', async () => {
    const { client, socket, score } = await withScore();
    expect(client.replicant('score')).toBe(score);
    expect(client.replicant(NAME)).toBe(score);
    expect(socket().sent.filter((msg) => msg.t === 'rep.sub')).toHaveLength(1);
  });

  it('rejects ready with a typed error when the replicant cannot be read', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const missing = client.replicant('made-up');
    socket().receive({
      t: 'err',
      id: socket().last('rep.sub').id,
      code: 'not_found',
      message: 'nope',
    });

    await expect(missing.ready).rejects.toMatchObject({ code: 'not_found', message: 'nope' });
    await expect(missing.ready).rejects.toBeInstanceOf(MoonCGError);
  });

  it('applies patches and notifies subscribers with the new frozen value', async () => {
    const { socket, score } = await withScore();
    const listener = vi.fn();
    score.subscribe(listener);
    listener.mockClear();

    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });

    expect(score.value).toEqual({ home: 1, away: 0 });
    expect(Object.isFrozen(score.value)).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ home: 1, away: 0 }, { rev: 1 });
  });

  it('calls a new subscriber with the current value, or with the first snapshot', async () => {
    const { client, socket, score } = await withScore();
    const late = vi.fn();
    score.subscribe(late);
    expect(late).toHaveBeenCalledExactlyOnceWith({ home: 0, away: 0 }, { rev: 0 });

    const other = client.replicant<string[]>('team-data:teams');
    const early = vi.fn();
    other.subscribe(early);
    expect(early).not.toHaveBeenCalled();
    socket().receive({
      t: 'rep.snap',
      epoch: 'e1',
      id: socket().last('rep.sub').id,
      name: 'team-data:teams',
      rev: 2,
      value: ['red'],
    });
    expect(early).toHaveBeenCalledExactlyOnceWith(['red'], { rev: 2 });
  });

  it('stops notifying after unsubscribe', async () => {
    const { socket, score } = await withScore();
    const listener = vi.fn();
    const unsubscribe = score.subscribe(listener);
    listener.mockClear();

    unsubscribe();
    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('asks for a fresh snapshot when a patch skips a revision', async () => {
    const { socket, score } = await withScore();

    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 3,
      patches: [{ op: 'replace', path: '/home', value: 9 }],
    });

    expect(score.value).toEqual({ home: 0, away: 0 });
    expect(socket().sent.filter((msg) => msg.t === 'rep.sub')).toHaveLength(2);
  });
});

describe('set', () => {
  it('sends a last-write-wins root replace and resolves on ack', async () => {
    const { socket, score } = await withScore();
    let settled = false;

    const done = score.set({ home: 5, away: 5 }).then(() => {
      settled = true;
    });
    await tick();
    const op = socket().last('rep.op');

    expect(op).toEqual({
      t: 'rep.op',
      id: op.id,
      name: NAME,
      patches: [{ op: 'replace', path: '', value: { home: 5, away: 5 } }],
    });
    expect(settled).toBe(false);
    socket().receive({ t: 'ack', id: op.id, rev: 1 });
    await done;
    expect(settled).toBe(true);
  });

  it('rejects with the typed error the server returns', async () => {
    const { socket, score } = await withScore();

    const done = score.set({ home: -1, away: 0 });
    await tick();
    socket().receive({
      t: 'err',
      id: socket().last('rep.op').id,
      code: 'forbidden',
      message: 'Missing permission',
    });

    await expect(done).rejects.toBeInstanceOf(MoonCGError);
    await expect(done).rejects.toMatchObject({ code: 'forbidden', message: 'Missing permission' });
  });

  it('waits for the first snapshot before sending', async () => {
    const { client, socket } = setup();
    const score = client.replicant<Score>('score');
    const done = score.set({ home: 1, away: 1 });
    socket().welcome();
    await tick();
    expect(socket().sent.some((msg) => msg.t === 'rep.op')).toBe(false);

    socket().receive({
      t: 'rep.snap',
      epoch: 'e1',
      id: socket().last('rep.sub').id,
      name: NAME,
      rev: 0,
      value: { home: 0, away: 0 },
    });
    await tick();
    socket().receive({ t: 'ack', id: socket().last('rep.op').id, rev: 1 });

    await expect(done).resolves.toBeUndefined();
  });
});

describe('update', () => {
  const increment = (draft: Score) => {
    draft.home++;
  };

  it('sends the recipe patches based on the current rev', async () => {
    const { socket, score } = await withScore();

    const done = score.update(increment);
    await tick();
    const op = socket().last('rep.op');
    expect(op).toMatchObject({
      name: NAME,
      baseRev: 0,
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });
    socket().receive({ t: 'rep.patch', name: NAME, rev: 1, patches: op.patches });
    socket().receive({ t: 'ack', id: op.id, rev: 1 });

    await done;
    expect(score.value).toEqual({ home: 1, away: 0 });
  });

  it('re-runs the recipe on the newer value after a conflict', async () => {
    const { socket, score } = await withScore();

    const done = score.update(increment);
    await tick();
    const first = socket().last('rep.op');
    // Another client got in first: its patch arrives before our rejection.
    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '/home', value: 10 }],
    });
    socket().receive({ t: 'err', id: first.id, code: 'conflict', message: 'stale' });
    await tick();
    const second = socket().last('rep.op');

    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({
      baseRev: 1,
      patches: [{ op: 'replace', path: '/home', value: 11 }],
    });
    socket().receive({ t: 'ack', id: second.id, rev: 2 });
    await expect(done).resolves.toBeUndefined();
  });

  it('gives up with conflict after three re-runs', async () => {
    const { socket, score } = await withScore();

    const done = score.update(increment);
    done.catch(() => {});
    for (let attempt = 0; attempt < 4; attempt++) {
      await tick();
      socket().receive({
        t: 'err',
        id: socket().last('rep.op').id,
        code: 'conflict',
        message: 'stale',
      });
    }

    await expect(done).rejects.toMatchObject({ code: 'conflict' });
    expect(socket().sent.filter((msg) => msg.t === 'rep.op')).toHaveLength(4);
  });
});

describe('disconnect', () => {
  it('rejects pending ops with disconnected', async () => {
    const { socket, score } = await withScore();
    const done = score.set({ home: 1, away: 1 });
    await tick();

    socket().close();

    await expect(done).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects ops while the socket is down', async () => {
    const { sockets, score } = await withScore();
    (sockets[0] as FakeSocket).close();

    await expect(score.set({ home: 1, away: 1 })).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('reconnects, resubscribes and takes a fresh snapshot', async () => {
    const { sockets, socket, score } = await withScore();
    const listener = vi.fn();
    score.subscribe(listener);
    listener.mockClear();

    socket().close();
    await tick();
    expect(sockets).toHaveLength(2);
    socket().welcome();
    const sub = socket().last('rep.sub');
    expect(socket().sent[0]).toEqual({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' });
    expect(sub.name).toBe(NAME);
    socket().receive({
      t: 'rep.snap',
      epoch: 'e1',
      id: sub.id,
      name: NAME,
      rev: 7,
      value: { home: 3, away: 3 },
    });

    expect(score.value).toEqual({ home: 3, away: 3 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ home: 3, away: 3 }, { rev: 7 });
  });

  it('does not reconnect after close()', async () => {
    const { client, sockets, socket } = await withScore();

    client.close();
    await tick();

    expect(socket().closed).toBe(true);
    expect(sockets).toHaveLength(1);
  });
});
