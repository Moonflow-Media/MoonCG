import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/kernel/config.js';
import { installProcessGuard } from '../src/kernel/process-guard.js';
import { memoryLogger } from './helpers.js';

describe('loadConfig allowed origins', () => {
  const cwd = process.cwd();

  it('has no extra allowed origins by default', () => {
    expect(loadConfig({ argv: [], env: {}, cwd }).allowedOrigins).toEqual([]);
  });

  it('reads a comma-separated list from the environment', () => {
    const env = { MOONCG_ALLOWED_ORIGINS: 'http://localhost:5173, https://studio.example ' };
    expect(loadConfig({ argv: [], env, cwd }).allowedOrigins).toEqual([
      'http://localhost:5173',
      'https://studio.example',
    ]);
  });

  it('takes a repeatable flag that wins over the environment and normalizes origins', () => {
    const argv = [
      '--allowed-origin',
      'http://LOCALHOST:5173/',
      '--allowed-origin',
      'https://a.example',
    ];
    const env = { MOONCG_ALLOWED_ORIGINS: 'http://ignored.example' };
    expect(loadConfig({ argv, env, cwd }).allowedOrigins).toEqual([
      'http://localhost:5173',
      'https://a.example',
    ]);
  });

  it('rejects something that is not an origin', () => {
    expect(() => loadConfig({ argv: ['--allowed-origin', 'localhost'], env: {}, cwd })).toThrow(
      /origin/i,
    );
  });
});

describe('installProcessGuard', () => {
  function guarded() {
    const target = new EventEmitter();
    const { logger, lines } = memoryLogger();
    installProcessGuard(target, logger);
    return { target, lines };
  }

  it('logs an unhandled rejection instead of letting it end the process', () => {
    const { target, lines } = guarded();
    target.emit('unhandledRejection', new Error('late failure'));
    expect(lines).toEqual([
      'ERROR Unhandled promise rejection (the server keeps running): late failure',
    ]);
  });

  it('logs an uncaught exception instead of letting it end the process', () => {
    const { target, lines } = guarded();
    target.emit('uncaughtException', new Error('thrown in a timer'));
    expect(lines).toEqual([
      'ERROR Uncaught exception (the server keeps running): thrown in a timer',
    ]);
  });

  it('copes with a rejection reason that is not an Error', () => {
    const { target, lines } = guarded();
    target.emit('unhandledRejection', 'just a string');
    expect(lines[0]).toContain('just a string');
  });
});
