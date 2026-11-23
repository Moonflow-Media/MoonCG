import { describe, expect, it, vi } from 'vitest';
import { NAME, type Score, setup, tick, withScore } from './fake-socket.js';

const snapshot = (id: number, rev: number, value: { home: number; away: number }, epoch = 'e1') =>
  ({ t: 'rep.snap', id, name: NAME, rev, value, epoch }) as const;

describe('recovering from a local copy that went wrong', () => {
  it('asks for a full snapshot, not a replay, after a patch failed to apply', async () => {
    const { socket, score } = await withScore();

    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'remove', path: '/missing' }],
    });
    const sub = socket().last('rep.sub');
    socket().receive(snapshot(sub.id, 1, { home: 7, away: 7 }));

    expect(sub).not.toHaveProperty('since');
    expect(score.value).toEqual({ home: 7, away: 7 });
  });

  it('takes the snapshot even at the revision it believes to have', async () => {
    const { socket, score } = await withScore();
    const listener = vi.fn();
    score.subscribe(listener);
    listener.mockClear();
    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'remove', path: '/missing' }],
    });

    socket().receive(snapshot(socket().last('rep.sub').id, 0, { home: 5, away: 5 }));

    expect(score.value).toEqual({ home: 5, away: 5 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ home: 5, away: 5 }, { rev: 0 });
  });

  it('asks for a full snapshot when a patch skipped a revision', async () => {
    const { socket, score } = await withScore();

    socket().receive({ t: 'rep.patch', name: NAME, rev: 3, patches: [] });
    const sub = socket().last('rep.sub');
    socket().receive(snapshot(sub.id, 3, { home: 3, away: 3 }));

    expect(sub).not.toHaveProperty('since');
    expect(score.value).toEqual({ home: 3, away: 3 });
  });

  it('goes back to naming its state once it is in step again', async () => {
    const context = await withScore();
    context.socket().receive({ t: 'rep.patch', name: NAME, rev: 3, patches: [] });
    context
      .socket()
      .receive(snapshot(context.socket().last('rep.sub').id, 3, { home: 3, away: 3 }));

    context.socket().close();
    await tick();
    context.socket().welcome();

    expect(context.socket().last('rep.sub').since).toEqual({ epoch: 'e1', rev: 3 });
  });
});

describe('a snapshot with the value already held', () => {
  it('keeps the value object, does not notify, and follows the new revision', async () => {
    const context = await withScore();
    const listener = vi.fn();
    context.score.subscribe(listener);
    listener.mockClear();
    const before = context.score.value;
    context.socket().close();
    await tick();
    context.socket().welcome();

    // A restarted server: new epoch, another revision, the same value.
    context
      .socket()
      .receive(snapshot(context.socket().last('rep.sub').id, 40, { home: 0, away: 0 }, 'e2'));

    expect(context.score.value).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    context.socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 41,
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ home: 1, away: 0 }, { rev: 41 });
  });
});

describe('onErrorChange', () => {
  it('tells listeners when the replicant becomes unusable and when it recovers', async () => {
    const context = await withScore();
    const seen: (string | undefined)[] = [];
    context.score.onErrorChange(() => seen.push(context.score.error?.code));

    context.socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' });
    context.socket().close();
    await tick();
    context.socket().welcome();
    context
      .socket()
      .receive(snapshot(context.socket().last('rep.sub').id, 0, { home: 0, away: 0 }, 'e2'));

    expect(seen).toEqual(['not_found', undefined]);
  });

  it('tells listeners about a refused subscription and stops after unsubscribing', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const first = client.replicant<Score>('first');
    const second = client.replicant<Score>('second');
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    first.onErrorChange(onFirst);
    second.onErrorChange(onSecond)();
    const subs = socket().sent.filter((msg) => msg.t === 'rep.sub');

    for (const sub of subs) {
      socket().receive({ t: 'err', id: sub.id, code: 'forbidden', message: 'no' });
    }

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(first.error).toMatchObject({ code: 'forbidden' });
    expect(onSecond).not.toHaveBeenCalled();
  });

  it('contains a throwing listener', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { socket, score } = await withScore();
    const later = vi.fn();
    score.onErrorChange(() => {
      throw new Error('listener failure');
    });
    score.onErrorChange(later);

    expect(() => socket().receive({ t: 'rep.gone', name: NAME, message: 'removed' })).not.toThrow();

    expect(later).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
