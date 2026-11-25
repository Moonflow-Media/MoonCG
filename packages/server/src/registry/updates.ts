import {
  BUNDLES_MANAGE,
  MODULES_MANAGE,
  type ReplicantRegistry,
  SYSTEM_BUNDLE,
} from '@mooncg/core';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { UpdateHint } from './catalog.js';

/**
 * The replicants that carry the update hints live, one per kind, so that each is read with
 * the permission of its kind: `system:updates.bundles` with `system:bundles.manage`,
 * `system:updates.modules` with `system:modules.manage`.
 */
export const UPDATES_REPLICANTS = {
  bundle: 'updates.bundles',
  module: 'updates.modules',
} as const;

/** What each of them holds: the hints of its kind, and a counter of what changed. */
export interface UpdatesValue {
  readonly updates: readonly UpdateHint[];
  /**
   * Counts up when the hints of its kind changed, and when what they are worked out from (the
   * entries of the indexes, what is installed) changed although they did not: the catalog
   * reads its entries again on that. Working them out to the same changes nothing.
   */
  readonly revision: number;
}

/** What the hints are worked out to, and what they were worked out from. */
export interface UpdatesComputed {
  readonly hints: readonly UpdateHint[];
  /** Whatever the hints depend on, as JSON: when it changes, every kind counts up. */
  readonly basis: unknown;
}

/** How long the hints wait for more changes before they are worked out again. */
const SETTLE_MS = 100;
/** How long a steady stream of changes may put them off at most. */
const MAX_WAIT_MS = 2000;

/**
 * Keeps the update hints in their replicants, as `GET /api/v1/registry/updates` tells them.
 * They are worked out again whenever an index was fetched and whenever something was
 * installed, updated or removed; changes that come together are taken together.
 */
export class UpdateHints {
  readonly #compute: () => Promise<UpdatesComputed>;
  readonly #log: Logger;
  readonly #published: Record<UpdateHint['kind'], ReturnType<ReplicantRegistry['declare']>>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the first change that waits came, so that waiting has an end. */
  #waitingSince: number | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;
  /** What was published last, as JSON: per kind its hints, and the basis of all. */
  #last: { bundle?: string; module?: string; basis?: string } = {};

  constructor(options: {
    readonly registry: ReplicantRegistry;
    readonly compute: () => Promise<UpdatesComputed>;
    readonly logger: Logger;
  }) {
    this.#compute = options.compute;
    this.#log = options.logger.child('registry');
    const declare = (name: string, readPermission: string) =>
      options.registry.declare(SYSTEM_BUNDLE, name, {
        initial: { updates: [], revision: 0 },
        readPermission,
        readOnly: true,
      });
    this.#published = {
      bundle: declare(UPDATES_REPLICANTS.bundle, BUNDLES_MANAGE),
      module: declare(UPDATES_REPLICANTS.module, MODULES_MANAGE),
    };
  }

  /**
   * Works the hints out again soon. Calls that come close together are taken as one, but
   * none waits longer than `MAX_WAIT_MS`, however steadily they come.
   */
  changed(): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    const now = Date.now();
    this.#waitingSince ??= now;
    const delay = Math.max(0, Math.min(SETTLE_MS, this.#waitingSince + MAX_WAIT_MS - now));
    this.#timer = setTimeout(() => void this.refresh(), delay);
    this.#timer.unref?.();
  }

  /** Works the hints out again now; a run that is going on is followed by one more. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#run().finally(() => {
      this.#running = undefined;
      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#running;
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  async #run(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#waitingSince = undefined;
    let computed: UpdatesComputed;
    try {
      computed = await this.#compute();
    } catch (error) {
      this.#log.warn(`The update hints could not be worked out: ${errorMessage(error)}`);
      return;
    }
    if (this.#closed) return;
    const basis = JSON.stringify(computed.basis) ?? '';
    const basisChanged = basis !== this.#last.basis;
    this.#last.basis = basis;
    for (const kind of ['bundle', 'module'] as const) {
      const updates = computed.hints.filter((hint) => hint.kind === kind);
      const text = JSON.stringify(updates);
      if (!basisChanged && text === this.#last[kind]) continue;
      this.#last[kind] = text;
      const { replicant } = this.#published[kind];
      const previous = replicant.value as unknown as UpdatesValue;
      const value: UpdatesValue = { updates, revision: previous.revision + 1 };
      replicant.applyOp({
        patches: [{ op: 'replace', path: '', value: value as never }],
      });
    }
  }
}
