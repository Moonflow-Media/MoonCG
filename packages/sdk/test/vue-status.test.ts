import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isReadonly } from 'vue';
import { useReplicant } from '../src/vue/index.js';
import { NAME, withScore } from './fake-socket.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const gone = { t: 'rep.gone', name: NAME, message: 'Replicant was removed' } as const;
const patchHome = (value: number, rev: number) =>
  ({
    t: 'rep.patch',
    name: NAME,
    rev,
    patches: [{ op: 'replace', path: '/home', value }],
  }) as const;

describe('useReplicant (Vue) error and stop', () => {
  it('exposes the handle error as a readonly ref that follows it', async () => {
    const { socket, score } = await withScore();
    const scope = effectScope();
    const { error } = scope.run(() => useReplicant(score)) as ReturnType<
      typeof useReplicant<{ home: number; away: number }>
    >;
    expect(error.value).toBeUndefined();
    expect(isReadonly(error)).toBe(true);

    socket().receive(gone);

    expect(error.value).toMatchObject({ code: 'not_found', message: 'Replicant was removed' });
    expect(error.value).toBe(score.error);
    scope.stop();
  });

  it('stops following the error when its scope stops', async () => {
    const { socket, score } = await withScore();
    const scope = effectScope();
    const { error } = scope.run(() => useReplicant(score)) as ReturnType<
      typeof useReplicant<{ home: number; away: number }>
    >;

    scope.stop();
    socket().receive(gone);

    expect(score.error).toBeDefined();
    expect(error.value).toBeUndefined();
  });

  it('works outside an effect scope without a warning, and stops on request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { socket, score } = await withScore();

    const { data, error, stop } = useReplicant(score);
    socket().receive(patchHome(2, 1));
    expect(data.value).toEqual({ home: 2, away: 0 });

    stop();
    socket().receive(patchHome(3, 2));
    socket().receive(gone);

    expect(warn).not.toHaveBeenCalled();
    expect(data.value).toEqual({ home: 2, away: 0 });
    expect(error.value).toBeUndefined();
  });

  it('can be stopped by hand inside a scope, and again by the scope without harm', async () => {
    const { socket, score } = await withScore();
    const scope = effectScope();
    const { data, stop } = scope.run(() => useReplicant(score)) as ReturnType<
      typeof useReplicant<{ home: number; away: number }>
    >;

    stop();
    socket().receive(patchHome(2, 1));

    expect(data.value).toEqual({ home: 0, away: 0 });
    expect(() => scope.stop()).not.toThrow();
  });
});
