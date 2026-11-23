import { describe, expect, it } from 'vitest';
import { generateTypes, schemaToType, valueToType } from '../src/generate-types.js';

/** Collapses whitespace so type shapes can be compared without caring about layout. */
const flat = (type: string) => type.replace(/\s+/g, ' ').trim();
const type = (schema: unknown) => flat(schemaToType(schema));

describe('schemaToType', () => {
  it.each([
    [{ type: 'string' }, 'string'],
    [{ type: 'number' }, 'number'],
    [{ type: 'integer' }, 'number'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'null' }, 'null'],
    [{ type: ['string', 'null'] }, 'string | null'],
    [{}, 'unknown'],
    [true, 'unknown'],
    [false, 'never'],
    [{ const: 'on' }, '"on"'],
    [{ enum: ['a', 1, null, true] }, '"a" | 1 | null | true'],
    [{ type: 'string', enum: ['a', 'b'] }, '"a" | "b"'],
  ])('maps %j to %s', (schema, expected) => {
    expect(type(schema)).toBe(expected);
  });

  it('maps arrays, parenthesising union elements', () => {
    expect(type({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(type({ type: 'array', items: { type: ['string', 'null'] } })).toBe('(string | null)[]');
    expect(type({ type: 'array' })).toBe('unknown[]');
  });

  it('maps tuples of both drafts', () => {
    const draft7 = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };
    const draft2020 = {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: false,
    };
    expect(type({ ...draft7, minItems: 2 })).toBe('[string, number, ...unknown[]]');
    expect(type({ ...draft7, minItems: 2, additionalItems: false })).toBe('[string, number]');
    expect(type({ ...draft2020, minItems: 2 })).toBe('[string, number]');
  });

  it('maps objects with required and optional members', () => {
    const schema = {
      type: 'object',
      properties: { home: { type: 'integer' }, 'away-team': { type: 'string' } },
      required: ['home'],
    };
    expect(type(schema)).toBe('{ home: number; "away-team"?: string; }');
  });

  it('maps additional properties', () => {
    expect(type({ type: 'object' })).toBe('Record<string, unknown>');
    expect(type({ type: 'object', additionalProperties: false })).toBe('Record<string, never>');
    expect(type({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      'Record<string, number>',
    );
    expect(
      type({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: true,
      }),
    ).toBe('{ a: string; [key: string]: unknown; }');
  });

  it('treats a schema with properties but no type as an object', () => {
    expect(type({ properties: { a: { type: 'string' } } })).toBe('{ a?: string; }');
  });

  it('nests objects with indentation', () => {
    const schema = {
      type: 'object',
      properties: {
        teams: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        },
      },
      required: ['teams'],
    };
    expect(schemaToType(schema)).toBe('{\n  teams: {\n    name: string;\n  }[];\n}');
  });

  it('maps combinators', () => {
    expect(type({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
    expect(type({ oneOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(
      type({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      }),
    ).toBe('{ a: string; } & { b: number; }');
    expect(
      type({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }),
    ).toBe('(string | number)[]');
  });

  it('resolves local references from both definition keywords', () => {
    const schema = {
      definitions: { side: { type: 'integer' } },
      $defs: { name: { type: 'string' } },
      type: 'object',
      properties: {
        home: { $ref: '#/definitions/side' },
        label: { $ref: '#/$defs/name' },
      },
      required: ['home', 'label'],
    };
    expect(type(schema)).toBe('{ home: number; label: string; }');
  });

  it('falls back to unknown for what it cannot express', () => {
    const recursive = {
      definitions: {
        node: { type: 'object', properties: { next: { $ref: '#/definitions/node' } } },
      },
      $ref: '#/definitions/node',
    };
    expect(type(recursive)).toBe('{ next?: unknown; }');
    expect(type({ $ref: 'https://example.invalid/other.json' })).toBe('unknown');
    expect(type({ $ref: '#/definitions/missing' })).toBe('unknown');
    expect(type({ not: { type: 'string' } })).toBe('unknown');
  });
});

describe('valueToType', () => {
  it.each([
    [1, 'number'],
    ['a', 'string'],
    [true, 'boolean'],
    [null, 'null'],
    [[], 'unknown[]'],
    [[1, 2], 'number[]'],
    [[1, 'a', null], '(number | string | null)[]'],
    [{}, 'Record<string, unknown>'],
    [
      { home: 0, tags: ['a'], 'odd key': null },
      '{ home: number; tags: string[]; "odd key": null; }',
    ],
  ])('infers %j as %s', (value, expected) => {
    expect(flat(valueToType(value))).toBe(expected);
  });
});

describe('generateTypes', () => {
  it('augments the SDK replicant map under the bare and the qualified name', () => {
    const text = generateTypes('scoreboard', {
      score: {
        schema: { type: 'object', properties: { home: { type: 'integer' } }, required: ['home'] },
      },
      teams: { default: ['red'] },
      anything: {},
      'odd.name': { default: 1 },
    });

    expect(text).toBe(`// Generated by \`mooncg types\` from mooncg.json. Do not edit.
import '@mooncg/sdk/client';

declare module '@mooncg/sdk/client' {
  interface ReplicantMap {
    score: {
      home: number;
    };
    'scoreboard:score': ReplicantMap['score'];
    teams: string[];
    'scoreboard:teams': ReplicantMap['teams'];
    anything: unknown;
    'scoreboard:anything': ReplicantMap['anything'];
    'odd.name': number;
    'scoreboard:odd.name': ReplicantMap['odd.name'];
  }
}
`);
  });

  it('prefers the schema over the default', () => {
    const text = generateTypes('b', { n: { schema: { type: 'string' }, default: 1 } });
    expect(text).toContain('    n: string;');
  });

  it('generates an empty map for a bundle without replicants', () => {
    expect(generateTypes('b', {})).toContain('interface ReplicantMap {}');
  });
});
