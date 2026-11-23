import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  ALLOW_ALL_POLICY,
  MessageBus,
  type Policy,
  ReplicantRegistry,
  RouteTable,
  SYSTEM_BUNDLE,
} from '@mooncg/core';
import type { BundleRecord } from './bundles/bundles.js';
import { BundleManager } from './bundles/manager.js';
import type {
  ExtensionHost,
  ExtensionServices,
  HostStats,
} from './extension-host/extension-host.js';
import { WorkerHost } from './extension-host/worker-host.js';
import { createApp, type ResolvePrincipal, resolveLocalAdmin } from './http/app.js';
import { attachWebSocket } from './http/ws.js';
import type { ServerConfig } from './kernel/config.js';
import { createLifecycle } from './kernel/lifecycle.js';
import { createLogger, errorMessage, type Logger } from './kernel/logger.js';
import { createPersistence } from './replicants/persistence.js';
import { openSqliteStorage, type Storage } from './storage/replicant-store.js';

export interface ServerOptions {
  readonly logger?: Logger;
  /** Path of the SDK's browser build. Without it `/sdk/mooncg.js` answers 404. */
  readonly sdkFile?: string | undefined;
  readonly policy?: Policy;
  readonly resolvePrincipal?: ResolvePrincipal;
  /** What the server keeps across restarts. Defaults to SQLite in the configured data dir. */
  readonly storage?: Storage;
  /**
   * Creates what runs the bundle extensions. Defaults to a `WorkerHost`, which gives each
   * extension its own thread.
   */
  readonly createHost?: (services: ExtensionServices) => ExtensionHost;
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
  readonly host: ExtensionHost;
  /** Resolves when every bundle has finished starting, successfully or not. */
  readonly started: Promise<void>;
  /** How much is registered on the server right now. A leak shows as a count that grows. */
  stats(): ServerStats;
  /** Stops sockets, HTTP and extensions, then saves what changed and closes the store. */
  close(): Promise<void>;
}

/** Loads the bundles and starts serving. Failed bundles are reported, not fatal. */
export async function startServer(
  config: ServerConfig,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const logger = options.logger ?? createLogger();
  const policy = options.policy ?? ALLOW_ALL_POLICY;
  const resolvePrincipal = options.resolvePrincipal ?? resolveLocalAdmin;
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

    const services: ExtensionServices = { registry, bus, routes, logger };
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
    const manager = new BundleManager({
      bundlesDir: config.bundlesDir,
      registry,
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
    const started = manager.startAll().catch((error) => {
      logger.error(`Starting the bundles failed: ${errorMessage(error)}`);
    });

    const app = await createApp({
      bundles: () => manager.list(),
      sdkFile: options.sdkFile,
      policy,
      resolvePrincipal,
      routes,
      lifecycle: manager,
      maxBodyBytes: config.maxBodyBytes,
      allowedOrigins: config.allowedOrigins,
    });
    lifecycle.add('http', () => app.close());
    lifecycle.add(
      'websocket',
      attachWebSocket(app.server, {
        registry,
        bus,
        // The shell is no bundle; it connects under the server's own name.
        bundleExists: (name) => name === SYSTEM_BUNDLE || manager.isRunning(name),
        policy,
        resolvePrincipal,
        allowedOrigins: config.allowedOrigins,
        logger,
      }),
    );
    await app.listen({ port: config.port, host: config.host });

    const { port } = app.server.address() as AddressInfo;
    const urlHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    return {
      port,
      url: `http://${urlHost}:${port}`,
      get bundles() {
        return manager.list();
      },
      manager,
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
