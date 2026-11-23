// The entry of an extension's worker thread. It connects to the server over the thread's
// message port, builds the bundle context on that connection and runs the extension.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { createBundleContext, createConnection } from '@mooncg/sdk/extension';
import { createLogLimiter } from './log-limiter.js';
import type { HostToWorker, LogLevel, WorkerData, WorkerToHost } from './worker-protocol.js';

if (!parentPort) throw new Error('This file is the entry of a worker thread');
const port = parentPort;
const { bundle, version, entry } = workerData as WorkerData;
const post = (message: WorkerToHost) => port.postMessage(message);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Lines over the limit are dropped right here, so that an extension that logs without pause
// costs the server nothing. The server applies a limit of its own as well.
const limiter = createLogLimiter();
const log = (level: LogLevel) => (message: string) => {
  const { write, dropped } = limiter.accept(String(message));
  if (dropped > 0) post({ type: 'log', level: 'warn', message: `${dropped} log lines dropped` });
  if (write) post({ type: 'log', level, message: String(message) });
};
const bundleLog = { info: log('info'), warn: log('warn'), error: log('error') };

/** The message port, shaped like the socket the client code expects. */
const listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
const emit = (type: string, event: { data?: unknown }) => {
  for (const listener of listeners[type] ?? []) listener(event);
};

const connection = createConnection({
  bundle,
  url: 'worker:',
  onError: (message, error) => bundleLog.error(`${message}: ${describe(error)}`),
  createSocket: () => ({
    send: (data) => post({ type: 'frame', data }),
    close: () => emit('close', {}),
    addEventListener: (type, listener) => {
      listeners[type] = [...(listeners[type] ?? []), listener];
    },
  }),
});
const { context, dispose } = createBundleContext({
  connection,
  bundle: { name: bundle, version },
  log: bundleLog,
});

port.on('message', (message: HostToWorker) => {
  if (message.type === 'frame') emit('message', { data: message.data });
  else if (message.type === 'ping') post({ type: 'pong' });
  else if (message.type === 'dispose') dispose().then(() => post({ type: 'disposed' }));
});
emit('open', {});

// An extension imports `@mooncg/sdk/...` without having installed anything: the import is
// resolved as if this file had written it, which finds the server's own copy. That copy also
// wins over one in the bundle's `node_modules`, so extension and server always speak the
// same protocol version and share one `MoonCGError`.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const isSdk = specifier === '@mooncg/sdk' || specifier.startsWith('@mooncg/sdk/');
    return nextResolve(specifier, isSdk ? { ...context, parentURL: import.meta.url } : context);
  },
});

try {
  await connection.ready;
  const module: { default?: unknown } = await import(pathToFileURL(entry).href);
  if (typeof module.default !== 'function') {
    throw new Error(`Extension "${entry}" must have a function as its default export`);
  }
  await module.default(context);
  post({ type: 'ready' });
} catch (error) {
  post({ type: 'failed', message: describe(error) });
}
