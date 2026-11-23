/** How many log lines an extension may write per window... */
export const LOG_MAX_LINES = 100;
/** ...and how many characters, whichever is reached first. */
export const LOG_MAX_BYTES = 64 * 1024;
export const LOG_WINDOW_MS = 1000;

export interface LogLimiterOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

export interface LogLimiter {
  /**
   * Whether to write this line. `dropped` is how many lines of the window before were not
   * written; it is reported once, with the first line of a new window.
   */
  accept(message: string): { write: boolean; dropped: number };
  /** The lines dropped and not yet reported. Resets the count. */
  takeDropped(): number;
}

/** Keeps an extension that logs without pause from flooding the server log. */
export function createLogLimiter(options: LogLimiterOptions = {}): LogLimiter {
  const maxLines = options.maxLines ?? LOG_MAX_LINES;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const windowMs = options.windowMs ?? LOG_WINDOW_MS;
  const now = options.now ?? Date.now;
  let windowStart = now();
  let lines = 0;
  let bytes = 0;
  let dropped = 0;

  const takeDropped = () => {
    const count = dropped;
    dropped = 0;
    return count;
  };

  return {
    accept(message) {
      let reported = 0;
      if (now() - windowStart >= windowMs) {
        windowStart = now();
        lines = 0;
        bytes = 0;
        reported = takeDropped();
      }
      if (lines >= maxLines || bytes + message.length > maxBytes) {
        dropped++;
        return { write: false, dropped: reported };
      }
      lines++;
      bytes += message.length;
      return { write: true, dropped: reported };
    },
    takeDropped,
  };
}
