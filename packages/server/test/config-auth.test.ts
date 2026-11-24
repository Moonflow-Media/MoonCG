import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/kernel/config.js';
import { createLogger } from '../src/kernel/logger.js';

const cwd = resolve('/srv/mooncg');

describe('configuration for accounts', () => {
  it('turns secure cookies and proxy trust on by flag', () => {
    const config = loadConfig({ argv: ['--secure-cookies', '--trust-proxy'], env: {}, cwd });
    expect(config.secureCookies).toBe(true);
    expect(config.trustProxy).toBe(true);
  });

  it('reads them from the environment, where only "1" and "true" mean yes', () => {
    const on = { MOONCG_SECURE_COOKIES: '1', MOONCG_TRUST_PROXY: 'true' };
    expect(loadConfig({ argv: [], env: on, cwd })).toMatchObject({
      secureCookies: true,
      trustProxy: true,
    });
    const off = { MOONCG_SECURE_COOKIES: '0', MOONCG_TRUST_PROXY: 'no' };
    expect(loadConfig({ argv: [], env: off, cwd })).toMatchObject({
      secureCookies: false,
      trustProxy: false,
    });
  });
});

describe('the logger', () => {
  it('never writes an API token, whoever logs it', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.info('GET /b/x/graphics/a.html?token=mcg_Secret-1_x');
    logger.child('bundle:x').error('failed with mcg_Other2');
    expect(lines).toEqual([
      'INFO  GET /b/x/graphics/a.html?token=mcg_***',
      'ERROR [bundle:x] failed with mcg_***',
    ]);
  });
});
