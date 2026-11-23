import { fileURLToPath } from 'node:url';
import { createLogger } from '../src/kernel/logger.js';

/** Absolute path of a file under `test/fixtures`. */
export function fixture(path: string): string {
  return fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
}

/** A logger that collects its lines instead of printing them. */
export function memoryLogger() {
  const lines: string[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}
