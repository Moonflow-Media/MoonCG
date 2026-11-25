import type { HttpMethod, Json, PrincipalKind } from '@mooncg/core';

export type { HttpMethod, Json } from '@mooncg/core';
export { MoonCGError } from '@mooncg/core';

/**
 * What a module is written against. A module is trusted code that runs inside the server
 * process: it lives in the `modules` folder of an installation as a folder with a
 * `mooncg.json` of `"kind": "module"`, and its main file exports a setup function:
 *
 * ```js
 * import { defineModule } from '@mooncg/sdk/module';
 *
 * export default defineModule((ctx) => {
 *   ctx.logger.info('Hello');
 *   return () => ctx.logger.info('Goodbye');
 * });
 * ```
 *
 * Everything a module registers through its context is taken away again when the module is
 * disabled or fails. What it does beside the context (timers, sockets, files) it cleans up
 * itself, in what its setup returns or passes to `onDispose`.
 */
export interface ModuleContext {
  /** The name of the module, from its manifest. */
  readonly name: string;
  /** The folder the module lies in. */
  readonly dir: string;
  /**
   * The configuration as it was when the module started: what is stored, checked against the
   * schema the manifest names, with the defaults of the schema filled in. Secrets are in it.
   * A module without a schema has an empty one. Saving the configuration starts the module
   * again.
   */
  readonly config: Readonly<Record<string, Json>>;
  readonly logger: ModuleLogger;
  readonly auth: {
    /**
     * Adds a way to sign in with an account kept elsewhere. The provider shows as a button on
     * the login page. Throws when the id is taken or cannot be one.
     */
    registerProvider(provider: AuthProvider): void;
  };
  readonly http: {
    /**
     * Adds a route below `/m/<module>`. A route says what a caller needs: `permission`, or
     * `public: true` for one that anybody may call. Throws without either.
     */
    register(route: ModuleRoute): void;
  };
  readonly permissions: {
    /**
     * Makes a permission of the module known and returns its full name,
     * `system:module.<module>.<name>`, as roles and tokens are granted it and as a route
     * names it. It shows on the Roles page with the description.
     */
    define(name: string, description: string): string;
  };
  /** Runs `dispose` when the module stops, last registered first. */
  onDispose(dispose: ModuleDispose): void;
}

export interface ModuleLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type ModuleDispose = () => void | Promise<void>;

/** Starts a module. It may return what stops it again. */
export type ModuleSetup = (
  ctx: ModuleContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: a setup may return nothing at all
) => void | ModuleDispose | Promise<void | ModuleDispose>;

/** Types the setup of a module. It adds nothing at run time. */
export function defineModule(setup: ModuleSetup): ModuleSetup {
  return setup;
}

/**
 * A way to sign in with an account kept elsewhere, by sending the browser there and back
 * (OAuth 2.0 authorization code, OpenID Connect).
 *
 * The server does everything that is the same for every provider and must not go wrong: it
 * creates `state`, `nonce` and the PKCE verifier, binds them to the browser, accepts each
 * `state` once and for a few minutes only, builds the redirect address from its own
 * configuration, decides which user the account belongs to, and opens the session. The
 * provider does what differs: where to send the browser, and how to turn what comes back
 * into the stable id of the account.
 */
export interface AuthProvider {
  /** Part of the address (`/auth/<id>/…`) and of the stored links: lowercase, digits, dashes. */
  readonly id: string;
  /** What the button on the login page says. */
  readonly name: string;
  /**
   * An image for the button: an `.svg` or `.png` file in the folder of the module, as a
   * relative path. The server serves it itself; the login page loads nothing from elsewhere.
   */
  readonly icon?: string | undefined;
  /**
   * Whether an account nobody has linked yet gets a new user, without any role. Off unless
   * set: then such an account is refused until an administrator links it.
   */
  readonly allowSignup?: boolean | undefined;
  /** The address the browser is sent to. Everything in the request must be passed on. */
  authorize(request: AuthorizeRequest): string | Promise<string>;
  /**
   * Called when the browser comes back with a `state` the server issued to it. Verifies what
   * the provider says and answers who it is. Throws when anything does not hold: the sign-in
   * is then refused, and the reason goes to the server log, not to the browser.
   */
  callback(request: CallbackRequest): ExternalIdentity | Promise<ExternalIdentity>;
}

export interface AuthorizeRequest {
  /** Comes back with the browser. The server checks it. */
  readonly state: string;
  /** For OpenID Connect: must be in the ID token that comes back. */
  readonly nonce: string;
  /** The PKCE challenge of the verifier `callback` gets, by the method `S256`. */
  readonly codeChallenge: string;
  /** Where the provider sends the browser back to. Register exactly this with the provider. */
  readonly redirectUri: string;
}

export interface CallbackRequest {
  /** The query of the callback without `state`: `code`, or `error` and its description. */
  readonly query: Readonly<Record<string, string>>;
  /** The same address `authorize` was given. */
  readonly redirectUri: string;
  /** The nonce `authorize` was given. An ID token must carry exactly this. */
  readonly nonce: string;
  /** The PKCE verifier to redeem the code with. */
  readonly codeVerifier: string;
}

/** Who an external account is, as its provider tells it. */
export interface ExternalIdentity {
  /**
   * The stable id the provider has for the account, such as the `sub` of an ID token. Never
   * an e-mail address or a display name: those change hands.
   */
  readonly subject: string;
  /**
   * A name, for the user that signing up creates and for administrators to recognize the
   * account by. It is never used to find an existing user.
   */
  readonly name?: string | undefined;
  /**
   * Who vouches for the account: what makes the subject mean this account and no other, such
   * as the issuer of an OpenID Connect provider, or a fixed text for a provider that is one
   * service. At most 255 characters. The server stores it with the link of a user to the
   * account and refuses the account when a later sign-in reports another: the id of a
   * provider is a name in the settings, and when the settings point it at another issuer,
   * the same subject there is somebody else. A provider whose settings decide whom it asks
   * should always report one.
   */
  readonly realm?: string | undefined;
}

/** A request as the route of a module gets it. Cookies and tokens of the caller are not in it. */
export interface ModuleRequest {
  readonly method: HttpMethod;
  /** The path below `/m/<module>`, starting with `/`. */
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** The body as it came, or `null` without one. */
  readonly body: Uint8Array | null;
  /** Who is calling: `user:<id>`, `token:<id>` or, on a public route, perhaps `anonymous`. */
  readonly principal: { readonly id: string; readonly kind: PrincipalKind };
}

export interface ModuleResponse {
  /** 200 unless set. */
  readonly status?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Text and bytes are sent as they are, anything else as JSON. */
  readonly body?: string | Uint8Array | Json | undefined;
}

export interface ModuleRoute {
  readonly method: HttpMethod;
  /** Such as `/items/:id`: literal segments and `:name` parameters. */
  readonly path: string;
  /**
   * The permission a caller needs: one the module defined, or a system permission. Checked
   * by the server before the handler runs.
   */
  readonly permission?: string | undefined;
  /** Says on purpose that anybody may call the route, signed in or not. */
  readonly public?: true | undefined;
  handler(request: ModuleRequest): ModuleResponse | Promise<ModuleResponse>;
}
