import type { IncomingHttpHeaders, Server } from 'node:http';
import {
  authorize,
  createSession,
  DASHBOARD_VIEW,
  encodeMessage,
  MAX_FRAME_BYTES,
  type MessageBus,
  type Policy,
  type ReplicantRegistry,
} from '@mooncg/core';
import { WebSocketServer } from 'ws';
import { errorMessage, type Logger } from '../kernel/logger.js';
import type { ResolvePrincipal } from './app.js';
import { originAllowed } from './origin.js';

export interface WebSocketOptions {
  readonly registry: ReplicantRegistry;
  /** Without it, clients have no messages. */
  readonly bus?: MessageBus | undefined;
  /** Whether a bundle of that name is running. Clients of other bundles are turned away. */
  readonly bundleExists: (bundle: string) => boolean;
  readonly policy: Policy;
  readonly resolvePrincipal: ResolvePrincipal;
  /** Origins besides the server's own whose pages may connect. */
  readonly allowedOrigins: readonly string[];
  readonly logger: Logger;
}

const WS_PATH = '/ws';

// A frame over the limit closes the socket with code 1009.
export { MAX_FRAME_BYTES };

/**
 * Decides from the request line and headers whether an upgrade is acceptable. Returns the HTTP
 * status to refuse it with, or `undefined` to go on.
 *
 * A browser page may connect only from the server's own origin (its `Origin` matches the
 * request's `Host`) or from an allowed origin. Requests without `Origin` come from non-browser
 * clients, which this check is not about.
 */
export function upgradeRefusal(
  request: { readonly url?: string | undefined; readonly headers: IncomingHttpHeaders },
  allowedOrigins: readonly string[],
): string | undefined {
  const { url, headers } = request;
  // A request target such as "//" is not a path of this server and does not parse as one.
  if (url === undefined || !URL.canParse(url, 'http://localhost')) return '400 Bad Request';
  if (new URL(url, 'http://localhost').pathname !== WS_PATH) return '404 Not Found';

  return originAllowed(headers, allowedOrigins) ? undefined : '403 Forbidden';
}

/**
 * Accepts WebSocket upgrades on `/ws` and runs one protocol session per socket.
 * Returns a function that drops every socket.
 */
export function attachWebSocket(server: Server, options: WebSocketOptions): () => void {
  const { registry, bus, bundleExists, policy, resolvePrincipal, allowedOrigins, logger } = options;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('upgrade', (request, socket, head) => {
    // Without a listener, a connection reset during the upgrade would be an uncaught exception.
    socket.on('error', (error) =>
      logger.warn(`Socket error during upgrade: ${errorMessage(error)}`),
    );
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

    const refusal = upgradeRefusal(request, allowedOrigins);
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    const principal = resolvePrincipal(request);
    if (!authorize(principal, DASHBOARD_VIEW, policy)) {
      refuse('403 Forbidden');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const session = createSession({
        principal,
        policy,
        registry,
        bus,
        timers: { setTimeout, clearTimeout },
        bundleExists,
        send: (msg) => ws.send(encodeMessage(msg)),
        onError: (error) => logger.error(`Failed to handle a message: ${errorMessage(error)}`),
      });
      // The protocol is JSON text. A binary frame is passed on as text and fails to decode.
      // `receive` never throws, so one bad message cannot take the server down.
      ws.on('message', (data) => session.receive(data.toString()));
      ws.on('close', () => session.close());
      ws.on('error', (error) => logger.warn(`Socket error: ${errorMessage(error)}`));
    });
  });

  return () => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
  };
}
