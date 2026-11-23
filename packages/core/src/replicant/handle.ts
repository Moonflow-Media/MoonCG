import type { MoonCGError } from '../errors.js';
import type { Recipe } from './patch.js';

export interface ReplicantMeta {
  readonly rev: number;
}

/** The replicant API bundle code uses. It is the same in the browser and in extensions. */
export interface ReplicantHandle<T> {
  /** The qualified name, `bundle:name`. */
  readonly name: string;
  /** Resolves once the first value is available. Rejects if the replicant cannot be read. */
  readonly ready: Promise<void>;
  /** A frozen snapshot. `undefined` until `ready` resolves. */
  readonly value: T | undefined;
  /**
   * Set while the replicant cannot be used: it is not declared, may not be read, or was removed
   * from the server. Writes reject with this error. `undefined` while everything is fine.
   */
  readonly error: MoonCGError | undefined;
  /** Calls `listener` whenever `error` changes, in either direction. */
  onErrorChange(listener: () => void): () => void;
  /** Calls `listener` with the current value (as soon as there is one) and after every change. */
  subscribe(listener: (value: T, meta: ReplicantMeta) => void): () => void;
  /** Replaces the value. Last write wins. */
  set(next: T): Promise<void>;
  /**
   * Changes the value with an Immer-style recipe. On a conflict the recipe is re-run on the
   * newer value, up to three times. Needs an object or array value; use `set` for primitives.
   */
  update(recipe: Recipe<T>): Promise<void>;
}
