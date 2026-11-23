import { describe, expect, it } from 'vitest';
import { schemaToType, valueToType } from '../src/generate-types.js';

const flat = (type: string) => type.replace(/\s+/g, ' ').trim();
const type = (schema: unknown) => flat(schemaToType(schema));
const arrayOf = (items: unknown) => type({ type: 'array', items });

describe('unions inside arrays', () => {
  it.each([
    [['<', '>'], '("<" | ">")[]'],
    [['{', '}'], '("{" | "}")[]'],
    [['[', ']'], '("[" | "]")[]'],
    [['(', ')'], '("(" | ")")[]'],
    [['a', '<'], '("a" | "<")[]'],
    [['>', 1, null], '(">" | 1 | null)[]'],
  ])('parenthesises the union of enum members %j', (members, expected) => {
    expect(arrayOf({ enum: members })).toBe(expected);
  });

  it.each([
    [{ const: 'a | b' }, '"a | b"[]'],
    [{ const: 'a & b' }, '"a & b"[]'],
    [{ enum: ['<'] }, '"<"[]'],
    [{ enum: ['only | one'] }, '"only | one"[]'],
  ])('does not parenthesise the single literal %j', (items, expected) => {
    expect(arrayOf(items)).toBe(expected);
  });

  it('parenthesises unions with bracket literals in intersections, tuples and rest elements', () => {
    const brackets = { enum: ['<', '>'] };
    expect(type({ allOf: [brackets, { type: 'string' }] })).toBe('("<" | ">") & string');
    expect(type({ type: 'array', prefixItems: [brackets], items: brackets })).toBe(
      '[("<" | ">")?, ...("<" | ">")[]]',
    );
  });

  it('parenthesises unions inferred from example values', () => {
    expect(flat(valueToType(['<', 1]))).toBe('(string | number)[]');
    expect(flat(valueToType([{ 'a|b': 1 }]))).toBe('{ "a|b": number; }[]');
  });
});

describe('tuples', () => {
  const pair = [{ type: 'string' }, { type: 'number' }];

  it('makes members beyond minItems optional, because shorter arrays are valid', () => {
    expect(type({ type: 'array', prefixItems: pair, items: false })).toBe('[string?, number?]');
    expect(type({ type: 'array', prefixItems: pair, items: false, minItems: 1 })).toBe(
      '[string, number?]',
    );
    expect(type({ type: 'array', prefixItems: pair, items: false, minItems: 2 })).toBe(
      '[string, number]',
    );
  });

  it('does the same for draft-07 tuples', () => {
    expect(type({ type: 'array', items: pair })).toBe('[string?, number?, ...unknown[]]');
    expect(type({ type: 'array', items: pair, minItems: 1, additionalItems: false })).toBe(
      '[string, number?]',
    );
  });

  it('types the rest from items or additionalItems', () => {
    expect(type({ type: 'array', prefixItems: pair, items: { type: 'boolean' } })).toBe(
      '[string?, number?, ...boolean[]]',
    );
    expect(
      type({ type: 'array', items: pair, additionalItems: { type: ['boolean', 'null'] } }),
    ).toBe('[string?, number?, ...(boolean | null)[]]');
    expect(type({ type: 'array', prefixItems: pair })).toBe('[string?, number?, ...unknown[]]');
  });

  it('requires at most the listed members, whatever minItems says', () => {
    expect(type({ type: 'array', prefixItems: pair, minItems: 5 })).toBe(
      '[string, number, ...unknown[]]',
    );
  });

  it('parenthesises an optional member that is a union', () => {
    expect(type({ type: 'array', prefixItems: [{ type: ['string', 'null'] }], items: false })).toBe(
      '[(string | null)?]',
    );
  });
});

describe('references', () => {
  it('decodes URI-encoded pointers', () => {
    const schema = {
      definitions: {
        'a b': { type: 'string' },
        'c/d': { type: 'number' },
        'e%f': { type: 'boolean' },
      },
      type: 'object',
      properties: {
        spaced: { $ref: '#/definitions/a%20b' },
        slashed: { $ref: '#/definitions/c~1d' },
        percent: { $ref: '#/definitions/e%25f' },
      },
      required: ['spaced', 'slashed', 'percent'],
    };
    expect(type(schema)).toBe('{ spaced: string; slashed: number; percent: boolean; }');
  });

  it('falls back to unknown for a pointer that is not valid URI encoding', () => {
    expect(type({ definitions: { a: { type: 'string' } }, $ref: '#/definitions/%E0%A4%A' })).toBe(
      'unknown',
    );
  });

  it('stops expanding a chain of references that would explode the output', () => {
    const definitions: Record<string, unknown> = { d30: { type: 'string' } };
    for (let level = 0; level < 30; level++) {
      const next = { $ref: `#/definitions/d${level + 1}` };
      definitions[`d${level}`] = {
        type: 'object',
        properties: { left: next, right: next },
        required: ['left', 'right'],
      };
    }
    const started = Date.now();

    const text = schemaToType({ definitions, $ref: '#/definitions/d0' });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(text.length).toBeLessThan(200_000);
    expect(text).toContain('unknown');
    expect(text).toContain('left: {');
  });

  it('still expands an ordinary amount of shared references in full', () => {
    const schema = {
      definitions: { side: { type: 'integer' } },
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`p${index}`, { $ref: '#/definitions/side' }]),
      ),
    };
    expect(schemaToType(schema)).not.toContain('unknown');
  });
});
