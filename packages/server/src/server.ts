import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  MessageBus,
  type Policy,
  ReplicantRegistry,
  RouteTable,
  SYSTEM_BUNDLE,
} from '@mooncg/core';
import { AssetStore } from './assets/store.js';
import { type Auth, createAuth } from './auth/auth.js';
import type { ScryptParams } from './auth/password.js';
import type { BundleRecord } from './bundles/bundles.js';
import { BundleManager } from './bundles/manager.js';
import { BundleConfigs, scrubbingLogger } from './config/bundle-config.js';
import type {
  ExtensionHost,
  ExtensionServices,
  HostStats,
} from './extension-host/extension-host.js';
import { WorkerHost } from './extension-host/worker-host.js';
import { GraphicInstances } from './graphics/instances.js';
import { type BundleLifecycle, createApp } from './http/app.js';
import { createIdentify, type ResolvePrincipal } from './http/identity.js';
import { attachWebSocket } from './http/ws.js';
import { DEFAULT_INSTALL_LIMITS } from './install/files.js';
import { BundleInstaller } from './install/installer.js';
import type { NpmInstall } from './install/npm.js';
import type { ServerConfig } from './kernel/config.js';
import { createLifecycle } from './kernel/lifecycle.js';
import {
  createLogBuffer,
  createLogger,
  errorMessage,
  type Logger,
  recordingLogger,
} from './kernel/logger.js';
import { MOONCG_VERSION } from './kernel/version.js';
import { createPersistence } from './replicants/persistence.js';
import { openSqliteStorage, type Storage } from './storage/replicant-store.js';

export interface ServerOptions {
  readonly logger?: Logger;
  /** Path of the SDK's browser build. Without it `/sdk/mooncg.js` answers 404. */
  readonly sdkFile?: string | undefined;
  /** Folder of the built dashboard. Without it the dashboard routes answer 404. */
  readonly dashboardDir?: string | undefined;
  /**
   * For tests: who every request acts as, and against which policy, instead of the accounts
   * in the store. Without them a request is whoever its session cookie or API token says,
   * and anonymous otherwise. There is no other way around signing in.
   */
  readonly policy?: Policy;
  readonly resolvePrincipal?: ResolvePrincipal;
  /** The cost of password hashes. Tests lower it. */
  readonly passwordCost?: ScryptParams;
  /**
   * How often open sockets are checked for access that changed behind the server's back,
   * such as through the command line tool. Changes made through the server apply at once.
   */
  readonly socketRecheckMs?: number;
  /** How long an asset upload may send nothing before it is given up. */
  readonly assetUploadIdleMs?: number;
  /** How often open sockets are pinged; one that misses two pings in a row is dropped. */
  readonly socketHeartbeatMs?: number;
  /** What the server keeps across restarts. Defaults to SQLite in the configured data dir. */
  readonly storage?: Storage;
  /**
   * Creates what runs the bundle extensions. Defaults to a `WorkerHost`, which gives each
   * extension its own thread.
   */
  readonly createHost?: (services: ExtensionServices) => ExtensionHost;
  /**
   * Installs the npm dependencies of a bundle that is being installed. Defaults to running
   * npm. Tests put their own in its place, so that none of them reaches the network.
   */
  readonly npmInstall?: NpmInstall;
  /**
   * For tests only: lets bundles be installed from `file://` Git addresses, so that a test
   * can use a repository on its own disk. It exists here alone. No flag, environment
   * variable or request turns it on.
   */
  readonly allowFileGitUrls?: boolean;
  /** How long a fetched bundle waits for a decision before it is deleted again. */
  readonly stagingTtlMs?: number;
}

export interface ServerStats {
  readonly extensions: HostStats;
  readonly registry: { readonly replicants: number; readonly listeners: number };
  readonly bus: {
    readonly topics: number;
    readonly listeners: number;
    readonly handlers: number;
    readonly requests: number;
  };
  readonly routes: number;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  /** The bundles as they are now. */
  readonly bundles: readonly BundleRecord[];
  readonly manager: BundleManager;
  /** Installs, updates and removes bundles. */
  readonly installer: BundleInstaller;
  readonly host: ExtensionHost;
  /** Accounts, sessions, tokens and roles. */
  readonly auth: Auth;
  readonly storage: Storage;
  readonly logger: Logger;
  /** Where the first administrator is created; `undefined` once any user exists. */
  readonly setupUrl: string | undefined;
  /** Closes the sockets of principals whose access changed since they connected. */
  recheckSockets(): void;
  /** Resolves when every bundle has finished starting, successfully or not. */
  readonly started: Promise<void>;
  /** How much is registered on the server right now. A leak shows as a count that grows. */
  stats(): ServerStats;
  /** Stops sockets, HTTP and extensions, then saves what changed and closes the store. */
  close(): Promise<void>;
}

/** How often open sockets are checked for changed access unless configured otherwise. */
export const SOCKET_RECHECK_MS = 5000;

/**
 * What to say when the server listens beyond this machine without `--secure-cookies`:
 * passwords and session cookies then cross the network unencrypted. `undefined` on loopback.
 */
export function bindingWarning(
  config: Pick<ServerConfig, 'host' | 'secureCookies'>,
): string | undefined {
  const { host, secureCookies } = config;
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (loopback || secureCookies) return undefined;
  return (
    `Listening on ${host} without HTTPS: passwords and session cookies cross the network ` +
    'unencrypted. Use this on a trusted network only, or put an HTTPS reverse proxy in front ' +
    'and start with --secure-cookies --trust-proxy.'
  );
}

/** Loads the bundles and starts serving. Failed bundles are reported, not fatal. */
export async function startServer(
  config: ServerConfig,
  options: ServerOptions = {},
): Promise<RunningServer> {
  // Everything the server logs is also kept for the log page.
  const logs = createLogBuffer();
  // No line is printed or kept with a secret of a bundle's configuration in it.
  let warn = (_message: string) => {};
  const configs = new BundleConfigs({
    dataDir: config.dataDir,
    warn: (message) => warn(message),
  });
  const logger = scrubbingLogger(recordingLogger(options.logger ?? createLogger(), logs), configs);
  warn = (message) => logger.warn(message);
  const lifecycle = createLifecycle(logger);
  const registry = new ReplicantRegistry({
    // Every declared replicant gets an epoch no earlier one had, in this run or a previous
    // one, so a revision from before is never taken as current.
    createEpoch: randomUUID,
    onListenerError: (name, error) =>
      logger.error(`A listener of replicant "${name}" failed: ${errorMessage(error)}`),
  });
  const bus = new MessageBus({
    timers: { setTimeout, clearTimeout },
    onError: (error) => logger.error(`A message listener failed: ${errorMessage(error)}`),
  });
  const routes = new RouteTable();

  try {
    const storage = options.storage ?? (await openSqliteStorage(config.dataDir));
    lifecycle.add('storage', () => storage.close());
    const persistence = createPersistence({ store: storage.replicants, logger });
    lifecycle.add('persistence', () => persistence.flush());

    const auth = createAuth({
      store: storage.auth,
      ...(options.passwordCost === undefined ? {} : { scrypt: options.passwordCost }),
    });
    const identify = createIdentify({
      auth,
      resolvePrincipal: options.resolvePrincipal,
      policy: options.policy,
      secureCookies: config.secureCookies,
      trustProxy: config.trustProxy,
    });

    const services: ExtensionServices = {
      registry,
      bus,
      routes,
      logger,
      checkPermission: (principal, permission) => auth.check(principal, permission),
    };
    const host =
      options.createHost?.(services) ??
      new WorkerHost({
        ...services,
        memoryMb: config.extensionMemoryMb,
        startTimeoutMs: config.extensionStartTimeoutMs,
        heartbeatTimeoutMs: config.extensionHeartbeatTimeoutMs,
        // Asked often enough that a silent extension is noticed soon after the timeout.
        heartbeatIntervalMs: Math.min(5000, Math.ceil(config.extensionHeartbeatTimeoutMs / 2)),
      });
    lifecycle.add('extension host', () => host.close());
    const instances = new GraphicInstances(registry);
    const assets = new AssetStore({
      dataDir: config.dataDir,
      registry,
      maxFileBytes: config.assetMaxFileBytes,
      quotaBytes: config.assetQuotaBytes,
      maxFiles: config.assetMaxFiles,
      uploadIdleMs: options.assetUploadIdleMs,
    });
    await assets.sweep();
    const manager = new BundleManager({
      bundlesDir: config.bundlesDir,
      registry,
      instances,
      assets,
      config: configs,
      bus,
      host,
      logger,
      persistence,
      settings: storage.bundles,
    });
    lifecycle.add('bundles', () => manager.close());
    // The bundles are known and show as `enabling`; their extensions start in the background,
    // so one that is slow to start does not keep the server from listening.
    await manager.load();
    // A bundle seen for the first time brings grants for the built-in roles. Bundles appear
    // at start and when one is enabled or reloaded, so that is when this is looked at.
    const applyDefaults = () =>
      auth.applyBundleDefaults(
        manager
          .list()
          .flatMap(({ name, manifest }) =>
            manifest ? [{ name, defaultRoles: manifest.defaultRoles }] : [],
          ),
      );
    applyDefaults();
    const installer = new BundleInstaller({
      dataDir: config.dataDir,
      bundlesDir: config.bundlesDir,
      manager,
      registry,
      logger,
      mooncgVersion: MOONCG_VERSION,
      limits: {
        ...DEFAULT_INSTALL_LIMITS,
        maxArchiveBytes: config.bundleMaxArchiveBytes,
        maxUnpackedBytes: config.bundleMaxUnpackedBytes,
        maxFiles: config.bundleMaxFiles,
      },
      timeoutMs: config.bundleInstallTimeoutMs,
      backupsKept: config.bundleBackupsKept,
      stagingTtlMs: options.stagingTtlMs,
      npmInstall: options.npmInstall,
      npmRegistry: config.bundleNpmRegistry,
      roles: { proposed: (name, defaultRoles) => auth.bundleDefaults(name, defaultRoles) },
      git: { allowFileUrls: options.allowFileGitUrls === true },
      // What a bundle stored: its configuration, its uploaded files and its replicants,
      // and what the roles were granted of it.
      purge: async (name) => {
        await configs.remove(name);
        await assets.purge(name);
        await persistence.flush();
        await storage.replicants.removeBundle(name);
        auth.forgetBundle(name);
      },
      afterChange: applyDefaults,
    });
    // Closed before the bundles are: a job that still runs ends first.
    lifecycle.add('installer', () => installer.close());
    await installer.start();
    const change = (action: 'enable' | 'disable' | 'reload') => async (name: string) => {
      const record = await manager[action](name);
      applyDefaults();
      return record;
    };
    const bundleLifecycle: BundleLifecycle = {
      enable: change('enable'),
      disable: change('disable'),
      reload: change('reload'),
      restartExtension: (name) => manager.restartExtension(name),
    };
    const started = manager.startAll().catch((error) => {
      logger.error(`Starting the bundles failed: ${errorMessage(error)}`);
    });

    const app = await createApp({
      bundles: () => manager.list(),
      sdkFile: options.sdkFile,
      dashboardDir: options.dashboardDir,
      logs,
      auth,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.resolvePrincipal === undefined
        ? {}
        : { resolvePrincipal: options.resolvePrincipal }),
      routes,
      lifecycle: bundleLifecycle,
      installer,
      instances,
      assets,
      config: configs,
      maxBodyBytes: config.maxBodyBytes,
      allowedOrigins: config.allowedOrigins,
      secureCookies: config.secureCookies,
      trustProxy: config.trustProxy,
    });
    lifecycle.add('http', () => app.close());
    const sockets = attachWebSocket(app.server, {
      registry,
      bus,
      // The shell is no bundle; it connects under the server's own name.
      bundleExists: (name) => name === SYSTEM_BUNDLE || manager.isRunning(name),
      identify,
      graphics: instances,
      allowedOrigins: config.allowedOrigins,
      transport: { trustProxy: config.trustProxy },
      heartbeatMs: options.socketHeartbeatMs,
      logger,
    });
    lifecycle.add('websocket', () => sockets.close());
    // A change made through this server reaches open sockets at once; one made behind its
    // back, by the command line tool on the same data directory, at the next check.
    lifecycle.add(
      'access changes',
      auth.onChange(() => sockets.recheck()),
    );
    const recheck = setInterval(
      () => sockets.recheck(),
      options.socketRecheckMs ?? SOCKET_RECHECK_MS,
    );
    recheck.unref();
    lifecycle.add('socket check', () => clearInterval(recheck));
    await app.listen({ port: config.port, host: config.host });

    const { port } = app.server.address() as AddressInfo;
    const urlHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    const url = `http://${urlHost}:${port}`;
    const warning = bindingWarning(config);
    if (warning !== undefined) logger.warn(warning);
    const setupCode = auth.setupCode();
    const setupUrl = setupCode === undefined ? undefined : `${url}/setup?code=${setupCode}`;
    if (setupUrl !== undefined) {
      logger.info(`No user exists yet. Create the first administrator at ${setupUrl}`);
    }
    return {
      port,
      url,
      auth,
      storage,
      logger,
      setupUrl,
      recheckSockets: () => sockets.recheck(),
      get bundles() {
        return manager.list();
      },
      manager,
      installer,
      host,
      started,
      stats: () => ({
        extensions: host.stats(),
        registry: registry.stats(),
        bus: bus.stats(),
        routes: routes.count(),
      }),
      close: () => lifecycle.dispose(),
    };
  } catch (error) {
    await lifecycle.dispose();
    throw error;
  }
}
