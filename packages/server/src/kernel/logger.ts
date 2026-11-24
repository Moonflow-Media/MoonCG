import { redactSecrets } from '../auth/secrets.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** A logger whose lines are prefixed with `[scope]`. */
  child(scope: string): Logger;
}

/**
 * Every line passes through `redactSecrets`, whoever logs it: an API token that ends up in a
 * message, such as in a request URL, is never written.
 */
export function createLogger(
  write: (line: string) => void = (line) => console.log(line),
  scope?: string,
): Logger {
  const prefix = scope === undefined ? '' : `[${scope}] `;
  const log = (level: string) => (message: string) =>
    write(redactSecrets(`${level.padEnd(5)} ${prefix}${message}`));
  return {
    info: log('INFO'),
    warn: log('WARN'),
    error: log('ERROR'),
    child: (childScope) => createLogger(write, childScope),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line of the server log as the log page gets it. Ids rise by one per line. */
export interface LogEntry {
  readonly id: number;
  /** When it was logged, as an ISO 8601 time. */
  readonly time: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

export interface LogBuffer {
  add(level: LogEntry['level'], text: string): void;
  /** The entries held, oldest first; with `after`, only those with a higher id. */
  entries(after?: number): LogEntry[];
}

/** How many lines the log page can look back, unless configured otherwise. */
export const LOG_BUFFER_LINES = 1000;
/** A longer line is cut, so one runaway message cannot fill the memory the buffer may use. */
const MAX_LINE_LENGTH = 2000;
/** The setup URL carries a code that creates an administrator. It is printed, never kept. */
const SETUP_CODE = /([?&]code=)[A-Za-z0-9_-]+/g;

/**
 * Keeps the latest lines of the log in memory for the log page. What it holds can be read
 * over HTTP, so besides API tokens the setup code is taken out as well: the console shows
 * it to whoever started the server, the buffer to nobody.
 */
export function createLogBuffer(
  options: { readonly limit?: number; readonly now?: () => number } = {},
): LogBuffer {
  const { limit = LOG_BUFFER_LINES, now = Date.now } = options;
  const held: LogEntry[] = [];
  let lastId = 0;
  return {
    add(level, text) {
      const safe = redactSecrets(text).replace(SETUP_CODE, '$1***');
      held.push({
        id: ++lastId,
        time: new Date(now()).toISOString(),
        level,
        text: safe.length > MAX_LINE_LENGTH ? `${safe.slice(0, MAX_LINE_LENGTH)}…` : safe,
      });
      if (held.length > limit) held.splice(0, held.length - limit);
    },
    entries: (after = 0) => held.filter((entry) => entry.id > after),
  };
}

/** A logger that passes everything on to `inner` and also records it in the buffer. */
export function recordingLogger(inner: Logger, logs: LogBuffer, scope?: string): Logger {
  const prefix = scope === undefined ? '' : `[${scope}] `;
  const log = (level: LogEntry['level']) => (message: string) => {
    logs.add(level, `${prefix}${message}`);
    inner[level](message);
  };
  return {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (childScope) => recordingLogger(inner.child(childScope), logs, childScope),
  };
}
