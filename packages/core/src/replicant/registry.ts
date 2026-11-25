import type { Json } from '../json.js';
import { NAMESPACE_SEPARATOR } from '../names.js';
import { bundlePermission } from '../permissions/authorize.js';
import { Replicant, type Validate } from './replicant.js';

export interface ReplicantDeclaration {
  readonly initial: Json;
  /** The revision a restored value had when it was stored. */
  readonly rev?: number | undefined;
  /** Permission names from the bundle manifest. */
  readonly read?: string | undefined;
  readonly write?: string | undefined;
  /** A complete permission string, for replicants that do not belong to a bundle. */
  readonly readPermission?: string | undefined;
  /** Nobody can write it over a connection, whatever they are granted. */
  readonly readOnly?: boolean | undefined;
  readonly validate?: Validate | undefined;
}

export interface ReplicantEntry {
  readonly replicant: Replicant;
  readonly readPermission: string;
  readonly writePermission: string;
  readonly readOnly: boolean;
}

export interface RegistryOptions {
  /** Receives what a commit or close listener of the named replicant threw. */
  readonly onListenerError?: (qualifiedName: string, error: unknown) => void;
  /**
   * Makes the epoch of each declared replicant. It must never return the same text twice, not
   * even across server restarts, so the server passes a random id generator. The default only
   * counts, which is unique within one registry.
   */
  readonly createEpoch?: () => string;
}

/** `score` in bundle `scoreboard` becomes `scoreboard:score`; qualified names pass through. */
export function qualifyReplicantName(name: string, bundle: string): string {
  return name.includes(NAMESPACE_SEPARATOR) ? name : `${bundle}${NAMESPACE_SEPARATOR}${name}`;
}

/** All declared replicants, keyed by qualified name. Only the server side declares. */
export class ReplicantRegistry {
  readonly #entries = new Map<string, ReplicantEntry>();
  readonly #options: RegistryOptions;
  readonly #declareListeners = new Set<(qualifiedName: string) => void>();
  #declared = 0;

  constructor(options: RegistryOptions = {}) {
    this.#options = options;
  }

  /** Throws if the replicant exists already or its initial value is not JSON. */
  declare(bundle: string, name: string, declaration: ReplicantDeclaration): ReplicantEntry {
    const key = qualifyReplicantName(name, bundle);
    if (this.#entries.has(key)) throw new Error(`Replicant "${key}" is already declared`);
    const entry: ReplicantEntry = {
      replicant: new Replicant({
        initial: declaration.initial,
        rev: declaration.rev,
        epoch: this.#options.createEpoch?.() ?? String(++this.#declared),
        validate: declaration.validate,
        onError: (error) => this.#options.onListenerError?.(key, error),
      }),
      readPermission: declaration.readPermission ?? bundlePermission(bundle, declaration.read),
      readOnly: declaration.readOnly ?? false,
      writePermission: bundlePermission(bundle, declaration.write),
    };
    this.#entries.set(key, entry);
    for (const listener of [...this.#declareListeners]) {
      try {
        listener(key);
      } catch (error) {
        this.#options.onListenerError?.(key, error);
      }
    }
    return entry;
  }

  /**
   * Calls `listener` with the qualified name of every replicant declared from now on, until
   * the returned function is called. A connection uses it to learn that a replicant it lost
   * with its bundle is there again.
   */
  onDeclare(listener: (qualifiedName: string) => void): () => void {
    this.#declareListeners.add(listener);
    return () => {
      this.#declareListeners.delete(listener);
    };
  }

  /** How many listeners wait for declarations. A leak shows as a count that grows. */
  get declareListenerCount(): number {
    return this.#declareListeners.size;
  }

  get(qualifiedName: string): ReplicantEntry | undefined {
    return this.#entries.get(qualifiedName);
  }

  /** How many replicants are declared, and how many listeners they have between them. */
  stats(): { replicants: number; listeners: number } {
    let listeners = 0;
    for (const { replicant } of this.#entries.values()) listeners += replicant.listenerCount;
    return { replicants: this.#entries.size, listeners };
  }

  /** Removes every replicant of a bundle and closes it, which notifies its subscribers. */
  undeclare(bundle: string): void {
    const prefix = `${bundle}${NAMESPACE_SEPARATOR}`;
    for (const [key, entry] of [...this.#entries]) {
      if (!key.startsWith(prefix)) continue;
      this.#entries.delete(key);
      entry.replicant.close();
    }
  }
}
