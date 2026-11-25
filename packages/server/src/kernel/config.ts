import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_BACKUPS_KEPT,
  isLoopbackHost,
  isLoopbackOrigin,
  isPlainObject,
  registryUrlProblem,
} from '@mooncg/core';
import { DEFAULT_INSTALL_LIMITS } from '../install/files.js';
import { withoutCredentials } from '../install/git.js';
import { DEFAULT_REGISTRY_REFRESH_MS } from '../registry/registry.js';

/** How long Git and npm may each take while a bundle is installed, unless configured. */
export const DEFAULT_BUNDLE_INSTALL_TIMEOUT_MS = 5 * 60_000;

/** The name of the configuration file an installation folder may hold. */
export const CONFIG_FILE = 'mooncg.config.json';

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
  /** Absolute path of the folder that holds one folder per module. */
  readonly modulesDir: string;
  /**
   * The origin people reach the server at, such as `https://show.example`. External logins
   * build the address a provider sends the browser back to from it, and from nothing a
   * request says. Without it they work on this machine only.
   */
  readonly publicUrl: string | undefined;
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
   * The registry indexes the catalog is built from, as `https://` addresses (plain `http://`
   * on this machine only). Administrators can add more at run time; these cannot be removed
   * there. An address may hold credentials, which are sent to that index alone.
   */
  readonly registryIndexes: readonly string[];
  /** How often the registry indexes are fetched again, in milliseconds. */
  readonly registryRefreshMs: number;
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
  /**
   * Dev mode, for writing bundles on one's own machine: the watcher is on, graphics reload
   * with their files, the `dev.url` of a manifest is honoured, and every request from this
   * machine is signed in as an administrator without a password. It exists only with
   * `--dev` (which `mooncg dev` passes): no environment variable and no file turns it on,
   * and it refuses any host but loopback.
   */
  readonly dev: boolean;
  /**
   * Watches the bundle folders and applies what changes. `--watch` or `--no-watch` wins over
   * `MOONCG_WATCH`, which wins over `watch` in the configuration file. Always on in dev mode.
   */
  readonly watch: boolean;
}

/** A configuration file as it was read: its content, not yet checked. */
export interface ConfigFile {
  readonly values: unknown;
  /** The folder the file lies in. Relative paths in the file start there. */
  readonly dir: string;
  /** The file itself, for error messages. */
  readonly path: string;
}

export interface ConfigSources {
  /** Command line arguments without the node binary and script. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** The configuration file, if there is one. See `readConfigFile`. */
  readonly file?: ConfigFile | undefined;
}

const FLAGS = {
  config: { type: 'string' },
  dev: { type: 'boolean' },
  watch: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  'bundles-dir': { type: 'string' },
  'data-dir': { type: 'string' },
  'modules-dir': { type: 'string' },
  'public-url': { type: 'string' },
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
  'registry-index': { type: 'string', multiple: true },
  'registry-refresh-ms': { type: 'string' },
  'allowed-origin': { type: 'string', multiple: true },
  'secure-cookies': { type: 'boolean' },
  'trust-proxy': { type: 'boolean' },
} as const;

/**
 * Reads the command line. Every switch can also be turned off by name, such as
 * `--no-watch`, which is how a flag wins over an environment variable or a file that turns
 * it on.
 */
const parseFlags = (argv: readonly string[]) =>
  parseArgs({ args: [...argv], options: FLAGS, allowNegative: true });

/**
 * Reads the configuration file: the one `--config` names, else the one `MOONCG_CONFIG`
 * names, else `mooncg.config.json` in the working directory if there is one. A file that was
 * named must exist. What is in it is checked by `loadConfig`.
 */
export async function readConfigFile({
  argv,
  env,
  cwd,
}: Omit<ConfigSources, 'file'>): Promise<ConfigFile | undefined> {
  const { values } = parseFlags(argv);
  const named = values.config ?? (env.MOONCG_CONFIG || undefined);
  const path = resolve(cwd, named ?? CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (named === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `The configuration file ${path} could not be read: ${(error as Error).message}`,
    );
  }
  try {
    return { values: JSON.parse(text), dir: dirname(path), path };
  } catch (error) {
    throw new Error(
      `The configuration file ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/** What a configuration file may set. */
interface FileValues {
  readonly port?: string;
  readonly host?: string;
  readonly dataDir?: string;
  readonly bundlesDir?: string;
  readonly modulesDir?: string;
  readonly publicUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly registryIndexes?: readonly string[];
  readonly watch?: boolean;
}

/** Checks the content of a configuration file. Every complaint names the file. */
function fileValues(file: ConfigFile | undefined): FileValues {
  if (file === undefined) return {};
  const wrong = (problem: string) =>
    new Error(`Invalid configuration file ${file.path}: ${problem}`);
  const { values } = file;
  if (!isPlainObject(values)) throw wrong('expected a JSON object');
  const known = [
    '$schema',
    'port',
    'host',
    'dataDir',
    'bundlesDir',
    'modulesDir',
    'publicUrl',
    'allowedOrigins',
    'registryIndexes',
    'watch',
  ];
  for (const key of Object.keys(values)) {
    if (key === 'dev') {
      throw wrong(
        '"dev" cannot be set in a file: dev mode signs in without a password, so it is only started on purpose, with "mooncg dev" or --dev',
      );
    }
    if (!known.includes(key))
      throw wrong(`unknown setting "${key}" (known: ${known.slice(1).join(', ')})`);
  }
  const path = (key: 'dataDir' | 'bundlesDir' | 'modulesDir') => {
    const value = values[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '') throw wrong(`"${key}" must be a path`);
    return resolve(file.dir, value);
  };
  const { port, host, allowedOrigins, watch, publicUrl, registryIndexes } = values;
  if (
    registryIndexes !== undefined &&
    (!Array.isArray(registryIndexes) || !registryIndexes.every((item) => typeof item === 'string'))
  ) {
    throw wrong(
      '"registryIndexes" must be a list of addresses such as "https://example.org/index.json"',
    );
  }
  if (publicUrl !== undefined && typeof publicUrl !== 'string') {
    throw wrong('"publicUrl" must be an address such as "https://show.example"');
  }
  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw wrong('"port" must be a whole number from 0 to 65535');
  }
  if (host !== undefined && (typeof host !== 'string' || host === '')) {
    throw wrong('"host" must be a host name or an address');
  }
  if (
    allowedOrigins !== undefined &&
    (!Array.isArray(allowedOrigins) || !allowedOrigins.every((item) => typeof item === 'string'))
  ) {
    throw wrong('"allowedOrigins" must be a list of origins such as "http://localhost:5173"');
  }
  for (const origin of (allowedOrigins as string[] | undefined) ?? []) {
    if (!URL.canParse(origin) || new URL(origin).origin === 'null') {
      throw wrong(
        `"allowedOrigins" holds "${origin}", which is no allowed origin such as http://host:port`,
      );
    }
  }
  if (watch !== undefined && typeof watch !== 'boolean') {
    throw wrong('"watch" must be true or false');
  }
  const dataDir = path('dataDir');
  const bundlesDir = path('bundlesDir');
  const modulesDir = path('modulesDir');
  return {
    ...(port === undefined ? {} : { port: String(port) }),
    ...(host === undefined ? {} : { host }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(bundlesDir === undefined ? {} : { bundlesDir }),
    ...(modulesDir === undefined ? {} : { modulesDir }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins: allowedOrigins as string[] }),
    ...(registryIndexes === undefined ? {} : { registryIndexes: registryIndexes as string[] }),
    ...(watch === undefined ? {} : { watch }),
  };
}

/**
 * Builds the configuration from four places, the earlier one winning: command line flags,
 * environment variables, the configuration file (`port`, `host`, `dataDir`, `bundlesDir`,
 * `modulesDir`, `publicUrl`, `allowedOrigins`, `registryIndexes`, `watch`; see `readConfigFile`) and the defaults. `--dev` turns dev mode
 * on and exists as a flag only; `--watch` (`MOONCG_WATCH`) turns on the watcher alone, and
 * `--no-watch` (`MOONCG_WATCH=0`) turns it off whatever the later places say.
 *
 * Each flag (`--port`, `--host`, `--bundles-dir`, `--data-dir`, `--modules-dir`, `--public-url`,
 * `--extension-memory-mb`, `--extension-start-timeout-ms`, `--extension-heartbeat-timeout-ms`,
 * `--max-body-bytes`, `--asset-max-file-bytes`, `--asset-quota-bytes`, `--asset-max-files`,
 * `--bundle-max-archive-bytes`, `--bundle-max-unpacked-bytes`, `--bundle-max-files`,
 * `--bundle-backups-kept`, `--bundle-install-timeout-ms`, `--bundle-npm-registry`, `--registry-refresh-ms`,
 * repeatable `--allowed-origin` and `--registry-index` (`MOONCG_REGISTRY_INDEXES`, a
 * comma-separated list), and the switches `--secure-cookies` and
 * `--trust-proxy`) wins over its environment variable: the flag in capitals with `MOONCG_` in
 * front and underscores for dashes, such as `MOONCG_DATA_DIR`, and `MOONCG_ALLOWED_ORIGINS` as
 * a comma-separated list. A switch is on in the environment as `1` or `true`, and can be
 * turned off on the command line with `--no-` in front. That wins over the default.
 */
export function loadConfig({ argv, env, cwd, file }: ConfigSources): ServerConfig {
  const { values } = parseFlags(argv);
  const fromFile = fileValues(file);
  const on = (value: string | undefined) => value === '1' || value === 'true';
  const origins =
    values['allowed-origin'] ??
    env.MOONCG_ALLOWED_ORIGINS?.split(',') ??
    fromFile.allowedOrigins ??
    [];
  // Loopback unless asked otherwise: `--host 0.0.0.0` opens the server to the network.
  const host = values.host ?? env.MOONCG_HOST ?? fromFile.host ?? '127.0.0.1';
  const trustProxy = values['trust-proxy'] ?? on(env.MOONCG_TRUST_PROXY);
  // A flag only, on purpose. See `ServerConfig.dev`.
  const dev = values.dev === true;
  const allowedOrigins = origins.map((origin) => parseOrigin(origin.trim()));
  const problem = devModeProblem({ dev, host, trustProxy, allowedOrigins });
  if (problem !== undefined) throw new Error(problem);
  // A variable that is set says so either way: `MOONCG_WATCH=0` turns off what the file
  // turns on. One that is empty is not set.
  const watchFromEnv = env.MOONCG_WATCH ? on(env.MOONCG_WATCH) : undefined;
  return {
    dev,
    watch: dev || (values.watch ?? watchFromEnv ?? fromFile.watch ?? false),
    port: parsePort(values.port ?? env.MOONCG_PORT ?? fromFile.port ?? '9090'),
    host,
    bundlesDir: resolve(
      cwd,
      values['bundles-dir'] ?? env.MOONCG_BUNDLES_DIR ?? fromFile.bundlesDir ?? 'bundles',
    ),
    allowedOrigins,
    dataDir: resolve(cwd, values['data-dir'] ?? env.MOONCG_DATA_DIR ?? fromFile.dataDir ?? 'data'),
    modulesDir: resolve(
      cwd,
      values['modules-dir'] ?? env.MOONCG_MODULES_DIR ?? fromFile.modulesDir ?? 'modules',
    ),
    publicUrl: parsePublicUrl(
      values['public-url'] ?? (env.MOONCG_PUBLIC_URL || undefined) ?? fromFile.publicUrl,
    ),
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
    registryIndexes: parseIndexes(
      values['registry-index'] ??
        env.MOONCG_REGISTRY_INDEXES?.split(',').filter((url) => url.trim() !== '') ??
        fromFile.registryIndexes ??
        [],
    ),
    registryRefreshMs: parsePositive(
      'registry refresh interval',
      values['registry-refresh-ms'] ??
        env.MOONCG_REGISTRY_REFRESH_MS ??
        String(DEFAULT_REGISTRY_REFRESH_MS),
    ),
    secureCookies: values['secure-cookies'] ?? on(env.MOONCG_SECURE_COOKIES),
    trustProxy,
  };
}

/** The registry indexes, each checked; an unusable one stops the start with the reason. */
function parseIndexes(urls: readonly string[]): string[] {
  return urls.map((given) => {
    const url = given.trim();
    const problem = registryUrlProblem(url);
    if (problem !== undefined) {
      throw new Error(`The registry index "${withoutCredentials(url)}" cannot be used: ${problem}`);
    }
    return url;
  });
}

/**
 * Why a configuration may not run in dev mode, or `undefined` if it may, or does not ask
 * to. Dev mode signs in whoever connects from this machine, so it must not listen beyond
 * it, must not sit behind a proxy, through which everyone would come from this machine, and
 * must not let the pages of a site elsewhere talk to it: an allowed origin may open the
 * socket and send requests, and in dev mode nothing would ask it for credentials.
 */
export function devModeProblem(
  config: Pick<ServerConfig, 'dev' | 'host' | 'trustProxy' | 'allowedOrigins'>,
): string | undefined {
  if (!config.dev) return undefined;
  if (!isLoopbackHost(config.host)) {
    return `Dev mode signs in everyone on this machine as an administrator, so it listens on loopback only: the host must be localhost, 127.0.0.1 or ::1, not "${config.host}"`;
  }
  if (config.trustProxy) {
    return 'Dev mode cannot run behind a proxy (--trust-proxy): every request would seem to come from this machine';
  }
  const foreign = config.allowedOrigins.filter((origin) => !isLoopbackOrigin(origin));
  if (foreign.length > 0) {
    return (
      `Dev mode signs in without a password, so every allowed origin must be on this machine (loopback: localhost, 127.0.0.1 or [::1]), not ${foreign.map((origin) => `"${origin}"`).join(', ')}. ` +
      'Remove it from --allowed-origin, MOONCG_ALLOWED_ORIGINS and "allowedOrigins" of the configuration file, or start without dev mode.'
    );
  }
  return undefined;
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

/**
 * The origin the server is reached at: `http://` or `https://`, a host, perhaps a port, and
 * nothing else. What comes after would have to be part of every address the server builds,
 * and it serves at the root only.
 */
function parsePublicUrl(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined;
  const url = URL.canParse(text) ? new URL(text) : undefined;
  const plain =
    url !== undefined &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !text.includes('#') &&
    !text.includes('?');
  if (!url || !plain) {
    throw new Error(
      `Invalid public address "${url ? url.origin : text}": expected an origin such as https://show.example, without a path, a query or credentials`,
    );
  }
  return url.origin;
}

function parseOrigin(text: string): string {
  const origin = URL.canParse(text) ? new URL(text).origin : 'null';
  if (origin === 'null') {
    throw new Error(`Invalid allowed origin "${text}": expected something like http://host:port`);
  }
  return origin;
}
