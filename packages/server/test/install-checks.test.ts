import { describe, expect, it } from 'vitest';
import { engineProblem, installProblems } from '../src/bundles/dependencies.js';

const bundle = (name: string, version = '1.0.0', dependencies: Record<string, string> = {}) => ({
  name,
  version,
  dependencies,
});

describe('engineProblem', () => {
  it('accepts a bundle that names no engine, or one this MoonCG satisfies', () => {
    expect(engineProblem(undefined, '0.6.0')).toBeUndefined();
    expect(engineProblem('>=0.6.0', '0.6.0')).toBeUndefined();
    expect(engineProblem('^0.6.0 || ^1.0.0', '1.4.2')).toBeUndefined();
    expect(engineProblem('*', '0.6.0')).toBeUndefined();
  });

  it('says which MoonCG a bundle needs when this is not it', () => {
    expect(engineProblem('>=1.0.0', '0.6.0')).toBe(
      'engine.mooncg: needs MoonCG >=1.0.0, but this is 0.6.0',
    );
    expect(engineProblem('^0.5.0', '0.6.0')).toBe(
      'engine.mooncg: needs MoonCG ^0.5.0, but this is 0.6.0',
    );
  });

  it('refuses what is no version range', () => {
    expect(engineProblem('latest and greatest', '0.6.0')).toBe(
      'engine.mooncg: "latest and greatest" is not a version range',
    );
  });

  it('takes a prerelease of MoonCG as the version it leads to', () => {
    expect(engineProblem('>=0.7.0-0', '0.7.0-beta.1')).toBeUndefined();
    expect(engineProblem('>=0.6.0', '0.7.0-beta.1')).toBeUndefined();
  });
});

describe('installProblems', () => {
  const installed = [bundle('data', '2.1.0'), bundle('board', '1.0.0', { data: '^2.0.0' })];
  const check = (
    candidate: Parameters<typeof installProblems>[0]['candidate'],
    target?: string,
    more: Partial<Parameters<typeof installProblems>[0]> = {},
  ) => installProblems({ candidate, installed, mooncg: '0.6.0', target, ...more });

  it('finds nothing wrong with a new bundle whose needs are met', () => {
    expect(check(bundle('ticker', '1.0.0', { data: '>=2.0.0', board: '1.x' }))).toEqual([]);
    expect(check({ ...bundle('ticker'), engine: '>=0.6.0' })).toEqual([]);
  });

  it('refuses to install over a bundle that is there', () => {
    expect(check(bundle('data', '3.0.0'))).toEqual([
      'Bundle "data" is already installed (version 2.1.0); update it instead',
    ]);
  });

  it('refuses to install over a folder whose manifest is unusable', () => {
    expect(check(bundle('wreck'), undefined, { taken: ['wreck'] })).toEqual([
      'The bundles folder already has a folder "wreck"; remove it first',
    ]);
  });

  it('updates only the bundle that was named', () => {
    expect(check(bundle('data', '2.2.0'), 'data')).toEqual([]);
    expect(check(bundle('ticker', '1.0.0'), 'data')).toEqual([
      'name: this is bundle "ticker", not "data"',
    ]);
    expect(check(bundle('ticker', '1.0.0'), 'ticker')).toEqual([
      'Bundle "ticker" is not installed',
    ]);
  });

  it('reports the engine and every dependency that is not met', () => {
    expect(
      check({
        ...bundle('ticker', '1.0.0', { data: '^3.0.0', missing: '*', board: 'nonsense!' }),
        engine: '>=1.0.0',
      }),
    ).toEqual([
      'engine.mooncg: needs MoonCG >=1.0.0, but this is 0.6.0',
      'dependencies.data: needs version ^3.0.0, but 2.1.0 is installed',
      'dependencies.missing: bundle "missing" is not installed',
      'dependencies.board: "nonsense!" is not a version range',
    ]);
  });

  it('refuses a bundle that depends on itself or closes a cycle', () => {
    expect(check(bundle('ticker', '1.0.0', { ticker: '*' }))).toEqual([
      'dependencies.ticker: a bundle cannot depend on itself',
    ]);
    // board needs data; a data that needs board would close the circle.
    expect(check(bundle('data', '2.2.0', { board: '*' }), 'data')).toEqual([
      'dependencies: part of a cycle (data → board → data)',
    ]);
  });

  it('refuses an update that the bundles depending on it cannot use', () => {
    expect(check(bundle('data', '3.0.0'), 'data')).toEqual([
      'Bundle "board" needs data ^2.0.0, but this is version 3.0.0',
    ]);
    expect(check(bundle('data', '2.9.0'), 'data')).toEqual([]);
  });
});
