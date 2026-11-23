import { errorMessage, type Logger } from './logger.js';

/** The part of `process` the guard needs. */
export interface ProcessEvents {
  on(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (reason: unknown) => void,
  ): unknown;
}

/**
 * A last resort: keeps the server alive when its own code fails outside any request. Bundle
 * extensions run in worker threads, where a failure ends that thread and is reported against
 * the bundle, so this should never fire because of a bundle.
 */
export function installProcessGuard(target: ProcessEvents, logger: Logger): void {
  target.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection (the server keeps running): ${errorMessage(reason)}`);
  });
  target.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception (the server keeps running): ${errorMessage(error)}`);
  });
}
