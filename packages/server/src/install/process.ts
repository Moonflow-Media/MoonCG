import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';

export interface RunOptions {
  readonly env: NodeJS.ProcessEnv;
  /** How long the tool may run before it is ended. */
  readonly timeoutMs: number;
  readonly cwd?: string | undefined;
  /** Ends the tool when it fires. */
  readonly signal?: AbortSignal | undefined;
  /** How much output is kept, per stream. More than that is dropped from the front. */
  readonly maxOutputBytes?: number | undefined;
  /** Told each line the tool prints, on either stream. */
  onLine?(line: string): void;
}

export interface RunResult {
  /** The exit code; `null` when the tool was ended. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The tool was ended because its time was up. */
  readonly timedOut: boolean;
  /** The tool was ended because `signal` fired. */
  readonly aborted: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Ends a process and every process it started. A tool like Git or npm starts helpers of its
 * own; ending only the tool would leave those running.
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Windows keeps the tree by parent; `/T` walks it, `/F` does not ask.
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      // The tool was started as the leader of a process group of its own.
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    resolve();
  });
}

/**
 * Runs a program with its arguments, never through a shell, and resolves with how it ended.
 * When the time is up or `signal` fires, the program and everything it started are ended.
 * Rejects only when the program cannot be started at all.
 */
export function runTool(
  program: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A group of its own, so that the group can be ended as one.
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let aborted = false;
    let ended = false;
    const end = () => {
      if (!ended && child.pid !== undefined) void killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, options.timeoutMs);
    const stop = () => {
      aborted = true;
      end();
    };
    options.signal?.addEventListener('abort', stop, { once: true });

    const output = { stdout: '', stderr: '' };
    const read = (name: 'stdout' | 'stderr') => {
      let rest = '';
      const line = (text: string) => {
        if (text.trim() !== '') options.onLine?.(text);
      };
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk: string) => {
        output[name] = (output[name] + chunk).slice(-max);
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const text of lines) line(text);
      });
      child[name].on('end', () => line(rest));
    };
    read('stdout');
    read('stderr');

    const settle = () => {
      ended = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    };
    child.once('error', (error) => {
      settle();
      reject(error);
    });
    child.once('close', (code) => {
      settle();
      resolve({ code, ...output, timedOut, aborted });
    });
    if (options.signal?.aborted) stop();
  });
}
