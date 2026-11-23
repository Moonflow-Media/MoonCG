export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** A logger whose lines are prefixed with `[scope]`. */
  child(scope: string): Logger;
}

export function createLogger(
  write: (line: string) => void = (line) => console.log(line),
  scope?: string,
): Logger {
  const prefix = scope === undefined ? '' : `[${scope}] `;
  const log = (level: string) => (message: string) =>
    write(`${level.padEnd(5)} ${prefix}${message}`);
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
