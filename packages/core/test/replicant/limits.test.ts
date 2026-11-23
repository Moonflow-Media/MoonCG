import { describe, expect, it, vi } from 'vitest';
import { type Json, MAX_JSON_DEPTH } from '../../src/json.js';
import { applyPatches, PatchError } from '../../src/replicant/patch.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import { Replicant } from '../../src/replicant/replicant.js';
import { nest } from '../nest.js';

const score = () => new Replicant({ initial: { home: 0, away: 0 } });
const replaceRoot = (value: unknown) => ({
  patches: [{ op: 'replace' as const, path: '', value: value as Json }],
});

describe('applyPatches limits', () => {
  it.each([
    ['add', '/__proto__'],
    ['replace', '/__proto__'],
    ['add', '/a/__proto__'],
    ['add', '/__proto__/polluted'],
    ['remove', '/__proto__'],
  ] as const)('rejects %s at %s', (op, path) => {
    const patch = op === 'remove' ? { op, path } : { op, path, value: { polluted: true } };
    expect(() => applyPatches({ a: {} }, [patch])).toThrow(PatchError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('stores "constructor" and "prototype" as ordinary own members', () => {
    const next = applyPatches({}, [
      { op: 'add', path: '/constructor', value: 1 },
      { op: 'add', path: '/prototype', value: { x: 2 } },
    ]) as Record<string, unknown>;

    expect(Object.hasOwn(next, 'constructor')).toBe(true);
    expect(JSON.parse(JSON.stringify(next))).toEqual({ constructor: 1, prototype: { x: 2 } });
    expect({}.constructor).toBe(Object);
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a nested function', { a: [() => {}] }],
  ])('rejects %s as a patch value', (_label, value) => {
    expect(() => applyPatches({}, [{ op: 'add', path: '/x', value: value as Json }])).toThrow(
      PatchError,
    );
  });

  it('counts the path towards the depth limit', () => {
    const base = { a: { b: {} } };
    const fits = nest(MAX_JSON_DEPTH - 3);
    const tooDeep = nest(MAX_JSON_DEPTH - 2);

    expect(() => applyPatches(base, [{ op: 'add', path: '/a/b/c', value: fits }])).not.toThrow();
    expect(() => applyPatches(base, [{ op: 'add', path: '/a/b/c', value: tooDeep }])).toThrow(
      PatchError,
    );
  });
});

describe('Replicant limits', () => {
  it('rejects a value nested 100,000 levels with bad_request instead of overflowing', () => {
    const rep = score();
    const result = rep.applyOp(replaceRoot(nest(100_000)));
    expect(result).toMatchObject({ ok: false, code: 'bad_request' });
    expect(rep.rev).toBe(0);
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['a Date', new Date(0)],
    ['a Map', new Map([['a', 1]])],
  ])('rejects %s with bad_request and keeps the value', (_label, value) => {
    const rep = score();
    expect(rep.applyOp(replaceRoot(value))).toMatchObject({ ok: false, code: 'bad_request' });
    expect(rep.value).toEqual({ home: 0, away: 0 });
    expect(rep.rev).toBe(0);
  });

  it('refuses an initial value that is not JSON', () => {
    expect(() => new Replicant({ initial: undefined as unknown as Json })).toThrow(/JSON/);
    expect(() => new Replicant({ initial: nest(MAX_JSON_DEPTH + 1) })).toThrow(/64/);
  });

  it('treats an op without patches as a no-op that reports the current rev', () => {
    const rep = score();
    rep.applyOp(replaceRoot({ home: 1, away: 0 }));
    const listener = vi.fn();
    rep.onCommit(listener);

    expect(rep.applyOp({ patches: [] })).toEqual({ ok: true, rev: 1, patches: [] });
    expect(rep.applyOp({ baseRev: 1, patches: [] })).toEqual({ ok: true, rev: 1, patches: [] });
    expect(rep.applyOp({ baseRev: 0, patches: [] })).toMatchObject({ ok: false, code: 'conflict' });
    expect(rep.rev).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener and reports it through onError', () => {
    const onError = vi.fn();
    const rep = new Replicant({ initial: { home: 0 }, onError });
    const failure = new Error('listener failure');
    const seen: number[] = [];
    rep.onCommit(() => {
      throw failure;
    });
    rep.onCommit(({ rev }) => seen.push(rev));

    const first = rep.applyOp(replaceRoot({ home: 1 }));
    const second = rep.applyOp(replaceRoot({ home: 2 }));

    expect(first).toMatchObject({ ok: true, rev: 1 });
    expect(second).toMatchObject({ ok: true, rev: 2 });
    expect(seen).toEqual([1, 2]);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('does not throw for a failing listener when no onError is given', () => {
    const rep = score();
    rep.onCommit(() => {
      throw new Error('ignored');
    });
    expect(rep.applyOp(replaceRoot({ home: 1, away: 1 }))).toMatchObject({ ok: true });
  });

  it('rejects ops with not_found after close and tells its close listeners once', () => {
    const rep = score();
    const onCommit = vi.fn();
    const onClose = vi.fn();
    const removed = vi.fn();
    rep.onCommit(onCommit);
    rep.onClose(onClose);
    rep.onClose(removed)();

    rep.close();
    rep.close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(rep.applyOp(replaceRoot({ home: 1, away: 1 }))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('ReplicantRegistry.undeclare', () => {
  it('removes and closes every replicant of one bundle', () => {
    const registry = new ReplicantRegistry();
    const { replicant } = registry.declare('crashy', 'state', { initial: 1 });
    registry.declare('crashy', 'other', { initial: 2 });
    registry.declare('good', 'score', { initial: 3 });
    const onClose = vi.fn();
    replicant.onClose(onClose);

    registry.undeclare('crashy');

    expect(registry.get('crashy:state')).toBeUndefined();
    expect(registry.get('crashy:other')).toBeUndefined();
    expect(registry.get('good:score')).toBeDefined();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(replicant.applyOp(replaceRoot(5))).toMatchObject({ ok: false, code: 'not_found' });
    expect(() => registry.declare('crashy', 'state', { initial: 1 })).not.toThrow();
  });

  it('does not touch a bundle whose name merely starts the same', () => {
    const registry = new ReplicantRegistry();
    registry.declare('score', 'a', { initial: 1 });
    registry.declare('scoreboard', 'a', { initial: 1 });

    registry.undeclare('score');

    expect(registry.get('scoreboard:a')).toBeDefined();
  });

  it('reports failing commit listeners with the replicant name', () => {
    const onListenerError = vi.fn();
    const registry = new ReplicantRegistry({ onListenerError });
    const { replicant } = registry.declare('good', 'score', { initial: 1 });
    const failure = new Error('boom');
    replicant.onCommit(() => {
      throw failure;
    });

    replicant.applyOp(replaceRoot(2));

    expect(onListenerError).toHaveBeenCalledExactlyOnceWith('good:score', failure);
  });
});
