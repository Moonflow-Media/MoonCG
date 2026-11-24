import {
  createSession,
  extensionPrincipal,
  type Json,
  type MessageBus,
  type Policy,
  type ReplicantRegistry,
  type RouteTable,
  type ServerMessage,
  type Session,
  type SessionStats,
  TRUSTED_EXTENSION_POLICY,
} from '@mooncg/core';
import { errorMessage, type Logger } from '../kernel/logger.js';

/** Everything a host needs to run one extension. Plain data, so it can cross a thread boundary. */
export interface ExtensionSpec {
  readonly bundle: string;
  readonly version: string;
  /** Absolute path of the extension's entry module. */
  readonly entry: string;
  /** The manifest's `capabilities`: what the extension may reach beyond its own bundle. */
  readonly capabilities: readonly string[];
  /** The permission names the manifest declares. */
  readonly permissions: readonly string[];
  /**
   * The bundle's configuration, secrets included. It reaches the extension as its
   * `ctx.config` and goes nowhere else: not over the connection and not into a log.
   */
  readonly config?: Readonly<Record<string, Json>> | undefined;
}

export interface HostStats {
  /** How many extensions are running. */
  readonly running: number;
  /** What each running extension has registered on the server, by bundle. */
  readonly ledger: Readonly<Record<string, SessionStats>>;
  /** The worker threads the host has started and seen exit. `live` is the difference. */
  readonly threads: { readonly started: number; readonly exited: number; readonly live: number };
}

/**
 * Runs bundle extensions. `WorkerHost` gives each its own thread; `InlineHost` runs them in
 * the server's thread, for tests. Both speak to the server through a session, so an
 * extension is checked exactly like a client on a socket.
 */
export interface ExtensionHost {
  /** Loads the entry module and calls its default export. Rejects if that fails. */
  start(spec: ExtensionSpec): Promise<void>;
  /** Runs the extension's dispose callbacks and releases everything it registered. */
  stop(bundle: string): Promise<void>;
  /** `listener` is told when a started extension dies without having been stopped. */
  onCrash(listener: (bundle: string, error: Error) => void): void;
  stats(): HostStats;
  /** Stops every extension. */
  close(): Promise<void>;
}

/** What a host connects its extensions to. */
export interface ExtensionServices {
  readonly registry: ReplicantRegistry;
  readonly logger: Logger;
  readonly bus?: MessageBus | undefined;
  readonly routes?: RouteTable | undefined;
  /**
   * What the extension principal (`extension:<bundle>`) may do. Defaults to everything:
   * installed bundles are trusted code, limited by their capabilities only.
   */
  readonly policy?: Policy | undefined;
  /** How long a route handler may take. */
  readonly httpTimeoutMs?: number | undefined;
  /** Answers an extension's question whether a principal holds a permission of its bundle. */
  readonly checkPermission?: ((principal: string, permission: string) => boolean) | undefined;
}

/**
 * Opens the server side of an extension's connection. The session it returns is also the
 * ledger of what the extension registered: closing it releases all of it.
 */
export function connectExtension(
  services: ExtensionServices,
  spec: ExtensionSpec,
  send: (msg: ServerMessage) => void,
): Session {
  const log = services.logger.child(`bundle:${spec.bundle}`);
  return createSession({
    principal: extensionPrincipal(spec.bundle),
    policy: services.policy ?? TRUSTED_EXTENSION_POLICY,
    registry: services.registry,
    bus: services.bus,
    routes: services.routes,
    timers: { setTimeout, clearTimeout },
    // The extension belongs to the bundle that is being started.
    bundleExists: (name) => name === spec.bundle,
    send,
    onError: (error) => log.error(`Failed to handle a message: ${errorMessage(error)}`),
    checkPermission: services.checkPermission,
    extension: {
      capabilities: spec.capabilities,
      permissions: spec.permissions,
      ...(services.httpTimeoutMs === undefined ? {} : { httpTimeoutMs: services.httpTimeoutMs }),
    },
  });
}
