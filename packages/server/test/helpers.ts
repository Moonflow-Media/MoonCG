import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '../src/kernel/config.js';
import { createLogger } from '../src/kernel/logger.js';

/** Absolute path of a file under `test/fixtures`. */
export function fixture(path: string): string {
  return fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
}

/** A logger that collects its lines instead of printing them. */
export function memoryLogger() {
  const lines: string[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}

/**
 * A server configuration for tests: any free port on loopback. The data directory is in the
 * system's temporary folder, so a test that forgets to pass its own storage still writes
 * nothing into the repository.
 */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    bundlesDir: fixture('bundles'),
    allowedOrigins: [],
    dataDir: join(tmpdir(), 'mooncg-test-data'),
    // A folder that does not exist: a test that wants modules names its own.
    modulesDir: join(tmpdir(), 'mooncg-test-no-modules'),
    publicUrl: undefined,
    extensionMemoryMb: 128,
    extensionStartTimeoutMs: 10_000,
    extensionHeartbeatTimeoutMs: 10_000,
    maxBodyBytes: 1024 * 1024,
    assetMaxFileBytes: 50 * 1024 * 1024,
    assetQuotaBytes: 500 * 1024 * 1024,
    assetMaxFiles: 1000,
    bundleMaxArchiveBytes: 100 * 1024 * 1024,
    bundleMaxUnpackedBytes: 500 * 1024 * 1024,
    bundleMaxFiles: 50_000,
    bundleBackupsKept: 3,
    bundleInstallTimeoutMs: 300_000,
    bundleNpmRegistry: undefined,
    registryIndexes: [],
    registryRefreshMs: 6 * 60 * 60_000,
    secureCookies: false,
    trustProxy: false,
    dev: false,
    watch: false,
    ...overrides,
  };
}
