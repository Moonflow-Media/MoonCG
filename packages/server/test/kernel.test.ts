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
      modulesDir: resolve(cwd, 'modules'),
      publicUrl: undefined,
      extensionMemoryMb: 256,
      extensionStartTimeoutMs: 10000,
      extensionHeartbeatTimeoutMs: 10000,
      maxBodyBytes: 1048576,
      maxStreamBodyBytes: 1024 ** 3,
      assetMaxFileBytes: 52428800,
      assetQuotaBytes: 524288000,
      assetMaxFiles: 1000,
      bundleMaxArchiveBytes: 100 * 1024 * 1024,
      bundleMaxUnpackedBytes: 500 * 1024 * 1024,
      bundleMaxFiles: 50_000,
      bundleBackupsKept: 3,
      bundleInstallTimeoutMs: 300_000,
      bundleNpmRegistry: undefined,
      registryIndexes: [],
      registryRefreshMs: 6 * 60 * 60_000,
      registryAllowPrivate: [],
      registryAllowPrivateHttp: false,
      secureCookies: false,
      trustProxy: false,
      dev: false,
      watch: false,
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
      modulesDir: resolve(cwd, 'modules'),
      publicUrl: undefined,
      extensionMemoryMb: 256,
      extensionStartTimeoutMs: 10000,
      extensionHeartbeatTimeoutMs: 10000,
      maxBodyBytes: 1048576,
      maxStreamBodyBytes: 1024 ** 3,
      assetMaxFileBytes: 52428800,
      assetQuotaBytes: 524288000,
      assetMaxFiles: 1000,
      bundleMaxArchiveBytes: 100 * 1024 * 1024,
      bundleMaxUnpackedBytes: 500 * 1024 * 1024,
      bundleMaxFiles: 50_000,
      bundleBackupsKept: 3,
      bundleInstallTimeoutMs: 300_000,
      bundleNpmRegistry: undefined,
      registryIndexes: [],
      registryRefreshMs: 6 * 60 * 60_000,
      registryAllowPrivate: [],
      registryAllowPrivateHttp: false,
      secureCookies: false,
      trustProxy: false,
      dev: false,
      watch: false,
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
      modulesDir: resolve(cwd, 'modules'),
      publicUrl: undefined,
      extensionMemoryMb: 256,
      extensionStartTimeoutMs: 10000,
      extensionHeartbeatTimeoutMs: 10000,
      maxBodyBytes: 1048576,
      maxStreamBodyBytes: 1024 ** 3,
      assetMaxFileBytes: 52428800,
      assetQuotaBytes: 524288000,
      assetMaxFiles: 1000,
      bundleMaxArchiveBytes: 100 * 1024 * 1024,
      bundleMaxUnpackedBytes: 500 * 1024 * 1024,
      bundleMaxFiles: 50_000,
      bundleBackupsKept: 3,
      bundleInstallTimeoutMs: 300_000,
      bundleNpmRegistry: undefined,
      registryIndexes: [],
      registryRefreshMs: 6 * 60 * 60_000,
      registryAllowPrivate: [],
      registryAllowPrivateHttp: false,
      secureCookies: false,
      trustProxy: false,
      dev: false,
      watch: false,
    });
  });

  it('takes the limit of streamed bodies from flags, the environment and the file', () => {
    const file = { values: { maxStreamBodyBytes: 5000 }, dir: cwd, path: resolve(cwd, 'm.json') };
    expect(loadConfig({ argv: [], env: {}, cwd, file }).maxStreamBodyBytes).toBe(5000);
    const env = { MOONCG_MAX_STREAM_BODY_BYTES: '4000' };
    expect(loadConfig({ argv: [], env, cwd, file }).maxStreamBodyBytes).toBe(4000);
    const argv = ['--max-stream-body-bytes', '3000'];
    expect(loadConfig({ argv, env, cwd, file }).maxStreamBodyBytes).toBe(3000);
    const wrong = { values: { maxStreamBodyBytes: -1 }, dir: cwd, path: resolve(cwd, 'm.json') };
    expect(() => loadConfig({ argv: [], env: {}, cwd, file: wrong })).toThrow(/maxStreamBodyBytes/);
    expect(() => loadConfig({ argv: ['--max-stream-body-bytes', 'lots'], env: {}, cwd })).toThrow();
  });

  it('takes the limits for assets from flags and the environment', () => {
    const argv = ['--asset-max-file-bytes', '1000', '--asset-max-files', '7'];
    const env = { MOONCG_ASSET_MAX_FILE_BYTES: '5', MOONCG_ASSET_QUOTA_BYTES: '2000' };
    expect(loadConfig({ argv, env, cwd })).toMatchObject({
      assetMaxFileBytes: 1000,
      assetQuotaBytes: 2000,
      assetMaxFiles: 7,
    });
    expect(() => loadConfig({ argv: ['--asset-quota-bytes', '0'], env: {}, cwd })).toThrow(
      /asset/i,
    );
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

  it('takes registry indexes from flags, the environment and the file, in that order', () => {
    const one = 'https://one.example.org/index.json';
    const two = 'https://two.example.org/index.json';
    const file = { values: { registryIndexes: [two] }, dir: cwd, path: resolve(cwd, 'm.json') };
    expect(loadConfig({ argv: [], env: {}, cwd, file }).registryIndexes).toEqual([two]);
    expect(
      loadConfig({ argv: [], env: { MOONCG_REGISTRY_INDEXES: `${one},${two}` }, cwd, file })
        .registryIndexes,
    ).toEqual([one, two]);
    const argv = ['--registry-index', one, '--registry-refresh-ms', '60000'];
    expect(loadConfig({ argv, env: {}, cwd, file })).toMatchObject({
      registryIndexes: [one],
      registryRefreshMs: 60_000,
    });
  });

  it('refuses a registry index that is not https, without saying its credentials', () => {
    const argv = ['--registry-index', 'http://reader:s3cret@example.org/index.json'];
    expect(() => loadConfig({ argv, env: {}, cwd })).toThrow(/https/);
    expect(() => loadConfig({ argv, env: {}, cwd })).not.toThrow(/s3cret/);
    const file = { values: { registryIndexes: 'x' }, dir: cwd, path: resolve(cwd, 'm.json') };
    expect(() => loadConfig({ argv: [], env: {}, cwd, file })).toThrow(/registryIndexes/);
  });

  it('takes private hosts and networks for the registry from flags, the environment and the file', () => {
    const file = {
      values: { registryAllowPrivate: ['git.corp.example'], registryAllowPrivateHttp: true },
      dir: cwd,
      path: resolve(cwd, 'm.json'),
    };
    expect(loadConfig({ argv: [], env: {}, cwd, file })).toMatchObject({
      registryAllowPrivate: ['git.corp.example'],
      registryAllowPrivateHttp: true,
    });
    const env = {
      MOONCG_REGISTRY_ALLOW_PRIVATE: '10.0.0.0/8, fd00::/8',
      MOONCG_REGISTRY_ALLOW_PRIVATE_HTTP: '0',
    };
    expect(loadConfig({ argv: [], env, cwd, file })).toMatchObject({
      registryAllowPrivate: ['10.0.0.0/8', 'fd00::/8'],
      registryAllowPrivateHttp: false,
    });
    const argv = [
      '--registry-allow-private',
      '192.168.5.0/24',
      '--registry-allow-private',
      'index.intranet',
      '--registry-allow-private-http',
    ];
    expect(loadConfig({ argv, env, cwd, file })).toMatchObject({
      registryAllowPrivate: ['192.168.5.0/24', 'index.intranet'],
      registryAllowPrivateHttp: true,
    });
  });

  it('refuses a private entry that would open more than a private network', () => {
    for (const entry of ['127.0.0.1', '169.254.169.254', '8.8.8.0/24', 'https://x.example']) {
      expect(() => loadConfig({ argv: ['--registry-allow-private', entry], env: {}, cwd })).toThrow(
        /registry-allow-private|private/,
      );
    }
    const file = { values: { registryAllowPrivate: 'x' }, dir: cwd, path: resolve(cwd, 'm.json') };
    expect(() => loadConfig({ argv: [], env: {}, cwd, file })).toThrow(/registryAllowPrivate/);
    const http = { values: { registryAllowPrivateHttp: 'yes' }, dir: cwd, path: 'm.json' };
    expect(() => loadConfig({ argv: [], env: {}, cwd, file: http })).toThrow(
      /registryAllowPrivateHttp/,
    );
  });

  it('takes a plain http index on a private host only when both settings allow it', () => {
    const url = 'http://index.intranet/index.json';
    expect(() => loadConfig({ argv: ['--registry-index', url], env: {}, cwd })).toThrow(/https/);
    const allowed = ['--registry-index', url, '--registry-allow-private', 'index.intranet'];
    expect(() => loadConfig({ argv: allowed, env: {}, cwd })).toThrow(/https/);
    expect(
      loadConfig({ argv: [...allowed, '--registry-allow-private-http'], env: {}, cwd })
        .registryIndexes,
    ).toEqual([url]);
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
