import { pathToFileURL } from 'node:url';
import { encodeMessage, type Session, type SessionStats } from '@mooncg/core';
import { createBundleContext, createConnection, createLoopback } from '@mooncg/sdk/extension';
import { errorMessage } from '../kernel/logger.js';
import {
  connectExtension,
  type ExtensionHost,
  type ExtensionServices,
  type ExtensionSpec,
  type HostStats,
} from './extension-host.js';

/**
 * Runs extensions inside the server's own thread. It exists to keep unit tests fast and must
 * not be used to run a server. It differs from `WorkerHost`, which the server uses:
 *
 * - Messages between extension and server are delivered synchronously, in the same call
 *   stack, where a worker thread always delivers them later.
 * - There are no time limits: an extension that never finishes starting or cleaning up hangs
 *   the call, and nothing watches whether it still responds.
 * - A module stays in Node's module cache after `stop`, so changed code is not picked up.
 * - A failure after start (an uncaught exception, an unhandled rejection) is not attributed
 *   to the bundle; `onCrash` never fires.
 * - Dispose callbacks also run when the extension fails to start. In a worker they do not:
 *   the thread is simply ended.
 * - There is no memory limit, no log limit and no limit on frame size.
 *
 * Whatever depends on one of these is tested with `WorkerHost`.
 */
export class InlineHost implements ExtensionHost {
  readonly #services: ExtensionServices;
  readonly #running = new Map<string, { session: Session; dispose(): Promise<void> }>();

  constructor(services: ExtensionServices) {
    this.#services = services;
  }

  async start(spec: ExtensionSpec): Promise<void> {
    if (this.#running.has(spec.bundle)) {
      throw new Error(`The extension of "${spec.bundle}" is already running`);
    }
    const log = this.#services.logger.child(`bundle:${spec.bundle}`);
    const loopback = createLoopback();
    const session = connectExtension(this.#services, spec, (msg) =>
      loopback.server.send(encodeMessage(msg)),
    );
    loopback.server.onFrame((frame) => session.receive(frame));
    loopback.server.onClose(() => session.close());

    const connection = createConnection({
      bundle: spec.bundle,
      url: 'loopback:',
      createSocket: () => loopback.socket,
      onError: (message, error) => log.error(`${message}: ${errorMessage(error)}`),
    });
    const { context, dispose } = createBundleContext({
      connection,
      bundle: { name: spec.bundle, version: spec.version },
      log,
    });
    this.#running.set(spec.bundle, { session, dispose });
    try {
      await connection.ready;
      const module: { default?: unknown } = await import(pathToFileURL(spec.entry).href);
      if (typeof module.default !== 'function') {
        throw new Error(`Extension "${spec.entry}" must have a function as its default export`);
      }
      await module.default(context);
    } catch (error) {
      await this.stop(spec.bundle);
      throw error;
    }
  }

  async stop(bundle: string): Promise<void> {
    const running = this.#running.get(bundle);
    this.#running.delete(bundle);
    // Closes the connection, which closes the session and with it the ledger.
    await running?.dispose();
  }

  onCrash(): void {
    // An extension in the server's own thread cannot crash on its own.
  }

  stats(): HostStats {
    const ledger: Record<string, SessionStats> = {};
    for (const [bundle, { session }] of this.#running) ledger[bundle] = session.stats();
    return { running: this.#running.size, ledger, threads: { started: 0, exited: 0, live: 0 } };
  }

  async close(): Promise<void> {
    for (const bundle of [...this.#running.keys()]) await this.stop(bundle);
  }
}
