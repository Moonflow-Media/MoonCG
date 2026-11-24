import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/kernel/config.js';
import { createLifecycle } from '../src/kernel/lifecycle.js';
import { createLogger } from '../src/kernel/logger.js';
import { memoryLogger } from './helpers.js';

describe('loadConfig', () => {
  const cwd = resolve('/srv/mooncg');

  it('has loopback defaults and looks for bundles next to the working directory', () => {
    expect(loadConfig({ argv: [], env: {}, cwd })).toEqual({
      port: 9090,
      host: '127.0.0.1',
      bundlesDir: resolve(cwd, 'bundles'),
      allowedOrigins: [],
      dataDir: resolve(cwd, 'data'),
      extensionMemoryMb: 256,
      extensionStartTimeoutMs: 10000,
      extensionHeartbeatTimeoutMs: 10000,
      maxBodyBytes: 1048576,
      secureCookies: false,
      trustProxy: false,
    });
  });

  it('reads overrides from the environment', () => {
    const env = { MOONCG_PORT: '8000', MOONCG_HOST: '0.0.0.0', MOONCG_BUNDLES_DIR: 'my-bundles' };
    expect(loadConfig({ argv: [], env, cwd })).toEqual({
      port: 8000,
      host: '0.0.0.0',
      bundlesDir: resolve(cwd, 'my-bundles'),
      allowedOrigins: [],
      dataDir: resolve(cwd, 'data'),
      extensionMemoryMb: 256,
      extensionStartTimeoutMs: 10000,
      extensionHeartbeatTimeoutMs: 10000,
      maxBodyBytes: 1048576,
      secureCookies: false,
      trustProxy: false,
    });
  });

  it('lets command line flags win over the environment', () => {
    const argv = ['--port', '7000', '--host', '::1', '--bundles-dir', 'examples'];
    const env = { MOONCG_PORT: '8000', MOONCG_HOST: '0.0.0.0', MOONCG_BUNDLES_DIR: 'ignored' };
    expect(loadConfig({ argv, env, cwd })).toEqual({
      port: 7000,
      host: '::1',
      bundlesDir: resolve(cwd, 'examples'),
      allowedOrigins: [],
      dataDir: resolve(cwd, 'data'),
      extensionMemoryMb: 256,
      extensionStartTimeoutMs: 10000,
      extensionHeartbeatTimeoutMs: 10000,
      maxBodyBytes: 1048576,
      secureCookies: false,
      trustProxy: false,
    });
  });

  it('accepts port 0 for an ephemeral port', () => {
    expect(loadConfig({ argv: ['--port', '0'], env: {}, cwd }).port).toBe(0);
  });

  it.each([['abc'], ['70000'], ['-1'], ['80.5'], ['']])('rejects the port %j', (port) => {
    expect(() => loadConfig({ argv: [], env: { MOONCG_PORT: port }, cwd })).toThrow(/port/i);
  });

  it('rejects unknown flags', () => {
    expect(() => loadConfig({ argv: ['--prot', '1'], env: {}, cwd })).toThrow(/prot/);
  });
});

describe('createLogger', () => {
  it('writes one line per message with its level', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.info('listening');
    logger.warn('careful');
    logger.error('broken');

    expect(lines).toEqual(['INFO  listening', 'WARN  careful', 'ERROR broken']);
  });

  it('prefixes lines of a child logger with its scope', () => {
    const lines: string[] = [];
    createLogger((line) => lines.push(line))
      .child('bundle:scoreboard')
      .info('ready');
    expect(lines).toEqual(['INFO  [bundle:scoreboard] ready']);
  });
});

describe('createLifecycle', () => {
  it('disposes services in reverse order of registration, one after another', async () => {
    const order: string[] = [];
    const lifecycle = createLifecycle(memoryLogger().logger);
    lifecycle.add('first', () => {
      order.push('first');
    });
    lifecycle.add('second', async () => {
      await new Promise((done) => setTimeout(done, 5));
      order.push('second');
    });
    lifecycle.add('third', () => {
      order.push('third');
    });

    await lifecycle.dispose();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('keeps disposing when one service fails, and logs the failure', async () => {
    const order: string[] = [];
    const { logger, lines } = memoryLogger();
    const lifecycle = createLifecycle(logger);
    lifecycle.add('first', () => {
      order.push('first');
    });
    lifecycle.add('second', () => {
      throw new Error('stuck');
    });

    await lifecycle.dispose();

    expect(order).toEqual(['first']);
    expect(lines).toEqual(['ERROR Failed to dispose "second": stuck']);
  });

  it('disposes each service only once', async () => {
    let count = 0;
    const lifecycle = createLifecycle(memoryLogger().logger);
    lifecycle.add('only', () => {
      count++;
    });

    await lifecycle.dispose();
    await lifecycle.dispose();

    expect(count).toBe(1);
  });
});
