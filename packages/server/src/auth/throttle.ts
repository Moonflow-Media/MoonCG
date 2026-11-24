import { createHash } from 'node:crypto';

export interface ThrottleOptions {
  readonly now: () => number;
  /** How many failures in a row are free before the key is blocked. */
  readonly free: number;
  /** The first block. Each further failure doubles it, up to `maxMs`. */
  readonly baseMs: number;
  readonly maxMs: number;
  /** The most keys tracked at a time. The key that failed longest ago goes first. */
  readonly maxKeys?: number;
}

interface Entry {
  failures: number;
  blockedUntil: number;
  /** What `blockedUntil` was before the latest failure, in case that one is taken back. */
  blockedBefore: number;
  lastFailure: number;
}

/** No key is kept longer than this; a longer one is replaced by its hash. */
const MAX_KEY_LENGTH = 128;

/**
 * Slows down guessing: after a few failures a key (a user name at an address, an address) is
 * blocked for a time that doubles with every further failure. Kept in memory and bounded in
 * the number and the size of its keys, so it costs an attacker nothing to fill it and the
 * server nothing to hold it. A restart clears it.
 *
 * An attempt is counted when it is admitted, before its password is checked, so attempts that
 * arrive together are counted like attempts that arrive one after another.
 */
export class LoginThrottle {
  readonly #options: ThrottleOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: ThrottleOptions) {
    this.#options = options;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The keys as they are held, for checking their size. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** How many milliseconds the key stays blocked; 0 if it is not. */
  blockedFor(key: string): number {
    const entry = this.#current(bounded(key));
    return entry ? Math.max(0, entry.blockedUntil - this.#options.now()) : 0;
  }

  /** Counts a failed attempt, or one that is about to be checked. */
  fail(key: string): void {
    const { now, free, baseMs, maxMs, maxKeys = 10_000 } = this.#options;
    const name = bounded(key);
    const entry = this.#current(name) ?? {
      failures: 0,
      blockedUntil: 0,
      blockedBefore: 0,
      lastFailure: 0,
    };
    entry.failures++;
    entry.lastFailure = now();
    entry.blockedBefore = entry.blockedUntil;
    if (entry.failures >= free) {
      // The exponent is capped so the number stays finite however long someone keeps trying.
      const doubled = baseMs * 2 ** Math.min(entry.failures - free, 30);
      entry.blockedUntil = now() + Math.min(doubled, maxMs);
    }
    // Moves the key to the end: the map keeps the order of the latest failures.
    this.#entries.delete(name);
    this.#entries.set(name, entry);
    while (this.#entries.size > maxKeys) {
      this.#entries.delete(this.#entries.keys().next().value as string);
    }
  }

  /** Takes back the latest counted attempt: it turned out not to be a failure. */
  forgive(key: string): void {
    const name = bounded(key);
    const entry = this.#entries.get(name);
    if (!entry) return;
    entry.failures--;
    entry.blockedUntil = entry.failures < this.#options.free ? 0 : entry.blockedBefore;
    if (entry.failures <= 0) this.#entries.delete(name);
  }

  /** Forgets the key. */
  succeed(key: string): void {
    this.#entries.delete(bounded(key));
  }

  /** The entry of a key, unless it has been quiet for long enough to be forgotten. */
  #current(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && this.#options.now() - entry.lastFailure > this.#options.maxMs * 2) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }
}

function bounded(key: string): string {
  return key.length <= MAX_KEY_LENGTH ? key : createHash('sha256').update(key).digest('hex');
}
