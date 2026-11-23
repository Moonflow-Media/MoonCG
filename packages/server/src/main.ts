#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadConfig } from './kernel/config.js';
import { createLogger, errorMessage } from './kernel/logger.js';
import { installProcessGuard } from './kernel/process-guard.js';
import { startServer } from './server.js';

/** The SDK's browser build, if `pnpm build` has produced it. */
function builtSdkFile(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('@mooncg/sdk/browser'));
  } catch {
    return undefined;
  }
}

const logger = createLogger();
// A last resort. Extensions run in their own threads and cannot fail this process; this only
// keeps a bug in the server itself from ending a running show.
installProcessGuard(process, logger);
try {
  const config = loadConfig({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
  const server = await startServer(config, { logger, sdkFile: builtSdkFile() });
  logger.info(
    `MoonCG is listening on ${server.url} (bundles: ${config.bundlesDir}, data: ${config.dataDir})`,
  );
  // The server is listening already; the bundles finish starting in the background.
  void server.started.then(() => {
    for (const bundle of server.bundles) {
      logger.info(`Bundle "${bundle.name}" is ${bundle.state}`);
    }
  });

  const shutdown = () => {
    logger.info('Shutting down');
    server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  logger.error(errorMessage(error));
  process.exit(1);
}
