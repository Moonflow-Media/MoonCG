import type { AuthProvider } from '@mooncg/sdk/module';
import { createRemoteJWKSet, customFetch, type JWTPayload, jwtVerify } from 'jose';
import {
  authorizationUrl,
  type ClientAuth,
  codeOf,
  type Fetch,
  isRecord,
  providerUrl,
  REQUEST_TIMEOUT_MS,
  redeemCode,
  requestJson,
} from './http.js';

/**
 * The signature algorithms an ID token may use: the asymmetric ones. Never `none`, and never
 * an HMAC: its key would be the client secret, and a token that is merely passed through the
 * browser must not be checkable with something a leaked configuration gives away.
 */
const ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];
/** How far the clocks of the provider and of this server may differ, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;
/** How long what a provider says about itself is believed before it is asked again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** How long a provider that could not be asked about itself is left alone. */
const RETRY_PAUSE_MS = 5000;
const MAX_SUBJECT_LENGTH = 255;

export interface OidcSettings {
  readonly id: string;
  readonly name: string;
  /** The issuer, exactly as the provider states it: the `iss` of its ID tokens. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  /** `openid` is always asked for, whether it is named here or not. */
  readonly scopes?: readonly string[] | undefined;
  /** The `claims` parameter of the authorization request, for providers that want it. */
  readonly claims?: unknown;
  /**
   * How the client secret is sent to the token endpoint. Without it, what the provider says
   * it supports: `basic` if it can, as the specification has it for a default.
   */
  readonly clientAuth?: ClientAuth | undefined;
  readonly allowSignup?: boolean | undefined;
  readonly icon?: string | undefined;
}

interface Discovered {
  readonly authorization: URL;
  readonly token: URL;
  readonly keys: ReturnType<typeof createRemoteJWKSet>;
  readonly clientAuth: ClientAuth;
  readonly at: number;
}

export interface OidcDeps {
  readonly fetch?: Fetch | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * A login provider that speaks OpenID Connect: authorization code flow with PKCE.
 *
 * The provider is found by discovery, at `<issuer>/.well-known/openid-configuration`, over
 * HTTPS, and what it says there must name the configured issuer exactly. The ID token that
 * comes back for the code is verified against the keys of the provider: its signature, with
 * an asymmetric algorithm, its issuer, that it was made for this client, that it has not
 * expired, and that it carries the nonce of this sign-in. Who signed in is its `sub`, and
 * the realm of the account is the issuer.
 *
 * Nothing the provider sends is kept: the access token is not used, and no token is stored.
 */
export function createOidcProvider(settings: OidcSettings, deps: OidcDeps = {}): AuthProvider {
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const { clientId, clientSecret } = settings;
  // Checked when the provider is created, so that a wrong address shows when the module
  // starts and not when the first person tries to sign in.
  const issuer = providerUrl(settings.issuer, 'The issuer');
  if (issuer.search !== '' || issuer.hash !== '') {
    throw new Error('The issuer must not have a query or a fragment');
  }
  if (typeof clientId !== 'string' || clientId === '') {
    throw new Error(`The provider "${settings.id}" needs a client ID`);
  }
  const scopes = [...new Set(['openid', ...(settings.scopes ?? [])])].join(' ');

  let discovered: Promise<Discovered> | undefined;
  const discover = (): Promise<Discovered> => {
    const fresh = (async () => {
      const base = settings.issuer.replace(/\/$/, '');
      const { status, json } = await requestJson(
        send,
        providerUrl(`${base}/.well-known/openid-configuration`, 'The discovery address'),
        { method: 'GET' },
        'The provider',
      );
      if (status !== 200 || !isRecord(json)) {
        throw new Error(`The provider did not describe itself (${status})`);
      }
      // What answers at the address must be the issuer that was configured, to the letter:
      // otherwise another issuer's tokens would be taken for this one's.
      if (json.issuer !== settings.issuer) {
        throw new Error(
          `The provider says its issuer is ${JSON.stringify(json.issuer)}, not ${JSON.stringify(settings.issuer)}`,
        );
      }
      const methods = json.token_endpoint_auth_methods_supported;
      const supported = Array.isArray(methods) ? methods : ['client_secret_basic'];
      const keysUrl = providerUrl(json.jwks_uri, 'The address of the keys');
      return {
        authorization: providerUrl(json.authorization_endpoint, 'The authorization endpoint'),
        token: providerUrl(json.token_endpoint, 'The token endpoint'),
        keys: createRemoteJWKSet(keysUrl, {
          timeoutDuration: REQUEST_TIMEOUT_MS,
          [customFetch]: (url, options) => send(url, options),
        }),
        clientAuth:
          settings.clientAuth ?? (supported.includes('client_secret_basic') ? 'basic' : 'post'),
        at: now(),
      } satisfies Discovered;
    })();
    discovered = fresh;
    // A failure is not kept for long: a sign-in a few seconds later asks again.
    fresh.catch((error: unknown) => {
      if (discovered !== fresh) return;
      discovered = undefined;
      failed = { error, at: now() };
    });
    return fresh;
  };
  /** The last failure to ask the provider about itself, so that it is not asked at once again. */
  let failed: { readonly error: unknown; readonly at: number } | undefined;
  const provider = async (): Promise<Discovered> => {
    // Whoever keeps starting sign-ins while the provider is down does not make this server
    // knock on its door each time.
    if (failed && now() - failed.at < RETRY_PAUSE_MS) throw failed.error;
    const known = await discovered?.catch(() => undefined);
    return known && now() - known.at < DISCOVERY_TTL_MS ? known : discover();
  };

  return {
    id: settings.id,
    name: settings.name,
    icon: settings.icon,
    allowSignup: settings.allowSignup === true,

    async authorize({ state, nonce, codeChallenge, redirectUri }) {
      const { authorization } = await provider();
      return authorizationUrl(authorization, {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        claims: settings.claims === undefined ? undefined : JSON.stringify(settings.claims),
      });
    },

    async callback({ query, redirectUri, nonce, codeVerifier }) {
      const code = codeOf(query);
      const { token, keys, clientAuth } = await provider();
      const answer = await redeemCode(send, token, {
        code,
        redirectUri,
        codeVerifier,
        clientId,
        clientSecret: clientSecret === '' ? undefined : clientSecret,
        clientAuth,
      });
      if (typeof answer.id_token !== 'string') {
        throw new Error('The token endpoint sent no ID token');
      }
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(answer.id_token, keys, {
          issuer: settings.issuer,
          audience: clientId,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          // An ID token without an expiry would be valid for ever.
          requiredClaims: ['exp', 'sub'],
        }));
      } catch (error) {
        throw new Error(`The ID token is not valid: ${(error as Error).message}`);
      }
      // A token for several audiences says which of them it was issued to.
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
        throw new Error('The ID token is not valid: it was issued to another client');
      }
      if (payload.azp !== undefined && payload.azp !== clientId) {
        throw new Error('The ID token is not valid: it was issued to another client');
      }
      // The nonce ties the token to this sign-in: one from another sign-in, replayed here,
      // carries another or none.
      if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) {
        throw new Error('The ID token is not valid: it does not carry the nonce of this sign-in');
      }
      const { sub } = payload;
      if (typeof sub !== 'string' || sub === '' || sub.length > MAX_SUBJECT_LENGTH) {
        throw new Error('The ID token is not valid: it names no usable subject');
      }
      // A name to call a new user by. An e-mail address is never looked at.
      const name = [payload.preferred_username, payload.nickname, payload.name].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
      );
      // The issuer vouches for the account: the token was verified to be its own. The same
      // subject under another issuer is another account, and the server holds a link to
      // that. The client ID is no part of it: with most providers a subject is the same for
      // every client, and a new client registration at the same issuer must not cut every
      // link. Where subjects differ per client (pairwise), a new client has new subjects
      // anyway, and the old links then match nobody.
      return { subject: sub, name, realm: settings.issuer };
    },
  };
}
