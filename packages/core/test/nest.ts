import type { Json } from '../src/json.js';

/** A value wrapped in `depth` arrays: `nest(2)` is `[[0]]`. */
export function nest(depth: number): Json {
  let value: Json = 0;
  for (let level = 0; level < depth; level++) value = [value];
  return value;
}

/** The JSON text of `nest(depth)`, built without recursion. */
export function nestedText(depth: number): string {
  return `${'['.repeat(depth)}0${']'.repeat(depth)}`;
}
