import { describe, expect, it } from 'vitest';
import { applyPatches, deepFreeze, PatchError, producePatches } from '../../src/replicant/patch.js';

describe('applyPatches', () => {
  it('replaces the root value with an empty path', () => {
    expect(applyPatches({ a: 1 }, [{ op: 'replace', path: '', value: [1, 2] }])).toEqual([1, 2]);
  });

  it('adds, replaces and removes object members', () => {
    const next = applyPatches({ home: 1, away: 2 }, [
      { op: 'replace', path: '/home', value: 5 },
      { op: 'add', path: '/period', value: 'first' },
      { op: 'remove', path: '/away' },
    ]);
    expect(next).toEqual({ home: 5, period: 'first' });
  });

  it('inserts into, appends to and removes from arrays', () => {
    const next = applyPatches({ list: ['a', 'c'] }, [
      { op: 'add', path: '/list/1', value: 'b' },
      { op: 'add', path: '/list/-', value: 'd' },
      { op: 'remove', path: '/list/0' },
    ]);
    expect(next).toEqual({ list: ['b', 'c', 'd'] });
  });

  it('reaches nested values and unescapes JSON Pointer tokens', () => {
    const next = applyPatches({ 'a/b': { 'c~d': [{ x: 1 }] } }, [
      { op: 'replace', path: '/a~1b/c~0d/0/x', value: 2 },
    ]);
    expect(next).toEqual({ 'a/b': { 'c~d': [{ x: 2 }] } });
  });

  it('does not mutate its input and shares untouched branches', () => {
    const base = deepFreeze({ a: { n: 1 }, b: { n: 2 } });
    const next = applyPatches(base, [{ op: 'replace', path: '/a/n', value: 9 }]) as typeof base;
    expect(base.a.n).toBe(1);
    expect(next.a.n).toBe(9);
    expect(next.b).toBe(base.b);
  });

  it.each([
    ['a path without a leading slash', { op: 'replace', path: 'home', value: 1 }],
    ['replacing a missing member', { op: 'replace', path: '/missing', value: 1 }],
    ['removing a missing member', { op: 'remove', path: '/missing' }],
    ['removing the root', { op: 'remove', path: '' }],
    ['a missing parent', { op: 'add', path: '/missing/child', value: 1 }],
    ['descending into a primitive', { op: 'add', path: '/home/child', value: 1 }],
    ['an array index out of range', { op: 'add', path: '/list/5', value: 1 }],
    ['a non-numeric array index', { op: 'replace', path: '/list/x', value: 1 }],
    ['replacing past the end of an array', { op: 'replace', path: '/list/1', value: 1 }],
  ] as const)('rejects %s', (_label, patch) => {
    expect(() => applyPatches({ home: 1, list: ['a'] }, [patch])).toThrow(PatchError);
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });
});

interface Doc {
  list: string[];
  extra?: boolean;
  added?: { deep: number[] };
  nested: Record<string, number>;
}

describe('producePatches', () => {
  it('turns a recipe into JSON Patch operations with JSON Pointer paths', () => {
    const patches = producePatches({ home: 1, away: 0 }, (draft) => {
      draft.home++;
    });
    expect(patches).toEqual([{ op: 'replace', path: '/home', value: 2 }]);
  });

  it('returns no patches when the recipe changes nothing', () => {
    expect(producePatches({ home: 1 }, () => {})).toEqual([]);
  });

  it('works on a frozen base without changing it', () => {
    const base = deepFreeze({ list: [1, 2, 3] });
    producePatches(base, (draft) => {
      draft.list.push(4);
    });
    expect(base.list).toEqual([1, 2, 3]);
  });

  const recipes: [string, (d: Doc) => void][] = [
    ['push', (d) => void d.list.push('x')],
    ['pop', (d) => void d.list.pop()],
    ['shift', (d) => void d.list.shift()],
    ['splice', (d) => void d.list.splice(1, 1, 'x', 'y')],
    [
      'truncate',
      (d) => {
        d.list.length = 0;
      },
    ],
    [
      'delete member',
      (d) => {
        delete d.extra;
      },
    ],
    [
      'add member',
      (d) => {
        d.added = { deep: [1] };
      },
    ],
    [
      'escaped keys',
      (d) => {
        d.nested['a/b~c'] = 1;
      },
    ],
    [
      'nested change',
      (d) => {
        d.nested.count = 2;
      },
    ],
  ];

  it.each(recipes)('produces patches that applyPatches replays: %s', (_label, recipe) => {
    const base: Doc = { list: ['a', 'b', 'c'], extra: true, nested: { count: 1 } };
    const expected = structuredClone(base);
    recipe(expected);

    const patches = producePatches(base, recipe);

    for (const patch of patches) {
      expect(['add', 'remove', 'replace']).toContain(patch.op);
      expect(typeof patch.path).toBe('string');
    }
    expect(applyPatches(base as never, patches)).toEqual(expected);
  });
});
