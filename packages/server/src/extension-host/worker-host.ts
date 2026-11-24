import { Worker } from 'node:worker_threads';
import { encodeMessage, MAX_FRAME_BYTES, type Session, type SessionStats } from '@mooncg/core';
import {
  connectExtension,
  type ExtensionHost,
  type ExtensionServices,
  type ExtensionSpec,
  type HostStats,
} from './extension-host.js';
import { createLogLimiter, LOG_MAX_BYTES, LOG_MAX_LINES } from './log-limiter.js';
import {
  type HostToWorker,
  readWorkerMessage,
  type WorkerData,
  type WorkerToHost,
} from './worker-protocol.js';

/** The heap an extension may use before its thread is ended. */
export const DEFAULT_EXTENSION_MEMORY_MB = 256;
/** How long an extension's cleanup may take before its thread is ended. */
export const DEFAULT_STOP_TIMEOUT_MS = 2000;
/** How long an extension may take to start. */
export const DEFAULT_START_TIMEOUT_MS = 10_000;
/**
 * The host asks each running extension for a sign of life this often. An extension answers
 * when its thread gets around to it, so one that computes without pause answers late.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
/**
 * An extension that has not answered for this long is treated as crashed. With the default
 * interval, about ten seconds of uninterrupted synchronous work are tolerated.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
/**
 * How many messages of any kind an extension may send the server in one second. Each costs
 * the server's own thread a little; an extension that sends more is ended, because otherwise
 * it would slow down everything else.
 */
export const MAX_MESSAGES_PER_SECOND = 10_000;
/** What closing the host adds to the cleanup period before it ends whatever is left. */
const CLOSE_GRACE_MS = 1000;

export interface WorkerHostOptions extends ExtensionServices {
  /**
   * The module a worker thread starts with. Defaults to the built `worker-main.js` next to
   * this file. Tests, which run from the TypeScript sources, pass their own entry.
   */
  readonly bootstrap?: URL | undefined;
  readonly memoryMb?: number | undefined;
  readonly stopTimeoutMs?: number | undefined;
  readonly startTimeoutMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly heartbeatTimeoutMs?: number | undefined;
}

interface Running {
  readonly worker: Worker;
  readonly session: Session;
  state: 'starting' | 'running' | 'stopping' | 'ended';
  /** What the worker reported before it exited. */
  error?: Error;
  /** When the extension last showed that its thread is responsive. */
  lastSeen: number;
  /** When the heartbeat last ran, to notice when the server itself was held up. */
  lastTick: number;
  /** The messages received in the current second, and when that second began. */
  received: number;
  receivedSince: number;
  heartbeat?: ReturnType<typeof setInterval>;
  onStarted?: (error?: Error) => void;
  onDisposed?: () => void;
  onExit?: () => void;
  /** Resolves when the thread has ended. */
  readonly exited: Promise<void>;
  /** Writes what the log limiter held back. */
  flushLog(): void;
}

/**
 * Runs each extension in a worker thread of its own. An extension that throws, exits, stops
 * responding, floods the server or runs out of memory takes down its thread, never the
 * server: the host releases what the extension had registered and reports the crash.
 */
export class WorkerHost implements ExtensionHost {
  readonly #options: WorkerHostOptions;
  readonly #running = new Map<string, Running>();
  readonly #crashListeners: ((bundle: string, error: Error) => void)[] = [];
  #started = 0;
  #exited = 0;

  constructor(options: WorkerHostOptions) {
    this.#options = options;
  }

  start(spec: ExtensionSpec): Promise<void> {
    const { bundle } = spec;
    if (this.#running.has(bundle)) {
      return Promise.reject(new Error(`The extension of "${bundle}" is already running`));
    }
    const log = this.#options.logger.child(`bundle:${bundle}`);
    // The extension's thread limits its own log already. This second limit is twice as
    // wide, so it only acts on a thread that got around the first.
    const limiter = createLogLimiter({ maxLines: LOG_MAX_LINES * 2, maxBytes: LOG_MAX_BYTES * 2 });
    const reportDropped = (dropped: number) => {
      if (dropped > 0) log.warn(`${dropped} log lines dropped`);
    };
    const workerData: WorkerData = {
      bundle,
      version: spec.version,
      entry: spec.entry,
      config: spec.config ?? {},
    };
    const worker = new Worker(
      this.#options.bootstrap ?? new URL('./worker-main.js', import.meta.url),
      {
        workerData,
        name: `mooncg:${bundle}`,
        resourceLimits: {
          maxOldGenerationSizeMb: this.#options.memoryMb ?? DEFAULT_EXTENSION_MEMORY_MB,
        },
      },
    );
    this.#started++;
    const post = (message: HostToWorker) => worker.postMessage(message);
    const session = connectExtension(this.#options, spec, (msg) =>
      post({ type: 'frame', data: encodeMessage(msg) }),
    );
    const running: Running = {
      worker,
      session,
      state: 'starting',
      lastSeen: Date.now(),
      lastTick: Date.now(),
      received: 0,
      receivedSince: Date.now(),
      exited: new Promise((resolve) => worker.once('exit', () => resolve())),
      flushLog: () => reportDropped(limiter.takeDropped()),
    };
    this.#running.set(bundle, running);

    worker.on('message', (raw: unknown) => {
      // The worker runs bundle code, so what it posts is checked like any outside input.
      const message: WorkerToHost | undefined = readWorkerMessage(raw);
      const now = Date.now();
      running.lastSeen = now;
      if (now - running.receivedSince >= 1000) {
        running.receivedSince = now;
        running.received = 0;
      }
      if (++running.received > MAX_MESSAGES_PER_SECOND) {
        this.#crash(
          bundle,
          running,
          new Error(`Sent more than ${MAX_MESSAGES_PER_SECOND} messages in a second`),
        );
        return;
      }
      if (!message) log.warn('Ignored a malformed message from the extension thread');
      else if (message.type === 'frame') {
        if (message.data.length > MAX_FRAME_BYTES) {
          this.#crash(
            bundle,
            running,
            new Error(`Sent a frame larger than ${MAX_FRAME_BYTES} bytes`),
          );
        } else session.receive(message.data);
      } else if (message.type === 'log') {
        const { write, dropped } = limiter.accept(message.message);
        reportDropped(dropped);
        if (write) log[message.level](message.message);
      } else if (message.type === 'ready') running.onStarted?.();
      else if (message.type === 'failed') running.onStarted?.(new Error(message.message));
      else if (message.type === 'disposed') running.onDisposed?.();
    });
    // An uncaught exception, an unhandled rejection or a memory limit ends the thread. The
    // error arrives here first; the exit that follows is where it is acted on.
    worker.on('error', (error: unknown) => {
      running.error = error instanceof Error ? error : new Error(String(error));
    });
    worker.on('exit', (code) => {
      this.#exited++;
      running.onExit?.();
      const error = running.error ?? new Error(`The extension thread exited with code ${code}`);
      if (running.state === 'starting') running.onStarted?.(error);
      else if (running.state === 'running') this.#crash(bundle, running, error);
    });

    return new Promise<void>((resolve, reject) => {
      const limit = this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
      const timer = setTimeout(
        () => running.onStarted?.(new Error(`The extension did not start within ${limit} ms`)),
        limit,
      );
      running.onStarted = (error) => {
        if (running.state !== 'starting') return;
        clearTimeout(timer);
        if (!error) {
          running.state = 'running';
          this.#watch(bundle, running);
          resolve();
          return;
        }
        // Nothing the thread still sends may reach the server once its session is released.
        worker.removeAllListeners('message');
        this.#release(bundle, running);
        worker.terminate().then(
          () => reject(error),
          () => reject(error),
        );
      };
    });
  }

  async stop(bundle: string): Promise<void> {
    const running = this.#running.get(bundle);
    if (running?.state !== 'running') return;
    running.state = 'stopping';
    clearInterval(running.heartbeat);
    // Let the extension clean up, but not for longer than the limit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      running.onDisposed = resolve;
      running.onExit = resolve;
      timer = setTimeout(resolve, this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
      running.worker.postMessage({ type: 'dispose' } satisfies HostToWorker);
    });
    clearTimeout(timer);
    await running.worker.terminate();
    this.#release(bundle, running);
  }

  onCrash(listener: (bundle: string, error: Error) => void): void {
    this.#crashListeners.push(listener);
  }

  stats(): HostStats {
    const ledger: Record<string, SessionStats> = {};
    for (const [bundle, { session }] of this.#running) ledger[bundle] = session.stats();
    return {
      running: this.#running.size,
      ledger,
      threads: {
        started: this.#started,
        exited: this.#exited,
        live: this.#started - this.#exited,
      },
    };
  }

  /**
   * Stops every extension at the same time. One that is still starting is ended at once.
   * The whole takes no longer than one cleanup period and a little: after that, whatever is
   * left is ended without waiting for it.
   */
  async close(): Promise<void> {
    const all = [...this.#running];
    const stopped = Promise.all(
      all.map(async ([bundle, running]) => {
        if (running.state === 'running') await this.stop(bundle);
        else running.onStarted?.(new Error('The server is shutting down'));
        await running.exited;
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = (this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) + CLOSE_GRACE_MS;
    await Promise.race([
      stopped,
      new Promise((resolve) => {
        timer = setTimeout(resolve, deadline);
      }),
    ]);
    clearTimeout(timer);
    await Promise.all(
      all.map(async ([bundle, running]) => {
        if (running.state === 'ended') return;
        this.#release(bundle, running);
        await running.worker.terminate().catch(() => {});
      }),
    );
  }

  /** Asks a running extension for a sign of life, and gives up on one that stays silent. */
  #watch(bundle: string, running: Running): void {
    const interval = this.#options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const timeout = this.#options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    running.lastSeen = Date.now();
    running.lastTick = Date.now();
    running.heartbeat = setInterval(() => {
      const now = Date.now();
      // If this very check ran late, the server's own thread was busy and could not have
      // taken the extension's answer: that silence is not the extension's.
      if (now - running.lastTick > interval * 2) running.lastSeen = now;
      running.lastTick = now;
      if (now - running.lastSeen > timeout) {
        this.#crash(bundle, running, new Error(`The extension did not respond for ${timeout} ms`));
      } else running.worker.postMessage({ type: 'ping' } satisfies HostToWorker);
    }, interval);
    running.heartbeat.unref();
  }

  /** Ends a running extension that failed, and tells whoever listens for crashes. */
  #crash(bundle: string, running: Running, error: Error): void {
    if (running.state !== 'running') return;
    // Whatever the thread still has queued is of no interest any more.
    running.worker.removeAllListeners('message');
    this.#release(bundle, running);
    running.worker.terminate().catch(() => {});
    for (const listener of this.#crashListeners) listener(bundle, error);
  }

  /** Forgets the extension and releases everything it had registered. */
  #release(bundle: string, running: Running): void {
    running.state = 'ended';
    clearInterval(running.heartbeat);
    running.flushLog();
    running.session.close();
    if (this.#running.get(bundle) === running) this.#running.delete(bundle);
  }
}
