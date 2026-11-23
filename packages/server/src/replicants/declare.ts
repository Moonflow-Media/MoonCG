import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest, ReplicantRegistry, Validate } from '@mooncg/core';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { ReplicantPersistence } from './persistence.js';
import { compileSchema } from './schema.js';

export interface DeclareOptions {
  readonly registry: ReplicantRegistry;
  /** The logger of the bundle being declared. */
  readonly logger: Logger;
  /** Without it, `persistent` replicants behave like the others. */
  readonly persistence?: ReplicantPersistence | undefined;
}

export interface DeclaredReplicants {
  readonly errors: readonly string[];
  /**
   * Starts saving the bundle's persistent replicants, including what was written to them
   * since they were declared. Call it once the bundle runs: what a bundle writes while it
   * fails to start must not reach the store.
   */
  startSaving(): void;
}

/** A problem with one manifest entry, worded as `<path in the manifest>: <what is wrong>`. */
class DeclarationError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
  }
}

/**
 * Declares the replicants of a bundle manifest: compiles each schema, picks the initial value
 * (the stored one for a persistent replicant if it still fits the schema, else the default)
 * and registers it. When there are errors, none of the replicants stay.
 */
export async function declareReplicants(
  bundle: { readonly name: string; readonly dir: string; readonly manifest: Manifest },
  options: DeclareOptions,
): Promise<DeclaredReplicants> {
  const { registry, logger, persistence } = options;
  const saving: (() => void)[] = [];
  for (const [name, declaration] of Object.entries(bundle.manifest.replicants)) {
    const path = `replicants.${name}`;
    try {
      const validate =
        declaration.schema === undefined
          ? undefined
          : await loadSchema(bundle.dir, declaration.schema, `${path}.schema`);
      const fallback = declaration.default ?? null;
      const problems = validate?.(fallback);
      if (problems?.length) {
        throw new DeclarationError(
          `${path}.default`,
          declaration.default === undefined
            ? `a replicant with a schema needs a default, because null does not match (${problems.join('; ')})`
            : `does not match the schema: ${problems.join('; ')}`,
        );
      }

      const store = declaration.persistent ? persistence : undefined;
      const stored = await store?.restore(bundle.name, name);
      const storedProblems = stored && validate?.(stored.value);
      if (storedProblems?.length) {
        logger.warn(
          `Stored value of replicant "${name}" does not match its schema (${storedProblems.join('; ')}); using the default`,
        );
      }
      const entry = registry.declare(bundle.name, name, {
        initial: stored && !storedProblems?.length ? stored.value : fallback,
        // The revision keeps counting from the stored one even if the value was discarded.
        rev: stored?.rev,
        read: declaration.read,
        write: declaration.write,
        validate,
      });
      if (store) {
        saving.push(() => store.track(bundle.name, name, entry.replicant, stored?.rev ?? 0));
      }
    } catch (error) {
      registry.undeclare(bundle.name);
      const message =
        error instanceof DeclarationError ? error.message : `${path}: ${errorMessage(error)}`;
      return { errors: [message], startSaving: () => {} };
    }
  }
  return {
    errors: [],
    startSaving: () => {
      for (const start of saving) start();
    },
  };
}

async function loadSchema(dir: string, file: string, path: string): Promise<Validate> {
  let text: string;
  try {
    text = await readFile(join(dir, file), 'utf8');
  } catch (error) {
    throw new DeclarationError(path, `"${file}" could not be read: ${errorMessage(error)}`);
  }
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    throw new DeclarationError(path, `"${file}" is not valid JSON: ${errorMessage(error)}`);
  }
  try {
    return compileSchema(schema);
  } catch (error) {
    throw new DeclarationError(path, `"${file}" is not a usable schema: ${errorMessage(error)}`);
  }
}
