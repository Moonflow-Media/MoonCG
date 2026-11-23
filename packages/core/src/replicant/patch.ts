import { create, type Draft } from 'mutative';
import { isPlainObject, type Json, jsonProblem, MAX_JSON_DEPTH } from '../json.js';

/** The JSON Patch (RFC 6902) subset replicant ops are made of. Paths are JSON Pointers. */
export type PatchOp =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: Json }
  | { readonly op: 'remove'; readonly path: string };

export type Recipe<T> = (draft: Draft<T>) => void;

/** Thrown by `applyPatches` when a patch does not fit the value it is applied to. */
export class PatchError extends Error {
  override readonly name = 'PatchError';
}

/**
 * Applies patches in order and returns the new value. The input is never mutated.
 * Throws `PatchError` for a patch that does not fit, for a value that is not JSON, and for a
 * result that would be nested deeper than `MAX_JSON_DEPTH`.
 */
export function applyPatches(value: Json, patches: readonly PatchOp[]): Json {
  return patches.reduce<Json>((current, patch) => {
    const tokens = parsePointer(patch.path);
    if (patch.op !== 'remove') {
      // The path already uses up one level per token.
      const problem = jsonProblem(patch.value, MAX_JSON_DEPTH - tokens.length);
      if (problem !== null) throw new PatchError(`Invalid value for a patch: ${problem}`);
    }
    return applyAt(current, tokens, 0, patch);
  }, value);
}

/** Runs an Immer-style recipe on a draft of `base` and returns the patches it caused. */
export function producePatches<T>(base: T, recipe: Recipe<T>): PatchOp[] {
  const [, patches] = create(base, recipe, {
    enablePatches: { pathAsArray: false, arrayLengthAssignment: false },
  });
  return patches.map((patch) =>
    patch.op === 'remove'
      ? { op: 'remove', path: patch.path }
      : { op: patch.op, path: patch.path, value: patch.value as Json },
  );
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new PatchError(`Path "${path}" must be empty or start with "/"`);
  const tokens = path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  // Assigning "__proto__" would set an object's prototype instead of storing a member.
  // "constructor" and "prototype" are ordinary own members when assigned, so they are allowed.
  if (tokens.includes('__proto__')) {
    throw new PatchError('"__proto__" cannot be used as a member name in a path');
  }
  return tokens;
}

function applyAt(node: Json, tokens: readonly string[], depth: number, patch: PatchOp): Json {
  const token = tokens[depth];
  if (token === undefined) {
    if (patch.op === 'remove') throw new PatchError('The root value cannot be removed');
    return patch.value;
  }
  const isTarget = depth === tokens.length - 1;
  if (Array.isArray(node)) {
    const copy = [...(node as readonly Json[])];
    const index = arrayIndex(token, copy.length, patch, isTarget);
    if (!isTarget) copy[index] = applyAt(copy[index] as Json, tokens, depth + 1, patch);
    else if (patch.op === 'add') copy.splice(index, 0, patch.value);
    else if (patch.op === 'replace') copy[index] = patch.value;
    else copy.splice(index, 1);
    return copy;
  }
  if (isPlainObject(node)) {
    const exists = Object.hasOwn(node, token);
    if (!exists && !(isTarget && patch.op === 'add')) {
      throw new PatchError(`Path "${patch.path}" does not exist`);
    }
    const copy: Record<string, Json> = { ...(node as Record<string, Json>) };
    if (!isTarget) copy[token] = applyAt(copy[token] as Json, tokens, depth + 1, patch);
    else if (patch.op === 'remove') delete copy[token];
    else copy[token] = patch.value;
    return copy;
  }
  throw new PatchError(`Path "${patch.path}" does not exist`);
}

/** Resolves an array token. Only the target of an `add` may point one past the end (or use "-"). */
function arrayIndex(token: string, length: number, patch: PatchOp, isTarget: boolean): number {
  const isInsert = isTarget && patch.op === 'add';
  if (isInsert && token === '-') return length;
  const index = /^(0|[1-9]\d*)$/.test(token) ? Number(token) : Number.NaN;
  if (Number.isNaN(index) || index > (isInsert ? length : length - 1)) {
    throw new PatchError(`Path "${patch.path}" is not a valid array position`);
  }
  return index;
}
