import type { Json } from '@mooncg/core';

/**
 * What crosses the thread boundary between the server and an extension's worker, besides the
 * extension's connection itself. Everything is plain data.
 *
 * The connection travels as `frame` messages that carry the text frames of the wire protocol,
 * the same ones a page sends over its WebSocket. The server decodes and checks them with the
 * same code, so a worker is trusted no more than any other client.
 */
export type WorkerToHost =
  | { readonly type: 'frame'; readonly data: string }
  | { readonly type: 'log'; readonly level: LogLevel; readonly message: string }
  /** The extension's default export has finished. */
  | { readonly type: 'ready' }
  /** Loading or starting the extension failed. */
  | { readonly type: 'failed'; readonly message: string }
  /** The dispose callbacks have run. */
  | { readonly type: 'disposed' }
  /** The answer to `ping`: the thread is responsive. */
  | { readonly type: 'pong' };

export type HostToWorker =
  | { readonly type: 'frame'; readonly data: string }
  /** Run the dispose callbacks, then answer `disposed`. */
  | { readonly type: 'dispose' }
  /** Answer `pong` as soon as the thread gets to it. */
  | { readonly type: 'ping' };

/** What the worker is started with. */
export interface WorkerData {
  readonly bundle: string;
  readonly version: string;
  readonly entry: string;
  /** The bundle's configuration, for `ctx.config`. */
  readonly config: Readonly<Record<string, Json>>;
}

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MAX_LOG_LENGTH = 4000;

/** Checks a message from a worker. Returns `undefined` for anything that is not one. */
export function readWorkerMessage(raw: unknown): WorkerToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case 'frame':
      return typeof message.data === 'string' ? { type: 'frame', data: message.data } : undefined;
    case 'log':
      return (LOG_LEVELS as readonly unknown[]).includes(message.level) &&
        typeof message.message === 'string'
        ? {
            type: 'log',
            level: message.level as LogLevel,
            message: message.message.slice(0, MAX_LOG_LENGTH),
          }
        : undefined;
    case 'failed':
      return typeof message.message === 'string'
        ? { type: 'failed', message: message.message.slice(0, MAX_LOG_LENGTH) }
        : undefined;
    case 'ready':
    case 'disposed':
    case 'pong':
      return { type: message.type };
    default:
      return undefined;
  }
}
