import { describe, expect, it } from 'vitest';
import { jsonProblem, MAX_JSON_DEPTH } from '../src/json.js';
import { nest } from './nest.js';

describe('jsonProblem', () => {
  it.each([
    ['null', null],
    ['a boolean', false],
    ['a number', -1.5],
    ['a string', ''],
    ['an array', [1, 'a', null]],
    ['an object', { a: { b: [true] } }],
    ['an object without prototype', Object.assign(Object.create(null), { a: 1 })],
    ['a value nested to the limit', nest(MAX_JSON_DEPTH)],
  ])('accepts %s', (_label, value) => {
    expect(jsonProblem(value)).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a function', () => {}],
    ['a bigint', 1n],
    ['a symbol', Symbol('x')],
    ['an undefined member', { a: undefined }],
    ['a hole in an array', new Array(3)],
    ['a Date inside an array', [[new Date(0)]]],
  ])('explains why %s is not JSON', (_label, value) => {
    expect(jsonProblem(value)).toBeTypeOf('string');
  });

  it('rejects nesting beyond the documented limit', () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    expect(jsonProblem(nest(MAX_JSON_DEPTH + 1))).toMatch(/64/);
  });

  it('takes a smaller depth budget', () => {
    expect(jsonProblem([[1]], 2)).toBeNull();
    expect(jsonProblem([[1]], 1)).toBeTypeOf('string');
    expect(jsonProblem(1, 0)).toBeNull();
    expect(jsonProblem([], 0)).toBeTypeOf('string');
  });

  it('survives extreme nesting and cycles without overflowing the stack', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(jsonProblem(nest(100_000))).toBeTypeOf('string');
    expect(jsonProblem(cycle)).toBeTypeOf('string');
  });
});
