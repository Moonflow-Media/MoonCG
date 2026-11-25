import {
  DASHBOARD_VIEW,
  isPlainObject,
  type Json,
  type Replicant,
  type ReplicantRegistry,
  SYSTEM_BUNDLE,
} from '@mooncg/core';
import type { LockedOperation } from '../bundles/manager.js';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { SettingsStore } from '../storage/replicant-store.js';

/**
 * The name of the read-only replicant `{ onAir, since? }` that says whether the installation
 * is on air. It is for everyone who sees the dashboard: all of them should know why a
 * button refuses.
 */
export const ON_AIR_REPLICANT = 'onAir';
/** The key the state is stored under. */
const SETTING = 'onAir';

export interface OnAirState {
  readonly onAir: boolean;
  /** When it went on air, as an ISO date. */
  readonly since?: string | undefined;
  /** Who switched it on. Told to those who may manage bundles, and written to the log. */
  readonly by?: string | undefined;
}

export interface OnAirOptions {
  readonly registry: ReplicantRegistry;
  readonly logger: Logger;
  /** Keeps the state across restarts. Without it a restart ends being on air. */
  readonly store?: SettingsStore | undefined;
  readonly now?: (() => number) | undefined;
}

const DOING: Readonly<Record<LockedOperation, string>> = {
  update: 'updating',
  remove: 'removing',
  disable: 'disabling',
  reload: 'reloading',
  restart: 'restarting the extension of',
};

/**
 * The "On Air" lock: one switch for the whole installation. While it is on, nothing that
 * interrupts a running bundle happens unless it overrides the lock: no update, removal, disabling,
 * reload or restart, and what the file watcher sees waits until the switch is off again.
 *
 * It is one switch and not one per bundle because a show is on air as a whole: bundles
 * depend on each other, so a lock on one would still let a reload of what it needs take it
 * down, and nobody remembers under pressure which of ten bundles they forgot to lock.
 */
export class OnAirLock {
  readonly #options: OnAirOptions;
  readonly #published: Replicant;
  readonly #releaseListeners = new Set<() => void>();
  #state: OnAirState = { onAir: false };

  constructor(options: OnAirOptions) {
    this.#options = options;
    this.#published = options.registry.declare(SYSTEM_BUNDLE, ON_AIR_REPLICANT, {
      initial: { onAir: false },
      readPermission: DASHBOARD_VIEW,
      readOnly: true,
    }).replicant;
  }

  /**
   * Reads the stored state. It fails closed: when the store cannot be read, or holds
   * something that is no stored state, the installation counts as on air. A show that is
   * running must not lose its lock to a damaged database; a lock that is on by mistake
   * costs one click. Only an installation that never stored anything starts off.
   */
  async load(): Promise<void> {
    this.#state = await this.#stored();
    this.#publish();
  }

  async #stored(): Promise<OnAirState> {
    const failClosed = (why: string): OnAirState => {
      this.#options.logger.error(
        `The On Air state ${why}, so MoonCG counts as ON AIR: updates, removals, disabling and reloads are blocked. ` +
          'If no show is running, switch On Air off in the dashboard or with ' +
          '"PUT /api/v1/on-air" { "onAir": false }; that stores a fresh state.',
      );
      return { onAir: true };
    };
    let stored: Json | undefined;
    try {
      stored = await this.#options.store?.get(SETTING);
    } catch (error) {
      return failClosed(`could not be read (${errorMessage(error)})`);
    }
    if (stored === undefined) return { onAir: false };
    if (!isPlainObject(stored) || typeof stored.onAir !== 'boolean') {
      return failClosed('that is stored cannot be understood');
    }
    if (!stored.onAir) return { onAir: false };
    return {
      onAir: true,
      ...(typeof stored.since === 'string' ? { since: stored.since } : {}),
      ...(typeof stored.by === 'string' ? { by: stored.by } : {}),
    };
  }

  get state(): OnAirState {
    return this.#state;
  }

  /** Switches the lock. `by` is who did it, for the log. Resolves with the state it is in. */
  async set(onAir: boolean, by: string): Promise<OnAirState> {
    if (onAir === this.#state.onAir) return this.#state;
    const next: OnAirState = onAir
      ? { onAir: true, since: new Date((this.#options.now ?? Date.now)()).toISOString(), by }
      : { onAir: false };
    await this.#options.store?.set(SETTING, { ...next } as Json);
    this.#state = next;
    this.#publish();
    this.#options.logger.info(`${by} switched On Air ${onAir ? 'on' : 'off'}`);
    if (!onAir) {
      for (const listener of [...this.#releaseListeners]) {
        try {
          listener();
        } catch (error) {
          this.#options.logger.error(`An On Air listener failed: ${errorMessage(error)}`);
        }
      }
    }
    return next;
  }

  /** What the bundle manager asks: why a change is refused, or `undefined` to let it through. */
  reason(bundle: string, operation: LockedOperation): string | undefined {
    if (!this.#state.onAir) return undefined;
    return (
      `MoonCG is on air: ${DOING[operation]} "${bundle}" is blocked. ` +
      'Switch On Air off first, or override the lock for this one change ' +
      '("forceOnAir": true in the request, --on-air on the command line).'
    );
  }

  /** Calls `listener` whenever the lock is released. Returns the function that stops it. */
  onRelease(listener: () => void): () => void {
    this.#releaseListeners.add(listener);
    return () => {
      this.#releaseListeners.delete(listener);
    };
  }

  #publish(): void {
    const { onAir, since } = this.#state;
    const value: Json = { onAir, ...(since === undefined ? {} : { since }) };
    if (JSON.stringify(value) === JSON.stringify(this.#published.value)) return;
    this.#published.applyOp({ patches: [{ op: 'replace', path: '', value }] });
  }
}
