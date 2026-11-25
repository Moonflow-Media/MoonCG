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
 * The schemas of a manifest's replicants as they were read and found usable, by the name of
 * the replicant. See `checkReplicants`.
 */
export type CheckedSchemas = ReadonlyMap<string, Validate>;

/**
 * Declares the replicants of a bundle manifest: compiles each schema, picks the initial value
 * (the stored one for a persistent replicant if it still fits the schema, else the default)
 * and registers it. When there are errors, none of the replicants stay. With `checked`, the
 * schemas `checkReplicants` read for this very manifest, no file is read again: what was
 * checked is what is declared.
 */
export async function declareReplicants(
  bundle: { readonly name: string; readonly dir: string; readonly manifest: Manifest },
  options: DeclareOptions,
  checked?: CheckedSchemas,
): Promise<DeclaredReplicants> {
  const { registry, logger, persistence } = options;
  const saving: (() => void)[] = [];
  for (const [name, declaration] of Object.entries(bundle.manifest.replicants)) {
    const path = `replicants.${name}`;
    try {
      const validate =
        declaration.schema === undefined
          ? undefined
          : (checked?.get(name) ??
            (await loadSchema(bundle.dir, declaration.schema, `${path}.schema`)));
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

/**
 * Checks what `declareReplicants` would refuse, without declaring anything: each schema must
 * be readable and usable, and each default must fit it. Returns the problems, worded like
 * the errors of a bundle that fails to start, and the schemas as they were read, to hand to
 * `declareReplicants` so that it declares exactly what was checked. For a bundle that keeps
 * running while its files are edited.
 */
export async function checkReplicants(bundle: {
  readonly dir: string;
  readonly manifest: Manifest;
}): Promise<{ readonly errors: string[]; readonly schemas: CheckedSchemas }> {
  const errors: string[] = [];
  const schemas = new Map<string, Validate>();
  for (const [name, declaration] of Object.entries(bundle.manifest.replicants)) {
    if (declaration.schema === undefined) continue;
    const path = `replicants.${name}`;
    try {
      const validate = await loadSchema(bundle.dir, declaration.schema, `${path}.schema`);
      schemas.set(name, validate);
      const problems = validate(declaration.default ?? null);
      if (problems?.length) {
        errors.push(`${path}.default: does not match the schema: ${problems.join('; ')}`);
      }
    } catch (error) {
      errors.push(
        error instanceof DeclarationError ? error.message : `${path}: ${errorMessage(error)}`,
      );
    }
  }
  return { errors, schemas };
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
