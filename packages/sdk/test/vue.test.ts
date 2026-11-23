import { describe, expect, it } from 'vitest';
import { effectScope, isReadonly, isShallow, watch } from 'vue';
import { useReplicant } from '../src/vue/index.js';
import { NAME, type Score, setup, tick, withScore } from './fake-socket.js';

const patchHome = (value: number, rev: number) =>
  ({
    t: 'rep.patch',
    name: NAME,
    rev,
    patches: [{ op: 'replace', path: '/home', value }],
  }) as const;

describe('useReplicant (Vue)', () => {
  it('exposes the value as a readonly shallow ref that follows the replicant', async () => {
    const { socket, score } = await withScore();
    const scope = effectScope();
    const { data } = scope.run(() => useReplicant(score)) as ReturnType<typeof useReplicant<Score>>;

    expect(data.value).toEqual({ home: 0, away: 0 });
    expect(isReadonly(data)).toBe(true);
    expect(isShallow(data)).toBe(true);

    socket().receive(patchHome(4, 1));

    expect(data.value).toEqual({ home: 4, away: 0 });
    expect(data.value).toBe(score.value);
    scope.stop();
  });

  it('starts undefined and triggers watchers when the first value arrives', async () => {
    const { client, socket } = setup();
    socket().welcome();
    const score = client.replicant<Score>('score');
    const scope = effectScope();
    const seen: unknown[] = [];
    const { data, ready } = scope.run(() => {
      const used = useReplicant(score);
      watch(used.data, (value) => seen.push(value), { flush: 'sync' });
      return used;
    }) as ReturnType<typeof useReplicant<Score>>;
    expect(data.value).toBeUndefined();

    socket().receive({
      t: 'rep.snap',
      id: socket().last('rep.sub').id,
      name: NAME,
      rev: 0,
      value: { home: 1, away: 1 },
      epoch: 'e1',
    });
    await ready;

    expect(seen).toEqual([{ home: 1, away: 1 }]);
    scope.stop();
  });

  it('refuses writes through the ref', async () => {
    const { score } = await withScore();
    const scope = effectScope();
    const { data } = scope.run(() => useReplicant(score)) as ReturnType<typeof useReplicant<Score>>;

    (data as { value: unknown }).value = { home: 9, away: 9 };

    expect(data.value).toEqual({ home: 0, away: 0 });
    scope.stop();
  });

  it('unsubscribes when its effect scope stops', async () => {
    const { socket, score } = await withScore();
    const scope = effectScope();
    const { data } = scope.run(() => useReplicant(score)) as ReturnType<typeof useReplicant<Score>>;

    scope.stop();
    socket().receive(patchHome(4, 1));

    expect(score.value).toEqual({ home: 4, away: 0 });
    expect(data.value).toEqual({ home: 0, away: 0 });
  });

  it('passes set and update on to the replicant', async () => {
    const { socket, score } = await withScore();
    const scope = effectScope();
    const used = scope.run(() => useReplicant(score)) as ReturnType<typeof useReplicant<Score>>;

    void used.set({ home: 2, away: 2 });
    void used.update((draft) => {
      draft.away++;
    });
    await tick();

    const ops = socket().sent.filter((msg) => msg.t === 'rep.op');
    expect(ops).toMatchObject([
      { patches: [{ op: 'replace', path: '', value: { home: 2, away: 2 } }] },
      { baseRev: 0, patches: [{ op: 'replace', path: '/away', value: 1 }] },
    ]);
    scope.stop();
  });
});
