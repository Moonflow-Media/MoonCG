#!/usr/bin/env node
import { createLogger, errorMessage } from './kernel/logger.js';
import { runServer } from './run.js';

const logger = createLogger();
try {
  const { stopped } = await runServer(
    { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() },
    { logger },
  );
  await stopped;
  process.exit(0);
} catch (error) {
  logger.error(errorMessage(error));
  process.exit(1);
}
