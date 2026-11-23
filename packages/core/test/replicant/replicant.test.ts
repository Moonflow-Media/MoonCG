import { describe, expect, it, vi } from 'vitest';
import { Replicant } from '../../src/replicant/replicant.js';

const score = () => new Replicant({ initial: { home: 0, away: 0 } });

describe('Replicant', () => {
  it('starts at rev 0 with a frozen snapshot of the initial value', () => {
    const rep = score();
    expect(rep.rev).toBe(0);
    expect(rep.value).toEqual({ home: 0, away: 0 });
    expect(Object.isFrozen(rep.value)).toBe(true);
  });

  it('commits an op on the current rev and returns the patches to broadcast', () => {
    const rep = score();
    const patches = [{ op: 'replace', path: '/home', value: 1 }] as const;

    const result = rep.applyOp({ baseRev: 0, patches });

    expect(result).toEqual({ ok: true, rev: 1, patches });
    expect(rep.rev).toBe(1);
    expect(rep.value).toEqual({ home: 1, away: 0 });
    expect(Object.isFrozen(rep.value)).toBe(true);
  });

  it('rejects a stale baseRev with conflict and leaves state untouched', () => {
    const rep = score();
    rep.applyOp({ baseRev: 0, patches: [{ op: 'replace', path: '/home', value: 1 }] });
    const before = rep.value;

    const result = rep.applyOp({
      baseRev: 0,
      patches: [{ op: 'replace', path: '/home', value: 7 }],
    });

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(rep.rev).toBe(1);
    expect(rep.value).toBe(before);
  });

  it('applies an op without baseRev as last-write-wins', () => {
    const rep = score();
    rep.applyOp({ baseRev: 0, patches: [{ op: 'replace', path: '/home', value: 1 }] });

    const result = rep.applyOp({
      patches: [{ op: 'replace', path: '', value: { home: 9, away: 9 } }],
    });

    expect(result).toMatchObject({ ok: true, rev: 2 });
    expect(rep.value).toEqual({ home: 9, away: 9 });
  });

  it('rejects a patch that does not apply with bad_request, atomically', () => {
    const rep = score();

    const result = rep.applyOp({
      baseRev: 0,
      patches: [
        { op: 'replace', path: '/home', value: 1 },
        { op: 'remove', path: '/missing' },
      ],
    });

    expect(result).toMatchObject({ ok: false, code: 'bad_request' });
    expect(rep.rev).toBe(0);
    expect(rep.value).toEqual({ home: 0, away: 0 });
  });

  it('rejects with invalid when the injected validator reports errors', () => {
    const validate = vi.fn((value: unknown) =>
      (value as { home: number }).home < 0 ? ['home must be >= 0'] : null,
    );
    const rep = new Replicant({ initial: { home: 0 }, validate });

    const bad = rep.applyOp({ baseRev: 0, patches: [{ op: 'replace', path: '/home', value: -1 }] });
    const good = rep.applyOp({ baseRev: 0, patches: [{ op: 'replace', path: '/home', value: 1 }] });

    expect(bad).toEqual({ ok: false, code: 'invalid', message: 'home must be >= 0' });
    expect(validate).toHaveBeenCalledWith({ home: -1 });
    expect(good).toMatchObject({ ok: true, rev: 1 });
    expect(rep.value).toEqual({ home: 1 });
  });

  it('notifies commit listeners until they unsubscribe, and not on rejection', () => {
    const rep = score();
    const listener = vi.fn();
    const off = rep.onCommit(listener);
    const patches = [{ op: 'replace', path: '/away', value: 3 }] as const;

    rep.applyOp({ baseRev: 0, patches });
    rep.applyOp({ baseRev: 0, patches });
    off();
    rep.applyOp({ patches });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ rev: 1, patches, value: { home: 0, away: 3 } });
  });

  it('delivers commits to every listener in rev order when a listener writes', () => {
    const rep = score();
    const seenByFirst: number[] = [];
    const seenByLast: number[] = [];
    rep.onCommit(({ rev }) => {
      seenByFirst.push(rev);
      if (rev === 1) rep.applyOp({ patches: [{ op: 'replace', path: '/away', value: 1 }] });
    });
    rep.onCommit(({ rev }) => seenByLast.push(rev));

    rep.applyOp({ patches: [{ op: 'replace', path: '/home', value: 1 }] });

    expect(rep.rev).toBe(2);
    expect(seenByFirst).toEqual([1, 2]);
    expect(seenByLast).toEqual([1, 2]);
  });
});
