import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ConfigSources, loadConfig, readConfigFile } from './kernel/config.js';
import { createLogger, type Logger } from './kernel/logger.js';
import { installProcessGuard } from './kernel/process-guard.js';
import { type RunningServer, type ServerOptions, startServer } from './server.js';

/** The SDK's browser build, if `pnpm build` has produced it. */
function builtSdkFile(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('@mooncg/sdk/browser'));
  } catch {
    return undefined;
  }
}

/** The built dashboard, if `pnpm build` has produced it. */
function builtDashboardDir(): string | undefined {
  try {
    const manifest = fileURLToPath(import.meta.resolve('@mooncg/dashboard/package.json'));
    return join(dirname(manifest), 'dist');
  } catch {
    return undefined;
  }
}

export interface RunOptions extends ServerOptions {
  /**
   * Whether the process is guarded against uncaught errors and stops the server on SIGINT
   * and SIGTERM. On unless turned off, which tests do.
   */
  readonly signals?: boolean;
}

export interface RunningProcess {
  readonly server: RunningServer;
  /** Resolves once the server has stopped, however that came about. */
  readonly stopped: Promise<void>;
  /** Stops the server. */
  stop(): Promise<void>;
}

/**
 * Starts the server the way the command line does: reads the configuration file, the
 * environment and the flags, starts, and says where it listens. This is what `mooncg start`,
 * `mooncg dev` (which adds `--dev`) and the server's own executable run. Rejects when the
 * configuration is wrong or the server cannot start.
 */
export async function runServer(
  sources: Omit<ConfigSources, 'file'>,
  options: RunOptions = {},
): Promise<RunningProcess> {
  const { signals = true, ...serverOptions } = options;
  const logger: Logger = serverOptions.logger ?? createLogger();
  const file = await readConfigFile(sources);
  const config = loadConfig({ ...sources, file });
  // A last resort. Extensions run in their own threads and cannot fail this process; this
  // only keeps a bug in the server itself from ending a running show.
  if (signals) installProcessGuard(process, logger);
  const server = await startServer(config, {
    sdkFile: builtSdkFile(),
    dashboardDir: builtDashboardDir(),
    ...serverOptions,
    logger,
  });
  logger.info(
    `MoonCG is listening on ${server.url} (bundles: ${config.bundlesDir}, data: ${config.dataDir}` +
      `${file === undefined ? '' : `, configuration: ${file.path}`})`,
  );
  // The server is listening already; the bundles finish starting in the background.
  void server.started.then(() => {
    for (const bundle of server.bundles) {
      logger.info(`Bundle "${bundle.name}" is ${bundle.state}`);
    }
  });

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= server.close();
    return stopping;
  };
  let onStopped = () => {};
  const stopped = new Promise<void>((resolve) => {
    onStopped = resolve;
  });
  if (signals) {
    const shutdown = () => {
      logger.info('Shutting down');
      void stop().then(onStopped);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
  return { server, stopped, stop: () => stop().then(onStopped) };
}
