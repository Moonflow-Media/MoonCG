import { MoonCGError } from '../errors.js';
import { producePatches, type Recipe } from './patch.js';
import type { ReplicantOp } from './replicant.js';

/** How often `update()` re-runs its recipe after a conflict before giving up. */
export const MAX_UPDATE_RETRIES = 3;

/**
 * Shared by every replicant handle (browser client, extension context): runs the recipe on the
 * current value, submits the patches with `baseRev`, and starts over on `conflict`.
 * `submit` must reject with a `MoonCGError`, and `read` must see the newer state by then.
 */
export async function updateWithRetry<T>(
  read: () => { value: T; rev: number },
  submit: (op: ReplicantOp) => Promise<void>,
  recipe: Recipe<T>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const { value, rev } = read();
    const patches = producePatches(value, recipe);
    if (patches.length === 0) return;
    try {
      await submit({ baseRev: rev, patches });
      return;
    } catch (error) {
      const isConflict = error instanceof MoonCGError && error.code === 'conflict';
      if (!isConflict || attempt >= MAX_UPDATE_RETRIES) throw error;
    }
  }
}
