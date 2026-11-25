import { type Json, jsonProblem } from '../json.js';
import { applyPatches, deepFreeze, producePatches, type Recipe } from './patch.js';
import type { ReplicantOp } from './replicant.js';

/**
 * How many writes an optimistic replicant keeps waiting for the server at most. Further ones
 * are refused as `unavailable` until the server has caught up. Sets that wait one after the
 * other count once: only the last of them is sent.
 */
export const MAX_PENDING_WRITES = 1000;

/**
 * A write an optimistic replicant shows at once and sends to the server when its turn comes.
 * A `set` replaces the whole value (last write wins); an `update` keeps its recipe, so that it
 * can be run again on whatever the server's value is by then.
 */
export type PendingWrite =
  | { readonly kind: 'set'; readonly value: Json }
  | { readonly kind: 'update'; readonly recipe: Recipe<unknown> };

export interface RebaseResult {
  /** The base with every write that fits applied in order. Frozen. */
  readonly value: Json;
  /** The writes that could not be applied, by their position, and why. */
  readonly failed: readonly { readonly index: number; readonly error: unknown }[];
}

/**
 * Applies the pending writes, in order, on top of the value the server confirmed. This is what
 * an optimistic replicant shows, and it is worked out again whenever the server's value changes
 * or a write is confirmed or refused: the remaining writes are rebased on the newer value.
 * Recipes therefore run more than once and must not have side effects. A write that does not
 * fit (its recipe throws, its patches do not apply, its value is not JSON) is skipped.
 */
export function rebaseWrites(base: Json, writes: readonly PendingWrite[]): RebaseResult {
  let value = base;
  const failed: { index: number; error: unknown }[] = [];
  writes.forEach((write, index) => {
    try {
      value = applyWrite(value, write);
    } catch (error) {
      failed.push({ index, error });
    }
  });
  return { value: value === base ? base : deepFreeze(value), failed };
}

/**
 * The op that sends a write, worked out against the server's value and revision at the moment it
 * is sent. A recipe gets `baseRev`, so that the server refuses it with `conflict` when the value
 * changed in between; a set does not. `undefined` when the write changes nothing.
 */
export function opForWrite(write: PendingWrite, base: Json, rev: number): ReplicantOp | undefined {
  if (write.kind === 'set') return { patches: [{ op: 'replace', path: '', value: write.value }] };
  const patches = producePatches(base, write.recipe as Recipe<Json>);
  return patches.length === 0 ? undefined : { baseRev: rev, patches };
}

function applyWrite(value: Json, write: PendingWrite): Json {
  if (write.kind === 'set') {
    const problem = jsonProblem(write.value);
    if (problem !== null) throw new Error(`The value is not valid JSON: ${problem}`);
    return write.value;
  }
  const patches = producePatches(value, write.recipe as Recipe<Json>);
  return patches.length === 0 ? value : applyPatches(value, patches);
}
