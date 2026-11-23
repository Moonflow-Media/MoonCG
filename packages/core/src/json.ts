/** Any value that survives a JSON round trip. Replicant values and wire payloads are JSON. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * How many arrays and objects may be nested inside each other in a replicant value or a wire
 * payload. The limit keeps every recursive walk over a value (freeze, patch, validate) shallow.
 */
export const MAX_JSON_DEPTH = 64;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Explains why a value cannot be stored or sent, or returns `null` when it is plain JSON nested
 * no deeper than `maxDepth`. Rejects `undefined`, non-finite numbers, functions, class instances
 * such as `Date` and `Map`, and holes in arrays.
 */
export function jsonProblem(value: unknown, maxDepth: number = MAX_JSON_DEPTH): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${value} is not a JSON number`;
  }
  if (typeof value !== 'object') return `A value of type ${typeof value} is not JSON`;

  const isArray = Array.isArray(value);
  if (!isArray) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return `An instance of ${prototype.constructor?.name ?? 'a class'} is not JSON`;
    }
  }
  if (maxDepth <= 0) return `The value is nested deeper than ${MAX_JSON_DEPTH} levels`;
  // Array.from turns holes into undefined, which is then rejected.
  for (const child of isArray ? Array.from(value) : Object.values(value)) {
    const problem = jsonProblem(child, maxDepth - 1);
    if (problem !== null) return problem;
  }
  return null;
}
