import { MoonCGError } from '@mooncg/core';
import { describe, expect, it, vi } from 'vitest';
import { NAME, type Score, setup, tick, withScore } from './fake-socket.js';

/** Drops the connection and completes the handshake on the socket the client opens next. */
async function reconnect(context: Awaited<ReturnType<typeof withScore>>) {
  context.socket().close();
  await tick();
  context.socket().welcome();
  return context.socket().last('rep.sub');
}

describe('resubscribing', () => {
  it('sends no last known state on the first subscription', async () => {
    const { socket } = await withScore();
    expect(socket().last('rep.sub')).not.toHaveProperty('since');
  });

  it('names the epoch and revision it has after a reconnect', async () => {
    const context = await withScore();
    context.socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });

    const sub = await reconnect(context);

    expect(sub).toMatchObject({ name: NAME, since: { epoch: 'e1', rev: 1 } });
  });

  it('applies replayed patches and notifies once per patch', async () => {
    const context = await withScore();
    const seen: number[] = [];
    context.score.subscribe((_value, meta) => seen.push(meta.rev));
    const sub = await reconnect(context);

    for (const rev of [1, 2]) {
      context.socket().receive({
        t: 'rep.patch',
        name: NAME,
        rev,
        patches: [{ op: 'replace', path: '/home', value: rev }],
      });
    }
    context.socket().receive({ t: 'ack', id: sub.id, rev: 2 });

    expect(context.score.value).toEqual({ home: 2, away: 0 });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('does not notify when the server only acks, because nothing changed', async () => {
    const context = await withScore();
    const listener = vi.fn();
    context.score.subscribe(listener);
    listener.mockClear();
    const before = context.score.value;
    const sub = await reconnect(context);

    context.socket().receive({ t: 'ack', id: sub.id, rev: 0 });
    const write = context.score.set({ home: 1, away: 1 });
    await tick();

    expect(listener).not.toHaveBeenCalled();
    expect(context.score.value).toBe(before);
    expect(context.socket().last('rep.op')).toMatchObject({ name: NAME });
    context.socket().receive({ t: 'ack', id: context.socket().last('rep.op').id, rev: 1 });
    await expect(write).resolves.toBeUndefined();
  });

  it('does not notify for a snapshot of the state it already has', async () => {
    const context = await withScore();
    const listener = vi.fn();
    context.score.subscribe(listener);
    listener.mockClear();
    const before = context.score.value;
    const sub = await reconnect(context);

    context.socket().receive({
      t: 'rep.snap',
      id: sub.id,
      name: NAME,
      rev: 0,
      value: { home: 0, away: 0 },
      epoch: 'e1',
    });

    expect(listener).not.toHaveBeenCalled();
    expect(context.score.value).toBe(before);
  });

  it('takes a snapshot from another epoch even at the same revision', async () => {
    const context = await withScore();
    const listener = vi.fn();
    context.score.subscribe(listener);
    listener.mockClear();
    const sub = await reconnect(context);

    context.socket().receive({
      t: 'rep.snap',
      id: sub.id,
      name: NAME,
      rev: 0,
      value: { home: 9, away: 9 },
      epoch: 'e2',
    });
    const next = await reconnect(context);

    expect(listener).toHaveBeenCalledExactlyOnceWith({ home: 9, away: 9 }, { rev: 0 });
    expect(next.since).toEqual({ epoch: 'e2', rev: 0 });
  });
});

describe('a replicant the server removed', () => {
  it('reports the error on the handle and rejects writes without sending them', async () => {
    const { socket, score } = await withScore();
    expect(score.error).toBeUndefined();

    socket().receive({ t: 'rep.gone', name: NAME, message: 'Replicant was removed' });
    const write = score.set({ home: 1, away: 1 });

    expect(score.error).toBeInstanceOf(MoonCGError);
    expect(score.error).toMatchObject({ code: 'not_found', message: 'Replicant was removed' });
    await expect(write).rejects.toMatchObject({ code: 'not_found' });
    await expect(score.update(() => {})).rejects.toMatchObject({ code: 'not_found' });
    expect(socket().sent.some((msg) => msg.t === 'rep.op')).toBe(false);
    expect(score.value).toEqual({ home: 0, away: 0 });
  });

  it('becomes usable again when a later subscription succeeds', async () => {
    const context = await withScore();
    context.socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' });

    const sub = await reconnect(context);
    expect(sub).not.toHaveProperty('since');
    context.socket().receive({
      t: 'rep.snap',
      id: sub.id,
      name: NAME,
      rev: 0,
      value: { home: 3, away: 3 },
      epoch: 'e3',
    });

    expect(context.score.error).toBeUndefined();
    expect(context.score.value).toEqual({ home: 3, away: 3 });
  });

  it('reports a refused subscription on the handle too', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const missing = client.replicant<Score>('made-up');
    socket().receive({
      t: 'err',
      id: socket().last('rep.sub').id,
      code: 'not_found',
      message: 'nope',
    });

    await expect(missing.ready).rejects.toMatchObject({ code: 'not_found' });
    expect(missing.error).toMatchObject({ code: 'not_found' });
  });
});

describe('hello for a bundle that is not running', () => {
  // The page waits for the bundle: see client-bundle-restart.test.ts.
  it('does not reject ready: the bundle may be back in a moment', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, socket, sockets } = setup();
    socket().open();
    socket().receive({
      t: 'err',
      code: 'not_found',
      message: 'Bundle "scoreboard" is not running',
    });

    const settled = vi.fn();
    client.ready.then(settled, settled);
    await tick();
    expect(settled).not.toHaveBeenCalled();
    expect(sockets.length).toBeGreaterThan(1);
    client.close();
    vi.restoreAllMocks();
  });
});
