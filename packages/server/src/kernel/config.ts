import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_BACKUPS_KEPT } from '@mooncg/core';
import { DEFAULT_INSTALL_LIMITS } from '../install/files.js';

/** How long Git and npm may each take while a bundle is installed, unless configured. */
export const DEFAULT_BUNDLE_INSTALL_TIMEOUT_MS = 5 * 60_000;

/** The largest asset file unless configured otherwise: 50 MiB. */
export const DEFAULT_ASSET_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** What one asset category may hold unless configured otherwise: 500 MiB. */
export const DEFAULT_ASSET_QUOTA_BYTES = 500 * 1024 * 1024;

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  /** Absolute path of the folder that holds one folder per bundle. */
  readonly bundlesDir: string;
  /**
   * Origins besides the server's own whose pages may open a WebSocket, such as a bundle's
   * development server. Each is a normalized origin like `http://localhost:5173`.
   */
  readonly allowedOrigins: readonly string[];
  /** Absolute path of the folder for everything the server stores, such as `mooncg.db`. */
  readonly dataDir: string;
  /** The heap each bundle extension may use, in MiB, before its thread is ended. */
  readonly extensionMemoryMb: number;
  /** How long a bundle extension may take to start, in milliseconds. */
  readonly extensionStartTimeoutMs: number;
  /**
   * How long a running extension may go without answering the server's heartbeat before it
   * is treated as crashed. Uninterrupted synchronous work longer than this gets it restarted.
   */
  readonly extensionHeartbeatTimeoutMs: number;
  /** The largest request body a bundle's HTTP route accepts, in bytes. */
  readonly maxBodyBytes: number;
  /** The largest file that can be uploaded as an asset, in bytes. */
  readonly assetMaxFileBytes: number;
  /** How many bytes the files of one asset category of one bundle may take together. */
  readonly assetQuotaBytes: number;
  /** How many files one asset category of one bundle may hold. */
  readonly assetMaxFiles: number;
  /** The largest ZIP archive a bundle is installed from, in bytes. */
  readonly bundleMaxArchiveBytes: number;
  /** How many bytes the files of a bundle that is installed may take together. */
  readonly bundleMaxUnpackedBytes: number;
  /** How many files and folders a bundle that is installed may consist of. */
  readonly bundleMaxFiles: number;
  /** How many earlier versions of each bundle are kept in `<data-dir>/backups`. */
  readonly bundleBackupsKept: number;
  /** How long fetching with Git, and installing with npm, may each take, in milliseconds. */
  readonly bundleInstallTimeoutMs: number;
  /**
   * The registry the npm packages of bundles are fetched from, as an `https://` address
   * without credentials. Without it, npm's own. The server does not read anybody's
   * `.npmrc`, so this is where another registry is named.
   */
  readonly bundleNpmRegistry: string | undefined;
  /**
   * Marks the session cookies `Secure`, so browsers send them over HTTPS only. Turn it on
   * whenever people reach the server through HTTPS.
   */
  readonly secureCookies: boolean;
  /**
   * Says that the server sits behind a reverse proxy that sets `X-Forwarded-Proto` and
   * `X-Forwarded-For`. Only then are these headers believed: for marking cookies `Secure` on
   * HTTPS requests and for telling clients apart when logins are throttled.
   */
  readonly trustProxy: boolean;
}

export interface ConfigSources {
  /** Command line arguments without the node binary and script. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/**
 * Builds the configuration. Each flag (`--port`, `--host`, `--bundles-dir`, `--data-dir`,
 * `--extension-memory-mb`, `--extension-start-timeout-ms`, `--extension-heartbeat-timeout-ms`,
 * `--max-body-bytes`, `--asset-max-file-bytes`, `--asset-quota-bytes`, `--asset-max-files`,
 * `--bundle-max-archive-bytes`, `--bundle-max-unpacked-bytes`, `--bundle-max-files`,
 * `--bundle-backups-kept`, `--bundle-install-timeout-ms`, `--bundle-npm-registry`, repeatable `--allowed-origin`, and the switches `--secure-cookies` and
 * `--trust-proxy`) wins over its environment variable: the flag in capitals with `MOONCG_` in
 * front and underscores for dashes, such as `MOONCG_DATA_DIR`, and `MOONCG_ALLOWED_ORIGINS` as
 * a comma-separated list. A switch is on in the environment as `1` or `true`. That wins over
 * the default.
 */
export function loadConfig({ argv, env, cwd }: ConfigSources): ServerConfig {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'bundles-dir': { type: 'string' },
      'data-dir': { type: 'string' },
      'extension-memory-mb': { type: 'string' },
      'extension-start-timeout-ms': { type: 'string' },
      'extension-heartbeat-timeout-ms': { type: 'string' },
      'max-body-bytes': { type: 'string' },
      'asset-max-file-bytes': { type: 'string' },
      'asset-quota-bytes': { type: 'string' },
      'asset-max-files': { type: 'string' },
      'bundle-max-archive-bytes': { type: 'string' },
      'bundle-max-unpacked-bytes': { type: 'string' },
      'bundle-max-files': { type: 'string' },
      'bundle-backups-kept': { type: 'string' },
      'bundle-install-timeout-ms': { type: 'string' },
      'bundle-npm-registry': { type: 'string' },
      'allowed-origin': { type: 'string', multiple: true },
      'secure-cookies': { type: 'boolean' },
      'trust-proxy': { type: 'boolean' },
    },
  });
  const on = (value: string | undefined) => value === '1' || value === 'true';
  const origins = values['allowed-origin'] ?? env.MOONCG_ALLOWED_ORIGINS?.split(',') ?? [];
  return {
    port: parsePort(values.port ?? env.MOONCG_PORT ?? '9090'),
    // Loopback unless asked otherwise: `--host 0.0.0.0` opens the server to the network.
    host: values.host ?? env.MOONCG_HOST ?? '127.0.0.1',
    bundlesDir: resolve(cwd, values['bundles-dir'] ?? env.MOONCG_BUNDLES_DIR ?? 'bundles'),
    allowedOrigins: origins.map((origin) => parseOrigin(origin.trim())),
    dataDir: resolve(cwd, values['data-dir'] ?? env.MOONCG_DATA_DIR ?? 'data'),
    extensionMemoryMb: parsePositive(
      'extension memory',
      values['extension-memory-mb'] ?? env.MOONCG_EXTENSION_MEMORY_MB ?? '256',
    ),
    extensionStartTimeoutMs: parsePositive(
      'extension start timeout',
      values['extension-start-timeout-ms'] ?? env.MOONCG_EXTENSION_START_TIMEOUT_MS ?? '10000',
    ),
    extensionHeartbeatTimeoutMs: parsePositive(
      'extension heartbeat timeout',
      values['extension-heartbeat-timeout-ms'] ??
        env.MOONCG_EXTENSION_HEARTBEAT_TIMEOUT_MS ??
        '10000',
    ),
    maxBodyBytes: parsePositive(
      'body size',
      values['max-body-bytes'] ?? env.MOONCG_MAX_BODY_BYTES ?? String(1024 * 1024),
    ),
    assetMaxFileBytes: parsePositive(
      'asset file size',
      values['asset-max-file-bytes'] ??
        env.MOONCG_ASSET_MAX_FILE_BYTES ??
        String(DEFAULT_ASSET_MAX_FILE_BYTES),
    ),
    assetQuotaBytes: parsePositive(
      'asset quota',
      values['asset-quota-bytes'] ??
        env.MOONCG_ASSET_QUOTA_BYTES ??
        String(DEFAULT_ASSET_QUOTA_BYTES),
    ),
    assetMaxFiles: parsePositive(
      'asset file count',
      values['asset-max-files'] ?? env.MOONCG_ASSET_MAX_FILES ?? '1000',
    ),
    bundleMaxArchiveBytes: parsePositive(
      'bundle archive size',
      values['bundle-max-archive-bytes'] ??
        env.MOONCG_BUNDLE_MAX_ARCHIVE_BYTES ??
        String(DEFAULT_INSTALL_LIMITS.maxArchiveBytes),
    ),
    bundleMaxUnpackedBytes: parsePositive(
      'bundle size',
      values['bundle-max-unpacked-bytes'] ??
        env.MOONCG_BUNDLE_MAX_UNPACKED_BYTES ??
        String(DEFAULT_INSTALL_LIMITS.maxUnpackedBytes),
    ),
    bundleMaxFiles: parsePositive(
      'bundle file count',
      values['bundle-max-files'] ??
        env.MOONCG_BUNDLE_MAX_FILES ??
        String(DEFAULT_INSTALL_LIMITS.maxFiles),
    ),
    bundleBackupsKept: parseCount(
      'number of bundle backups',
      values['bundle-backups-kept'] ??
        env.MOONCG_BUNDLE_BACKUPS_KEPT ??
        String(DEFAULT_BACKUPS_KEPT),
    ),
    bundleInstallTimeoutMs: parsePositive(
      'bundle install timeout',
      values['bundle-install-timeout-ms'] ??
        env.MOONCG_BUNDLE_INSTALL_TIMEOUT_MS ??
        String(DEFAULT_BUNDLE_INSTALL_TIMEOUT_MS),
    ),
    bundleNpmRegistry: parseRegistry(
      values['bundle-npm-registry'] ?? env.MOONCG_BUNDLE_NPM_REGISTRY,
    ),
    secureCookies: values['secure-cookies'] ?? on(env.MOONCG_SECURE_COOKIES),
    trustProxy: values['trust-proxy'] ?? on(env.MOONCG_TRUST_PROXY),
  };
}

function parsePort(text: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isNaN(port) || port > 65535) {
    throw new Error(`Invalid port "${text}": expected a number from 0 to 65535`);
  }
  return port;
}

function parsePositive(what: string, text: string): number {
  const value = /^[0-9]+$/.test(text) ? Number(text) : 0;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${what} "${text}": expected a whole number above 0`);
  }
  return value;
}

/** A whole number of zero or more. */
function parseCount(what: string, text: string): number {
  const value = /^[0-9]+$/.test(text) ? Number(text) : -1;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${what} "${text}": expected a whole number of 0 or more`);
  }
  return value;
}

function parseRegistry(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined;
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (url?.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(
      `Invalid npm registry "${url ? url.origin : text}": expected an https:// address without credentials`,
    );
  }
  return text;
}

function parseOrigin(text: string): string {
  const origin = URL.canParse(text) ? new URL(text).origin : 'null';
  if (origin === 'null') {
    throw new Error(`Invalid allowed origin "${text}": expected something like http://host:port`);
  }
  return origin;
}
