import type { Replicant } from '@mooncg/core';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { ReplicantStore, StoredReplicant } from '../storage/replicant-store.js';

/** A changed replicant is saved once it has been quiet for this long... */
export const DEBOUNCE_MS = 250;
/** ...and at the latest this long after its first unsaved change. */
export const MAX_WAIT_MS = 1000;
/** A failed save is tried again after this long, doubling with each further failure... */
export const RETRY_MIN_MS = 1000;
/** ...up to this long. */
export const RETRY_MAX_MS = 30_000;

/** The clock, injected so tests can drive it. */
export interface Timers {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PersistenceOptions {
  readonly store: ReplicantStore;
  readonly logger: Logger;
  readonly timers?: Timers;
}

export interface ReplicantPersistence {
  /** The stored record of a replicant, if there is a readable one. */
  restore(bundle: string, name: string): Promise<StoredReplicant | undefined>;
  /**
   * Saves the replicant write-behind from now on, and at once when it is closed. `savedRev` is
   * the revision the store already holds; a replicant that is past it is saved soon. Track a
   * replicant only once its bundle runs, so a bundle that fails to start leaves nothing behind.
   */
  track(bundle: string, name: string, replicant: Replicant, savedRev?: number): void;
  /** Saves everything that changed, now. Resolves when the attempt is over. */
  flush(): Promise<void>;
}

interface Tracked {
  readonly bundle: string;
  readonly name: string;
  readonly replicant: Replicant;
}

/** Writes persistent replicants to the store, write-behind, so commits never wait for disk. */
export function createPersistence(options: PersistenceOptions): ReplicantPersistence {
  const { store, logger } = options;
  const timers = options.timers ?? systemTimers;
  const dirty = new Set<Tracked>();
  let timer: unknown;
  let firstChangeAt: number | undefined;
  let saving: Promise<void> = Promise.resolve();
  /** Failed saves in a row. While above zero, the timer is the retry and changes do not move it. */
  let failures = 0;

  const flush = (): Promise<void> => {
    timers.clearTimeout(timer);
    firstChangeAt = undefined;
    if (dirty.size === 0) return saving;
    const batch = [...dirty];
    dirty.clear();
    // Saves run one after another; each writes the values as they are when its turn comes.
    saving = saving.then(async () => {
      const records = batch.map(({ bundle, name, replicant }) => ({
        bundle,
        name,
        rev: replicant.rev,
        value: replicant.value,
      }));
      try {
        await store.save(records);
        failures = 0;
      } catch (error) {
        for (const tracked of batch) dirty.add(tracked);
        const wait = Math.min(RETRY_MIN_MS * 2 ** failures, RETRY_MAX_MS);
        failures++;
        logger.error(
          `Could not save ${records.length} replicant(s), retrying in ${wait / 1000} s: ${errorMessage(error)}`,
        );
        timers.clearTimeout(timer);
        timer = timers.setTimeout(() => void flush(), wait);
      }
    });
    return saving;
  };

  const markChanged = (tracked: Tracked) => {
    dirty.add(tracked);
    // A store that is failing is not asked more often because values keep changing.
    if (failures > 0) return;
    firstChangeAt ??= timers.now();
    const untilLatest = firstChangeAt + MAX_WAIT_MS - timers.now();
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => void flush(), Math.max(0, Math.min(DEBOUNCE_MS, untilLatest)));
  };

  return {
    async restore(bundle, name) {
      try {
        return await store.load(bundle, name);
      } catch (error) {
        logger.warn(
          `Could not read the stored value of "${bundle}:${name}": ${errorMessage(error)}`,
        );
        return undefined;
      }
    },
    track(bundle, name, replicant, savedRev = replicant.rev) {
      const tracked: Tracked = { bundle, name, replicant };
      replicant.onCommit(() => markChanged(tracked));
      replicant.onClose(() => {
        if (dirty.has(tracked)) void flush();
      });
      if (replicant.rev !== savedRev) markChanged(tracked);
    },
    flush,
  };
}
