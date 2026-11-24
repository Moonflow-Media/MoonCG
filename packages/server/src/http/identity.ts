import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  ANONYMOUS_PRINCIPAL,
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
}

/**
 * Whether the request reached the user's side of a trusted proxy over HTTPS. The server
 * itself speaks plain HTTP, so without a proxy it is trusted to speak for, the answer is no.
 */
export function viaHttps(headers: IncomingHttpHeaders, transport: Transport): boolean {
  return transport.trustProxy === true && headers['x-forwarded-proto'] === 'https';
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

export interface IdentifyOptions extends Transport {
  readonly auth?: Auth | undefined;
  readonly resolvePrincipal?: ResolvePrincipal | undefined;
  readonly policy?: Policy | undefined;
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
    return ({ headers }) => auth.identify(credentialsOf(headers, secureCookies(headers, options)));
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
