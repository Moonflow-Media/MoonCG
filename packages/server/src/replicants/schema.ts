import { isPlainObject, jsonProblem, type Validate } from '@mooncg/core';
import { Ajv, type ErrorObject, type Options } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Unknown keywords (such as `x-secret`) and `format` are treated as annotations: allowed, not
 * enforced. All violations are collected, not only the first.
 */
const OPTIONS: Options = { allErrors: true, strict: false, validateFormats: false, logger: false };

/** How many violations one rejected write reports. A huge invalid value has many more. */
export const MAX_REPORTED_ERRORS = 10;

/**
 * Compiles a JSON Schema into a replicant validator. Schemas are draft-07 unless their `$schema`
 * names draft 2020-12. Throws with a readable message when the schema itself is not usable.
 */
export function compileSchema(schema: unknown): Validate {
  if (!isPlainObject(schema) && typeof schema !== 'boolean') {
    throw new Error('A JSON Schema must be a JSON object');
  }
  const problem = jsonProblem(schema);
  if (problem !== null) throw new Error(problem);
  // Ajv would compile such a schema into a validator that returns a promise, and a promise
  // looks like "valid" to anything that expects a boolean.
  if (hasAsyncKeyword(schema)) {
    throw new Error('Asynchronous schemas ("$async": true) are not supported');
  }
  const declared =
    isPlainObject(schema) && typeof schema.$schema === 'string'
      ? schema.$schema.replace(/#$/, '')
      : undefined;
  // One instance per schema, so equal `$id`s in different bundles cannot collide.
  const ajv = declared === DRAFT_2020_12 ? new Ajv2020(OPTIONS) : new Ajv(OPTIONS);
  const check = ajv.compile(schema);
  return (value) => {
    const valid: unknown = check(value);
    if (valid === true) return null;
    if (valid !== false) return ['The schema validator did not return a result'];
    const errors = check.errors ?? [];
    const reported = errors.slice(0, MAX_REPORTED_ERRORS).map(describeError);
    if (errors.length > reported.length) {
      reported.push(`and ${errors.length - reported.length} more`);
    }
    return reported;
  };
}

function hasAsyncKeyword(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasAsyncKeyword);
  if (!isPlainObject(schema)) return false;
  return schema.$async === true || Object.values(schema).some(hasAsyncKeyword);
}

/** Formats an error as `<JSON Pointer to the value>: <message>`. */
function describeError(error: ErrorObject): string {
  const extra =
    error.keyword === 'additionalProperties' ? ` ("${error.params.additionalProperty}")` : '';
  return `${error.instancePath || '(root)'}: ${error.message}${extra}`;
}
