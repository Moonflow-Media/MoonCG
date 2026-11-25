import type { AuthProvider } from '@mooncg/sdk/module';
import {
  authorizationUrl,
  type ClientAuth,
  codeOf,
  type Fetch,
  isRecord,
  providerUrl,
  redeemCode,
  requestJson,
} from './http.js';

const MAX_SUBJECT_LENGTH = 255;

export interface OAuth2Settings {
  readonly id: string;
  readonly name: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Answers who the access token belongs to, as JSON. */
  readonly userEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly scopes: readonly string[];
  /** The field of the answer of `userEndpoint` that is the stable id of the account. */
  readonly subjectField: string;
  /** The field that is a name for the account. */
  readonly nameField?: string | undefined;
  readonly clientAuth?: ClientAuth | undefined;
  /**
   * Who vouches for the accounts, as a text that stays the same for as long as the ids mean
   * the same accounts. Without it, the origin of `userEndpoint`: who answers there says
   * who signed in.
   */
  readonly realm?: string | undefined;
  readonly allowSignup?: boolean | undefined;
  readonly icon?: string | undefined;
}

/**
 * A login provider that is OAuth 2.0 without OpenID Connect: there is no ID token, so who
 * signed in is asked of the provider with the access token the code was redeemed for.
 *
 * That is sound for the authorization code flow and for it only: the code comes back to this
 * server through the browser that started the sign-in (the server checks `state`), is
 * redeemed by this server at the token endpoint over HTTPS with the client secret and the
 * PKCE verifier, and the access token never leaves this function. It is used for the one
 * request and then dropped.
 */
export function createOAuth2Provider(
  settings: OAuth2Settings,
  deps: { readonly fetch?: Fetch | undefined } = {},
): AuthProvider {
  const send = deps.fetch ?? fetch;
  const authorization = providerUrl(settings.authorizationEndpoint, 'The authorization endpoint');
  const token = providerUrl(settings.tokenEndpoint, 'The token endpoint');
  const user = providerUrl(settings.userEndpoint, 'The user endpoint');
  const { clientId, clientSecret } = settings;
  if (typeof clientId !== 'string' || clientId === '') {
    throw new Error(`The provider "${settings.id}" needs a client ID`);
  }
  const realm = settings.realm ?? user.origin;

  return {
    id: settings.id,
    name: settings.name,
    icon: settings.icon,
    allowSignup: settings.allowSignup === true,

    authorize({ state, codeChallenge, redirectUri }) {
      return authorizationUrl(authorization, {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: settings.scopes.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
    },

    async callback({ query, redirectUri, codeVerifier }) {
      const code = codeOf(query);
      const answer = await redeemCode(send, token, {
        code,
        redirectUri,
        codeVerifier,
        clientId,
        clientSecret: clientSecret === '' ? undefined : clientSecret,
        clientAuth: settings.clientAuth ?? 'post',
      });
      const { access_token: accessToken, token_type: tokenType } = answer;
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new Error('The token endpoint sent no access token');
      }
      if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
        throw new Error('The token endpoint sent a token that is no bearer token');
      }
      const { status, json } = await requestJson(
        send,
        user,
        { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
        'The user endpoint',
      );
      if (status !== 200 || !isRecord(json)) {
        throw new Error(`The user endpoint did not say who signed in (${status})`);
      }
      const id = json[settings.subjectField];
      // An id is a text or, with some providers, a whole number.
      const subject = typeof id === 'string' ? id : Number.isSafeInteger(id) ? String(id) : '';
      if (subject === '' || subject.length > MAX_SUBJECT_LENGTH) {
        throw new Error('The user endpoint named no usable id');
      }
      const called = settings.nameField === undefined ? undefined : json[settings.nameField];
      return {
        subject,
        name: typeof called === 'string' && called !== '' ? called : undefined,
        realm,
      };
    },
  };
}
