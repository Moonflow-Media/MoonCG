import type { OAuth2Settings } from './oauth2.js';
import type { OidcSettings } from './oidc.js';

/** What an administrator sets for a preset; everything else is fixed here. */
export interface PresetCredentials {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly allowSignup?: boolean | undefined;
}

/** The icon every provider of this module is shown with. No logo of a provider is shipped. */
export const ICON = 'icons/account.svg';

/**
 * Twitch speaks OpenID Connect. Its token endpoint takes the client secret in the form, and
 * a name is only in the ID token when the `claims` parameter asks for it. The subject is
 * the numeric id of the Twitch user, which stays the same when the login name changes. The
 * realm of its accounts is its issuer, as for every OpenID Connect provider.
 *
 * As documented at https://dev.twitch.tv/docs/authentication/getting-tokens-oidc/ in
 * November 2026.
 */
export const twitch = (credentials: PresetCredentials): OidcSettings => ({
  id: 'twitch',
  name: 'Twitch',
  issuer: 'https://id.twitch.tv/oauth2',
  scopes: ['openid'],
  claims: { id_token: { preferred_username: null } },
  clientAuth: 'post',
  icon: ICON,
  ...credentials,
});

/**
 * Discord is OAuth 2.0 without an ID token: who signed in is asked at `/users/@me`, which
 * the scope `identify` allows and which answers without an e-mail address. The subject is
 * the id of the Discord user (a snowflake), not the user name, which can change.
 *
 * As documented at https://docs.discord.com/developers/topics/oauth2 in November 2026.
 */
export const discord = (credentials: PresetCredentials): OAuth2Settings => ({
  id: 'discord',
  name: 'Discord',
  authorizationEndpoint: 'https://discord.com/oauth2/authorize',
  tokenEndpoint: 'https://discord.com/api/oauth2/token',
  userEndpoint: 'https://discord.com/api/users/@me',
  scopes: ['identify'],
  subjectField: 'id',
  nameField: 'username',
  // Discord is one service, whatever addresses it is reached at.
  realm: 'https://discord.com',
  clientAuth: 'post',
  icon: ICON,
  ...credentials,
});
