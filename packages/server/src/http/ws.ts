import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import {
  createSession,
  effectiveGrants,
  encodeMessage,
  MAX_FRAME_BYTES,
  type MessageBus,
  type ReplicantRegistry,
} from '@mooncg/core';
import { type WebSocket, WebSocketServer } from 'ws';
import { errorMessage, type Logger } from '../kernel/logger.js';
import { type Identify, type RequestIdentity, type Transport, viaHttps } from './identity.js';
import { originAllowed } from './origin.js';

export interface WebSocketOptions {
  readonly registry: ReplicantRegistry;
  /** Without it, clients have no messages. */
  readonly bus?: MessageBus | undefined;
  /** Whether a bundle of that name is running. Clients of other bundles are turned away. */
  readonly bundleExists: (bundle: string) => boolean;
  /** Finds out who an upgrade request acts as: its session cookie or its bearer token. */
  readonly identify: Identify;
  /** Origins besides the server's own whose pages may connect. */
  readonly allowedOrigins: readonly string[];
  /** Whether a proxy is trusted to say that the server is reached over HTTPS. */
  readonly transport?: Transport | undefined;
  readonly logger: Logger;
}

export interface WebSocketHandle {
  /**
   * Asks again who each open socket acts as and closes those whose access is not what it
   * was when they connected. Their clients reconnect and get what they may have now.
   */
  recheck(): void;
  /** Drops every socket. */
  close(): void;
}

const WS_PATH = '/ws';

/** The close code for a socket whose principal lost or changed its access. */
export const ACCESS_CHANGED = 4401;

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
  https = false,
): string | undefined {
  const { url, headers } = request;
  // A request target such as "//" is not a path of this server and does not parse as one.
  if (url === undefined || !URL.canParse(url, 'http://localhost')) return '400 Bad Request';
  if (new URL(url, 'http://localhost').pathname !== WS_PATH) return '404 Not Found';

  return originAllowed(headers, allowedOrigins, https) ? undefined : '403 Forbidden';
}

/** What a principal may do, in a form that is equal exactly when the access is. */
const accessOf = ({ principal, policy }: RequestIdentity): string =>
  JSON.stringify([principal.id, effectiveGrants(principal, policy)]);

/**
 * Accepts WebSocket upgrades on `/ws` and runs one protocol session per socket. A socket
 * needs a signed-in principal; what it may do inside is checked per request. The session
 * keeps the principal and policy it started with, so a socket whose access changes is closed
 * rather than left running with what it had.
 */
export function attachWebSocket(server: Server, options: WebSocketOptions): WebSocketHandle {
  const { registry, bus, bundleExists, identify, allowedOrigins, logger } = options;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const open = new Map<WebSocket, { request: IncomingMessage; access: string }>();

  server.on('upgrade', (request, socket, head) => {
    // Without a listener, a connection reset during the upgrade would be an uncaught exception.
    socket.on('error', (error) =>
      logger.warn(`Socket error during upgrade: ${errorMessage(error)}`),
    );
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

    const https = viaHttps(request.headers, options.transport ?? {});
    const refusal = upgradeRefusal(request, allowedOrigins, https);
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    const identity = identify(request);
    if (identity.principal.kind === 'anonymous') {
      refuse('401 Unauthorized');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const session = createSession({
        principal: identity.principal,
        policy: identity.policy,
        registry,
        bus,
        timers: { setTimeout, clearTimeout },
        bundleExists,
        send: (msg) => ws.send(encodeMessage(msg)),
        onError: (error) => logger.error(`Failed to handle a message: ${errorMessage(error)}`),
      });
      open.set(ws, { request, access: accessOf(identity) });
      // The protocol is JSON text. A binary frame is passed on as text and fails to decode.
      // `receive` never throws, so one bad message cannot take the server down.
      ws.on('message', (data) => session.receive(data.toString()));
      ws.on('close', () => {
        open.delete(ws);
        session.close();
      });
      ws.on('error', (error) => logger.warn(`Socket error: ${errorMessage(error)}`));
    });
  });

  return {
    recheck() {
      for (const [ws, { request, access }] of open) {
        if (accessOf(identify(request)) === access) continue;
        open.delete(ws);
        ws.close(ACCESS_CHANGED, 'Access changed');
      }
    },
    close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
    },
  };
}
