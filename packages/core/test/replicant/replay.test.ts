import { describe, expect, it } from 'vitest';
import type { Json } from '../../src/json.js';
import { applyPatches, type PatchOp, producePatches } from '../../src/replicant/patch.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import {
  REPLAY_BUFFER_BYTES,
  REPLAY_BUFFER_SIZE,
  Replicant,
} from '../../src/replicant/replicant.js';

/** Makes the value large enough that replaying a few small patches is cheaper than a snapshot. */
const PAD = 'x'.repeat(20_000);
const padded = (options: { rev?: number; epoch?: string } = {}) =>
  new Replicant({ initial: { n: 0, pad: PAD }, ...options });
const bump = (rep: Replicant, n: number) =>
  rep.applyOp({ patches: [{ op: 'replace', path: '/n', value: n }] });
const size = (value: unknown) => JSON.stringify(value).length;

describe('Replicant revision and epoch', () => {
  it('starts at a restored revision and carries its epoch', () => {
    const rep = padded({ rev: 41, epoch: 'boot-7' });
    expect(rep.rev).toBe(41);
    expect(rep.epoch).toBe('boot-7');
    expect(bump(rep, 1)).toMatchObject({ ok: true, rev: 42 });
  });

  it('rejects a restored revision that is not a non-negative integer', () => {
    expect(() => new Replicant({ initial: 0, rev: -1 })).toThrow(/rev/);
    expect(() => new Replicant({ initial: 0, rev: 1.5 })).toThrow(/rev/);
  });

  it('reports whether it was closed', () => {
    const rep = new Replicant({ initial: 0 });
    expect(rep.closed).toBe(false);
    rep.close();
    expect(rep.closed).toBe(true);
  });

  it('gets its restored revision and an epoch of its own from the registry', () => {
    const epochs = ['first', 'second', 'third'];
    const registry = new ReplicantRegistry({ createEpoch: () => epochs.shift() as string });

    const a = registry.declare('b', 'a', { initial: 1, rev: 5 }).replicant;
    const other = registry.declare('b', 'other', { initial: 1 }).replicant;
    registry.undeclare('b');
    const again = registry.declare('b', 'a', { initial: 2, rev: 5 }).replicant;

    expect(a.rev).toBe(5);
    expect([a.epoch, other.epoch, again.epoch]).toEqual(['first', 'second', 'third']);
  });

  it('never repeats an epoch within a registry by default', () => {
    const registry = new ReplicantRegistry();
    const first = registry.declare('b', 'n', { initial: 1 }).replicant.epoch;
    registry.undeclare('b');
    const second = registry.declare('b', 'n', { initial: 1 }).replicant.epoch;
    expect(second).not.toBe(first);
  });
});

describe('Replicant.patchesSince', () => {
  it('returns nothing to replay for the current revision', () => {
    const rep = padded();
    bump(rep, 1);
    expect(rep.patchesSince(1)).toEqual([]);
  });

  it('returns the commits after the given revision, in order', () => {
    const rep = padded();
    for (let n = 1; n <= 3; n++) bump(rep, n);
    expect(rep.patchesSince(1)).toEqual([
      { rev: 2, patches: [{ op: 'replace', path: '/n', value: 2 }] },
      { rev: 3, patches: [{ op: 'replace', path: '/n', value: 3 }] },
    ]);
  });

  it('cannot replay for a revision ahead of its own', () => {
    const rep = padded();
    bump(rep, 1);
    expect(rep.patchesSince(2)).toBeUndefined();
  });

  it('cannot replay commits made before it was restored', () => {
    const rep = padded({ rev: 10 });
    bump(rep, 1);
    expect(rep.patchesSince(10)).toHaveLength(1);
    expect(rep.patchesSince(9)).toBeUndefined();
  });

  it('keeps at most the last 100 commits', () => {
    const rep = padded();
    for (let n = 1; n <= REPLAY_BUFFER_SIZE + 5; n++) bump(rep, n);

    expect(REPLAY_BUFFER_SIZE).toBe(100);
    expect(rep.patchesSince(5)).toHaveLength(100);
    expect(rep.patchesSince(4)).toBeUndefined();
  });

  it('declines to replay when the patches are larger than the value itself', () => {
    const rep = new Replicant({ initial: { n: 0 } });
    for (let n = 1; n <= 3; n++) bump(rep, n);

    // Each patch is longer than `{"n":3}`, so a snapshot is the cheaper answer.
    expect(rep.patchesSince(2)).toBeUndefined();
    expect(rep.patchesSince(3)).toEqual([]);
  });

  it('replays whole-value replacements only while that is cheaper than a snapshot', () => {
    const rep = padded();
    const replaceAll = (n: number) =>
      rep.applyOp({ patches: [{ op: 'replace', path: '', value: { n, pad: PAD } }] });
    replaceAll(1);
    replaceAll(2);

    expect(rep.patchesSince(1)).toBeUndefined();
    expect(rep.patchesSince(0)).toBeUndefined();
  });

  it('bounds the buffer by the size of its patches, not only their number', () => {
    const big = 'y'.repeat(REPLAY_BUFFER_BYTES / 4);
    const rep = new Replicant({ initial: { slots: {} as Record<string, string>, pad: '' } });
    // Each commit adds a quarter of the byte cap; the value grows, so replay stays worthwhile.
    for (let slot = 1; slot <= 8; slot++) {
      rep.applyOp({ patches: [{ op: 'add', path: `/slots/s${slot}`, value: big }] });
    }

    expect(REPLAY_BUFFER_BYTES).toBe(1024 * 1024);
    expect(rep.patchesSince(6)).toHaveLength(2);
    expect(rep.patchesSince(5)).toHaveLength(3);
    expect(rep.patchesSince(4)).toBeUndefined();
  });

  it('keeps no history for a single commit larger than the byte cap', () => {
    const rep = new Replicant({ initial: { text: '' } });
    rep.applyOp({
      patches: [{ op: 'replace', path: '/text', value: 'z'.repeat(REPLAY_BUFFER_BYTES + 1) }],
    });
    expect(rep.patchesSince(0)).toBeUndefined();
    expect(rep.patchesSince(1)).toEqual([]);
  });
});

/** A small deterministic generator, so a failing case can be reproduced from its seed. */
function random(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % below;
  };
}

interface Doc {
  count: number;
  list: number[];
  tags: Record<string, string>;
  nested: { on: boolean; deep: { values: string[] } };
  pad: string;
}

/** Applies one random edit through a recipe, as `update()` would. */
function randomEdit(next: (below: number) => number): (draft: Doc) => void {
  const pick = next(9);
  const value = next(1000);
  return (draft) => {
    if (pick === 0) draft.count += value;
    else if (pick === 1) draft.list.push(value);
    else if (pick === 2) draft.list.shift();
    else if (pick === 3) draft.list.splice(next(draft.list.length + 1), next(3), value, value + 1);
    else if (pick === 4) draft.tags[`tag${value % 7}`] = String(value);
    else if (pick === 5) delete draft.tags[`tag${value % 7}`];
    else if (pick === 6) draft.nested.on = !draft.nested.on;
    else if (pick === 7) draft.nested.deep.values.unshift(`v${value}`);
    else draft.list.length = Math.min(draft.list.length, value % 4);
  };
}

describe('patch replay equivalence', () => {
  it.each(Array.from({ length: 25 }, (_, index) => index + 1))(
    'replaying the buffered patches onto an old snapshot gives the current value (seed %i)',
    (seed) => {
      const next = random(seed);
      const initial: Doc = {
        count: 0,
        list: [1, 2, 3],
        tags: {},
        nested: { on: false, deep: { values: [] } },
        // Half the seeds use a small value, where a snapshot soon beats replaying.
        pad: seed % 2 === 0 ? '' : PAD,
      };
      const rep = new Replicant({ initial: initial as unknown as Json });
      const snapshots: Json[] = [rep.value];
      const patchSizes: number[] = [0];

      const edits = 20 + next(160);
      for (let edit = 0; edit < edits; edit++) {
        const patches: PatchOp[] = producePatches(rep.value as unknown as Doc, randomEdit(next));
        if (patches.length === 0) continue;
        expect(rep.applyOp({ baseRev: rep.rev, patches }).ok).toBe(true);
        snapshots[rep.rev] = rep.value;
        patchSizes[rep.rev] = size(patches);
      }

      let replayed = 0;
      for (let since = 0; since <= rep.rev; since++) {
        const missed = rep.patchesSince(since);
        const missedSize = patchSizes.slice(since + 1).reduce((sum, bytes) => sum + bytes, 0);
        if (missed === undefined) {
          // Declining is only right when the buffer is too short or a snapshot is smaller.
          expect(rep.rev - since > REPLAY_BUFFER_SIZE || missedSize > size(rep.value)).toBe(true);
          continue;
        }
        replayed++;
        expect(missed.map((commit) => commit.rev)).toEqual(
          Array.from({ length: rep.rev - since }, (_, index) => since + index + 1),
        );
        expect(missedSize).toBeLessThanOrEqual(size(rep.value));
        expect(
          missed.reduce(
            (value, commit) => applyPatches(value, commit.patches),
            snapshots[since] as Json,
          ),
        ).toEqual(rep.value);
      }
      // With a large value, replaying is the rule; with a small one it is the exception.
      expect(replayed).toBeGreaterThan(initial.pad === '' ? 0 : 10);
    },
  );
});
