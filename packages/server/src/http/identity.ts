import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  ANONYMOUS_PRINCIPAL,
  isLoopbackAddress,
  isLoopbackAuthority,
  isLoopbackOrigin,
  type Policy,
  type Principal,
} from '@mooncg/core';
import type { Auth, Credentials, Identity } from '../auth/auth.js';

/** The cookie of a signed-in user. */
export const SESSION_COOKIE = 'mooncg_session';
/**
 * The cookie an API token in a page URL is exchanged for. It is a cookie of its own so that
 * opening such a URL does not sign a user out of the dashboard in the same browser.
 */
export const TOKEN_COOKIE = 'mooncg_token';
/**
 * Put in front of both cookie names when they are `Secure`. A browser accepts a `__Host-`
 * cookie only over HTTPS, for this exact host and for the whole site, so neither a page on a
 * sibling domain nor one served over plain HTTP can plant one.
 */
export const HOST_PREFIX = '__Host-';

/**
 * Finds out who a request acts as. Tests inject one to act as a fixed principal; the server
 * itself always asks its accounts.
 */
export type ResolvePrincipal = (request: IncomingMessage) => Principal;
/** Everyone is an administrator. For tests only: the server never falls back to it. */
export const resolveLocalAdmin: ResolvePrincipal = () => ALLOW_ALL_PRINCIPAL;

/** Who a request acts as. `injected` is the answer of a `ResolvePrincipal` a test passed in. */
export type RequestIdentity = Omit<Identity, 'via'> & {
  readonly via: Identity['via'] | 'injected';
};
export type Identify = (request: IncomingMessage) => RequestIdentity;

/** How the server is reached, as far as cookies and origins are concerned. */
export interface Transport {
  /** Marks session cookies `Secure` on every request. */
  readonly secureCookies?: boolean | undefined;
  /** Believes `X-Forwarded-Proto` and `X-Forwarded-For`. Only behind a reverse proxy. */
  readonly trustProxy?: boolean | undefined;
  /** The origin people reach the server at, if it was configured. */
  readonly publicUrl?: string | undefined;
}

/** Whether a request is addressed to the configured public address, and that one is HTTPS. */
function atHttpsPublicUrl(headers: IncomingHttpHeaders, transport: Transport): boolean {
  if (transport.publicUrl === undefined || !URL.canParse(transport.publicUrl)) return false;
  const { protocol, host } = new URL(transport.publicUrl);
  return protocol === 'https:' && headers.host?.toLowerCase() === host;
}

/**
 * Whether the request reached the user's side over HTTPS. The server itself speaks plain
 * HTTP, so it is told: by a proxy it is trusted to speak for (`X-Forwarded-Proto`), or by
 * the configuration, which says that the public address is an `https://` one. A request
 * addressed to that address came through whatever ends TLS in front of the server, whether
 * or not that passes a header on. The name is the `Host` of the request, which is not
 * proof of anything, and need not be: answering as for HTTPS only ever makes the server
 * stricter. Its cookies are then `Secure` and carry the `__Host-` prefix, which a browser
 * that did come over plain HTTP refuses to keep, and only a page of the `https://` origin
 * counts as its own.
 */
export function viaHttps(headers: IncomingHttpHeaders, transport: Transport): boolean {
  return (
    (transport.trustProxy === true && headers['x-forwarded-proto'] === 'https') ||
    atHttpsPublicUrl(headers, transport)
  );
}

/** Whether cookies set in answer to this request are `Secure`, and so carry the prefix. */
export function secureCookies(headers: IncomingHttpHeaders, transport: Transport): boolean {
  return transport.secureCookies === true || viaHttps(headers, transport);
}

/** The name a cookie has for this request: with the `__Host-` prefix when it is `Secure`. */
export function cookieName(name: string, secure: boolean): string {
  return secure ? `${HOST_PREFIX}${name}` : name;
}

/**
 * What a request brought along to say who it is. A session or token cookie that is there
 * twice makes the whole request invalid: which of the two a browser sends first is something
 * an attacker who can plant a cookie may influence, so neither is believed.
 */
export function credentialsOf(headers: IncomingHttpHeaders, secure = false): Credentials {
  const wanted = [cookieName(SESSION_COOKIE, secure), cookieName(TOKEN_COOKIE, secure)];
  const found = new Map<string, string>();
  let invalid = false;
  for (const part of headers.cookie?.split(';') ?? []) {
    const at = part.indexOf('=');
    const name = at > 0 ? part.slice(0, at).trim() : '';
    if (!wanted.includes(name)) continue;
    if (found.has(name)) invalid = true;
    found.set(name, part.slice(at + 1).trim());
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
  return {
    session: found.get(wanted[0] as string),
    tokenSession: found.get(wanted[1] as string),
    bearer,
    ...(invalid ? { invalid } : {}),
  };
}

/** The query parameter an API token may arrive in. A bundle route never sees it. */
export const TOKEN_PARAMETER = 'token';

/**
 * Whether a request says anything about who it is: a session or token cookie, an
 * `Authorization` header of any kind, or a `token` in its address. Whether any of it is
 * valid is another question. Dev mode asks this: whoever brought credentials that are not
 * accepted is refused like everywhere else, and never signed in as someone else instead.
 */
export function carriesCredentials(
  request: Pick<IncomingMessage, 'headers' | 'url'>,
  secure = false,
): boolean {
  const { headers, url = '' } = request;
  const { session, tokenSession, invalid } = credentialsOf(headers, secure);
  if (session !== undefined || tokenSession !== undefined || invalid) return true;
  if (headers.authorization !== undefined) return true;
  const at = url.indexOf('?');
  if (at === -1) return false;
  return url
    .slice(at + 1)
    .split('&')
    .some((parameter) => parameter.split('=')[0] === TOKEN_PARAMETER);
}

/** Headers a proxy adds to what it passes on. A request with one did not come straight here. */
const PROXY_HEADERS = [
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
] as const;

/**
 * Whether dev mode may sign a request in without credentials. All of it must hold:
 *
 * - the other end of the socket is this machine. That is the address of the connection
 *   itself; no header is believed about where a request comes from;
 * - no proxy passed the request on: behind a proxy on this machine every request of the
 *   whole network would come from loopback;
 * - the request is addressed to this machine by a loopback name. A page of another site
 *   whose name was pointed at 127.0.0.1 (DNS rebinding) reaches the socket from loopback,
 *   but its requests still carry its own name as `Host`;
 * - the request does not come from a page of another site: it states no `Origin`, as a
 *   command line tool, OBS or a page that navigates does, or one on this machine, which is
 *   the server's own, that of another server here and that of every `dev.url` (a manifest
 *   takes no other). The visitor's browser is on this machine whatever page it shows, so the
 *   address of the socket says nothing about the page; its origin does. This holds even for
 *   an origin that is allowed to connect: allowed is not signed in.
 */
export function devLoginAllowed(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const { headers, socket } = request;
  return (
    isLoopbackAddress(socket.remoteAddress) &&
    isLoopbackAuthority(headers.host) &&
    PROXY_HEADERS.every((name) => headers[name] === undefined) &&
    (headers.origin === undefined || isLoopbackOrigin(headers.origin))
  );
}

export interface IdentifyOptions extends Transport {
  readonly auth?: Auth | undefined;
  readonly resolvePrincipal?: ResolvePrincipal | undefined;
  readonly policy?: Policy | undefined;
  /**
   * Dev mode only: who a request that brought no credentials at all acts as, if
   * `devLoginAllowed` lets it. Without it, such a request is anonymous, as it always is
   * outside dev mode.
   */
  readonly devLogin?: (() => RequestIdentity) | undefined;
}

/**
 * Builds the one function HTTP and WebSocket use to identify a request. An injected principal
 * or policy wins (tests); otherwise the accounts decide; without either, everyone is
 * anonymous. There is no mode in which an unidentified request may do anything.
 */
export function createIdentify(options: IdentifyOptions): Identify {
  const { auth, resolvePrincipal, policy } = options;
  if (resolvePrincipal !== undefined || policy !== undefined) {
    return (request) => ({
      principal: (resolvePrincipal ?? resolveLocalAdmin)(request),
      policy: policy ?? ALLOW_ALL_POLICY,
      via: 'injected',
    });
  }
  if (auth) {
    const { devLogin } = options;
    return (request) => {
      const { headers } = request;
      const secure = secureCookies(headers, options);
      const identity = auth.identify(credentialsOf(headers, secure));
      // Whoever brings credentials acts as themselves, also in dev mode.
      if (identity.principal.kind !== 'anonymous' || devLogin === undefined) return identity;
      // And whoever brings credentials that are not accepted is refused, also in dev mode:
      // an expired session or a revoked token must not turn into an administrator.
      if (carriesCredentials(request, secure)) return identity;
      return devLoginAllowed(request) ? devLogin() : identity;
    };
  }
  return () => ({ principal: ANONYMOUS_PRINCIPAL, policy: { roles: {} }, via: 'none' });
}

export interface CookieOptions {
  readonly secure: boolean;
  /** Seconds the browser keeps the cookie; 0 removes it. */
  readonly maxAge: number;
}

/**
 * A `Set-Cookie` value: never readable by scripts, never sent from another site's requests,
 * and named with the `__Host-` prefix when it is `Secure`.
 */
export function sessionCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${cookieName(name, options.secure)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
