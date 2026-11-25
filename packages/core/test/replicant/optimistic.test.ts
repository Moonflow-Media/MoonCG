import { describe, expect, it } from 'vitest';
import type { Json } from '../../src/json.js';
import { opForWrite, type PendingWrite, rebaseWrites } from '../../src/replicant/optimistic.js';

interface Score {
  home: number;
  away: number;
}

const increment = (key: keyof Score): PendingWrite => ({
  kind: 'update',
  recipe: (draft) => {
    (draft as Score)[key] += 1;
  },
});

describe('rebaseWrites', () => {
  it('returns the base itself when nothing is pending', () => {
    const base = Object.freeze({ home: 1, away: 2 });
    const result = rebaseWrites(base, []);
    expect(result.value).toBe(base);
    expect(result.failed).toEqual([]);
  });

  it('applies sets and recipes in order on top of the base', () => {
    const result = rebaseWrites({ home: 0, away: 0 }, [
      increment('home'),
      { kind: 'set', value: { home: 10, away: 0 } },
      increment('away'),
      increment('home'),
    ]);
    expect(result.value).toEqual({ home: 11, away: 1 });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it('re-runs recipes on a newer base, which is what a rebase is', () => {
    const writes = [increment('home'), increment('home')];
    expect(rebaseWrites({ home: 0, away: 0 }, writes).value).toEqual({ home: 2, away: 0 });
    expect(rebaseWrites({ home: 5, away: 3 }, writes).value).toEqual({ home: 7, away: 3 });
  });

  it('skips and reports a write whose recipe throws or does not fit', () => {
    const throwing: PendingWrite = {
      kind: 'update',
      recipe: () => {
        throw new Error('boom');
      },
    };
    const result = rebaseWrites({ home: 0, away: 0 }, [throwing, increment('home')]);
    expect(result.value).toEqual({ home: 1, away: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(0);
    expect(String(result.failed[0]?.error)).toMatch(/boom/);
  });

  it('reports a set whose value is not JSON', () => {
    const result = rebaseWrites({ home: 0 }, [
      { kind: 'set', value: { at: new Date() } as unknown as Json },
    ]);
    expect(result.value).toEqual({ home: 0 });
    expect(result.failed.map((failure) => failure.index)).toEqual([0]);
  });
});

describe('opForWrite', () => {
  it('sends a set as a last-write-wins replacement of the whole value', () => {
    expect(opForWrite({ kind: 'set', value: { home: 3 } }, { home: 1 }, 7)).toEqual({
      patches: [{ op: 'replace', path: '', value: { home: 3 } }],
    });
  });

  it('runs a recipe on the server value and names the revision it is based on', () => {
    expect(opForWrite(increment('away'), { home: 1, away: 1 }, 7)).toEqual({
      baseRev: 7,
      patches: [{ op: 'replace', path: '/away', value: 2 }],
    });
  });

  it('returns undefined for a recipe that changes nothing', () => {
    expect(opForWrite({ kind: 'update', recipe: () => {} }, { home: 1 }, 0)).toBeUndefined();
  });
});
