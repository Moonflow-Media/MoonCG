import { describe, expect, it } from 'vitest';
import { MoonCGError } from '../../src/errors.js';
import { Replicant, type ReplicantOp } from '../../src/replicant/replicant.js';
import { MAX_UPDATE_RETRIES, updateWithRetry } from '../../src/replicant/update.js';

interface Score {
  home: number;
}

/** Submits to a real engine, optionally letting a competing writer in first. */
function harness(competingWrites: number) {
  const rep = new Replicant({ initial: { home: 0 } });
  const submitted: ReplicantOp[] = [];
  let remaining = competingWrites;
  const submit = async (op: ReplicantOp) => {
    submitted.push(op);
    if (remaining > 0) {
      remaining--;
      rep.applyOp({ patches: [{ op: 'replace', path: '/home', value: rep.rev + 100 }] });
    }
    const result = rep.applyOp(op);
    if (!result.ok) throw new MoonCGError(result.code, result.message);
  };
  const read = () => ({ value: rep.value as unknown as Score, rev: rep.rev });
  return { rep, submitted, submit, read };
}

const increment = (draft: Score) => {
  draft.home++;
};

describe('updateWithRetry', () => {
  it('submits the recipe patches against the current rev', async () => {
    const h = harness(0);
    await updateWithRetry(h.read, h.submit, increment);
    expect(h.submitted).toEqual([
      { baseRev: 0, patches: [{ op: 'replace', path: '/home', value: 1 }] },
    ]);
    expect(h.rep.value).toEqual({ home: 1 });
  });

  it('sends nothing when the recipe changes nothing', async () => {
    const h = harness(0);
    await updateWithRetry(h.read, h.submit, () => {});
    expect(h.submitted).toEqual([]);
  });

  it('re-runs the recipe on the fresh value after a conflict', async () => {
    const h = harness(1);
    await updateWithRetry(h.read, h.submit, increment);
    expect(h.submitted).toHaveLength(2);
    expect(h.rep.value).toEqual({ home: 101 });
  });

  it('gives up with conflict after the maximum number of re-runs', async () => {
    const h = harness(Number.POSITIVE_INFINITY);
    await expect(updateWithRetry(h.read, h.submit, increment)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(h.submitted).toHaveLength(1 + MAX_UPDATE_RETRIES);
    expect(MAX_UPDATE_RETRIES).toBe(3);
  });

  it('does not retry other errors', async () => {
    const h = harness(0);
    const failing = async () => {
      throw new MoonCGError('forbidden', 'no');
    };
    await expect(updateWithRetry(h.read, failing, increment)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
