import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

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
 * `--max-body-bytes`, repeatable `--allowed-origin`) wins over its environment variable: the
 * flag in capitals with `MOONCG_` in front and underscores for dashes, such as
 * `MOONCG_DATA_DIR`, and `MOONCG_ALLOWED_ORIGINS` as a comma-separated list. That wins over
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
      'allowed-origin': { type: 'string', multiple: true },
    },
  });
  const origins = values['allowed-origin'] ?? env.MOONCG_ALLOWED_ORIGINS?.split(',') ?? [];
  return {
    port: parsePort(values.port ?? env.MOONCG_PORT ?? '9090'),
    // Loopback only: there is no authentication yet.
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

function parseOrigin(text: string): string {
  const origin = URL.canParse(text) ? new URL(text).origin : 'null';
  if (origin === 'null') {
    throw new Error(`Invalid allowed origin "${text}": expected something like http://host:port`);
  }
  return origin;
}
