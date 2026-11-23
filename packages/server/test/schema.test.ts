import { describe, expect, it } from 'vitest';
import { compileSchema } from '../src/replicants/schema.js';

const scoreSchema = {
  type: 'object',
  properties: {
    home: { type: 'integer', minimum: 0 },
    away: { type: 'integer', minimum: 0 },
  },
  required: ['home', 'away'],
  additionalProperties: false,
};

describe('compileSchema', () => {
  it('accepts a value that matches', () => {
    expect(compileSchema(scoreSchema)({ home: 1, away: 2 })).toBeNull();
  });

  it('reports every violation with the path to the offending value', () => {
    const errors = compileSchema(scoreSchema)({ home: -1, extra: true });
    expect(errors).toEqual([
      "(root): must have required property 'away'",
      '(root): must NOT have additional properties ("extra")',
      '/home: must be >= 0',
    ]);
  });

  it('reports nested paths as JSON Pointers', () => {
    const validate = compileSchema({
      type: 'object',
      properties: { teams: { type: 'array', items: { type: 'string' } } },
    });
    expect(validate({ teams: ['red', 5] })).toEqual(['/teams/1: must be string']);
  });

  it('follows local references', () => {
    const validate = compileSchema({
      definitions: { side: { type: 'integer' } },
      type: 'object',
      properties: { home: { $ref: '#/definitions/side' } },
    });
    expect(validate({ home: 1 })).toBeNull();
    expect(validate({ home: 'x' })).toEqual(['/home: must be integer']);
  });

  it.each([
    ['draft-07', 'http://json-schema.org/draft-07/schema#'],
    ['draft 2020-12', 'https://json-schema.org/draft/2020-12/schema'],
  ])('supports a schema that declares %s', (_label, $schema) => {
    const validate = compileSchema({ $schema, type: 'number' });
    expect(validate(1)).toBeNull();
    expect(validate('1')).toEqual(['(root): must be number']);
  });

  it('understands 2020-12 keywords only when the schema declares that draft', () => {
    const validate = compileSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      prefixItems: [{ type: 'string' }],
    });
    expect(validate([1])).toEqual(['/0: must be string']);
  });

  it('tolerates annotations it does not enforce: formats and x- keywords', () => {
    const validate = compileSchema({ type: 'string', format: 'date', 'x-secret': true });
    expect(validate('not a date')).toBeNull();
  });

  it('allows two schemas with the same $id', () => {
    const schema = { $id: 'https://example.invalid/score.json', type: 'number' };
    expect(() => {
      compileSchema(schema);
      compileSchema(schema);
    }).not.toThrow();
  });

  it.each([
    ['an unknown type', { type: 'strng' }],
    ['a broken reference', { $ref: '#/definitions/missing' }],
    ['an unsupported draft', { $schema: 'http://json-schema.org/draft-04/schema#' }],
    ['a number', 42],
    ['null', null],
    ['an array', []],
  ])('throws a readable error for %s', (_label, schema) => {
    expect(() => compileSchema(schema)).toThrow(Error);
  });
});
