import { type Json, jsonProblem } from '../json.js';
import { applyPatches, deepFreeze, PatchError, type PatchOp } from './patch.js';

/** How many of the latest commits a replicant keeps, to bring a reconnecting client up to date. */
export const REPLAY_BUFFER_SIZE = 100;

/**
 * How much those commits may take up together, 1 MiB, measured as the length of their JSON
 * text. Without it, a hundred whole-value replacements would keep a hundred copies of the value.
 */
export const REPLAY_BUFFER_BYTES = 1024 * 1024;

/** A change request. Without `baseRev` it is applied to whatever the current value is. */
export interface ReplicantOp {
  readonly baseRev?: number;
  readonly patches: readonly PatchOp[];
}

export type OpResult =
  | { readonly ok: true; readonly rev: number; readonly patches: readonly PatchOp[] }
  | {
      readonly ok: false;
      readonly code: 'conflict' | 'bad_request' | 'invalid' | 'not_found';
      readonly message: string;
    };

/** The patches that turned revision `rev - 1` into revision `rev`. */
export interface CommittedPatches {
  readonly rev: number;
  readonly patches: readonly PatchOp[];
}

export interface Commit extends CommittedPatches {
  readonly value: Json;
}

/** Returns error messages for a rejected value, or `null` when it is acceptable. */
export type Validate = (value: Json) => readonly string[] | null;

export interface ReplicantOptions {
  /** Frozen in place: the engine owns it from here on. Must be JSON. */
  readonly initial: Json;
  /** The revision of a restored value. A new replicant starts at 0. */
  readonly rev?: number | undefined;
  /**
   * Identifies this replicant instance. Revisions are only comparable within one epoch: after
   * a restart, or after the replicant was removed and declared again, the same number can
   * stand for a different value.
   */
  readonly epoch?: string | undefined;
  /** Checks every value before it is committed, for example against a JSON Schema. */
  readonly validate?: Validate | undefined;
  /** Receives what a commit or close listener threw. Without it such errors are dropped. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** The authoritative state of one replicant: a frozen value and a linear revision counter. */
export class Replicant {
  readonly epoch: string;
  #value: Json;
  #rev: number;
  #closed = false;
  readonly #validate: Validate | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #commitListeners = new Set<(commit: Commit) => void>();
  readonly #closeListeners = new Set<() => void>();
  /** The latest commits, oldest first, within `REPLAY_BUFFER_SIZE` and `REPLAY_BUFFER_BYTES`. */
  readonly #history: (CommittedPatches & { readonly size: number })[] = [];
  #historySize = 0;
  /** The length of the current value's JSON text, worked out when first needed. */
  #valueSize: number | undefined;
  /** Commits waiting for delivery. Present only while a delivery is running. */
  #undelivered: Commit[] | undefined;

  constructor(options: ReplicantOptions) {
    const problem = jsonProblem(options.initial);
    if (problem !== null) throw new Error(`The initial value is not valid JSON: ${problem}`);
    const rev = options.rev ?? 0;
    if (!Number.isSafeInteger(rev) || rev < 0) {
      throw new Error(`The initial rev must be a non-negative integer, got ${rev}`);
    }
    this.#value = deepFreeze(options.initial);
    this.#rev = rev;
    this.epoch = options.epoch ?? '0';
    this.#validate = options.validate;
    this.#onError = options.onError;
  }

  get value(): Json {
    return this.#value;
  }

  get rev(): number {
    return this.#rev;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** How many commit and close listeners are attached. */
  get listenerCount(): number {
    return this.#commitListeners.size + this.#closeListeners.size;
  }

  /**
   * Commits the op atomically, or rejects it and leaves value and rev untouched. Every writer
   * goes through here, so this is where non-JSON and too deeply nested values are refused.
   * An op without patches changes nothing and reports the current rev.
   */
  applyOp(op: ReplicantOp): OpResult {
    if (this.#closed) {
      return { ok: false, code: 'not_found', message: 'The replicant was removed' };
    }
    if (op.baseRev !== undefined && op.baseRev !== this.#rev) {
      return {
        ok: false,
        code: 'conflict',
        message: `Op is based on rev ${op.baseRev}, current rev is ${this.#rev}`,
      };
    }
    if (op.patches.length === 0) return { ok: true, rev: this.#rev, patches: op.patches };

    let next: Json;
    try {
      next = applyPatches(this.#value, op.patches);
    } catch (error) {
      if (error instanceof PatchError) {
        return { ok: false, code: 'bad_request', message: error.message };
      }
      throw error;
    }
    const errors = this.#validate?.(next);
    if (errors?.length) return { ok: false, code: 'invalid', message: errors.join('; ') };

    this.#value = deepFreeze(next);
    this.#rev += 1;
    const commit: Commit = { rev: this.#rev, patches: op.patches, value: this.#value };
    this.#valueSize = undefined;
    this.#remember(commit);
    this.#deliver(commit);
    return { ok: true, rev: commit.rev, patches: commit.patches };
  }

  /**
   * The commits someone who has revision `rev` is missing, oldest first. `undefined` when a
   * snapshot is the answer instead:
   * - the buffer no longer reaches back that far,
   * - `rev` is ahead of this replicant, so it belongs to a state this replicant never had, or
   * - the missed patches are larger than the value itself (compared as JSON text length).
   */
  patchesSince(rev: number): readonly CommittedPatches[] | undefined {
    const missing = this.#rev - rev;
    if (missing < 0 || missing > this.#history.length) return undefined;
    const missed = this.#history.slice(this.#history.length - missing);
    const size = missed.reduce((sum, commit) => sum + commit.size, 0);
    if (size > 0) {
      this.#valueSize ??= JSON.stringify(this.#value).length;
      if (size > this.#valueSize) return undefined;
    }
    return missed.map(({ rev: committed, patches }) => ({ rev: committed, patches }));
  }

  #remember(commit: Commit): void {
    const size = JSON.stringify(commit.patches).length;
    this.#history.push({ rev: commit.rev, patches: commit.patches, size });
    this.#historySize += size;
    while (this.#history.length > REPLAY_BUFFER_SIZE || this.#historySize > REPLAY_BUFFER_BYTES) {
      this.#historySize -= this.#history.shift()?.size ?? 0;
    }
  }

  onCommit(listener: (commit: Commit) => void): () => void {
    this.#commitListeners.add(listener);
    return () => {
      this.#commitListeners.delete(listener);
    };
  }

  /** `listener` runs once, when the replicant is removed from the server. */
  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  /** Ends the replicant: later ops are rejected with `not_found` and listeners are dropped. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#commitListeners.clear();
    for (const listener of [...this.#closeListeners]) this.#call(listener, undefined);
    this.#closeListeners.clear();
  }

  /**
   * A listener may write to the replicant. That commit is queued until every listener has seen
   * the current one, so all of them observe revisions in order.
   */
  #deliver(commit: Commit): void {
    if (this.#undelivered) {
      this.#undelivered.push(commit);
      return;
    }
    this.#undelivered = [commit];
    for (const next of this.#undelivered) {
      for (const listener of [...this.#commitListeners]) this.#call(listener, next);
    }
    this.#undelivered = undefined;
  }

  /** The commit already happened, so a failing listener must not fail it or the other listeners. */
  #call<A>(listener: (argument: A) => void, argument: A): void {
    try {
      listener(argument);
    } catch (error) {
      try {
        this.#onError?.(error);
      } catch {
        // An error reporter that throws has nowhere left to report to.
      }
    }
  }
}
