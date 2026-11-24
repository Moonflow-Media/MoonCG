import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testConfig } from './helpers.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const tests = fileURLToPath(new URL('.', import.meta.url));

describe('the test suite', () => {
  it('points servers at a data directory outside the repository', () => {
    const fromRepo = relative(repo, testConfig().dataDir);
    expect(fromRepo.startsWith('..') || isAbsolute(fromRepo)).toBe(true);
  });

  it('never names a data directory below its own fixtures', async () => {
    const offenders: string[] = [];
    for (const name of await readdir(tests)) {
      if (!name.endsWith('.test.ts') || name === 'housekeeping.test.ts') continue;
      const source = await readFile(`${tests}/${name}`, 'utf8');
      if (/dataDir:\s*(fixture\(|'unused')/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
