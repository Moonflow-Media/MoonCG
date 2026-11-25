import { defineModule } from '@mooncg/sdk/module';
import { isRecord } from './http.js';
import { createOAuth2Provider } from './oauth2.js';
import { createOidcProvider } from './oidc.js';
import { discord, ICON, twitch } from './presets.js';

/** One section of the configuration: a provider that is on or off. */
interface Section {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly allowSignup: boolean;
  readonly values: Readonly<Record<string, unknown>>;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function section(config: Readonly<Record<string, unknown>>, name: string): Section {
  const values = isRecord(config[name]) ? config[name] : {};
  const secret = typeof values.clientSecret === 'string' ? values.clientSecret : '';
  return {
    enabled: values.enabled === true,
    clientId: text(values.clientId),
    clientSecret: secret === '' ? undefined : secret,
    allowSignup: values.allowSignup === true,
    values,
  };
}

/**
 * External logins: one generic OpenID Connect provider and the presets for Twitch and
 * Discord. Each is a section of the configuration and registers a login provider when it is
 * enabled. A section that is enabled but cannot work, such as one without a client ID or
 * with an issuer that is not `https://`, fails the module with the reason, so that it shows
 * on the Modules page instead of as a button that leads nowhere.
 */
export default defineModule((ctx) => {
  const credentials = ({ clientId, clientSecret, allowSignup }: Section) => ({
    clientId,
    clientSecret,
    allowSignup,
  });
  const need = (name: string, { clientId }: Section) => {
    if (clientId === '') throw new Error(`${name} is enabled but has no client ID`);
  };

  const oidc = section(ctx.config, 'oidc');
  if (oidc.enabled) {
    need('OpenID Connect', oidc);
    const scopes = Array.isArray(oidc.values.scopes)
      ? oidc.values.scopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined;
    ctx.auth.registerProvider(
      createOidcProvider({
        id: 'oidc',
        name: text(oidc.values.name) || 'Single sign-on',
        issuer: text(oidc.values.issuer),
        scopes,
        icon: ICON,
        ...credentials(oidc),
      }),
    );
  }

  const twitchSection = section(ctx.config, 'twitch');
  if (twitchSection.enabled) {
    need('Twitch', twitchSection);
    ctx.auth.registerProvider(createOidcProvider(twitch(credentials(twitchSection))));
  }

  const discordSection = section(ctx.config, 'discord');
  if (discordSection.enabled) {
    need('Discord', discordSection);
    ctx.auth.registerProvider(createOAuth2Provider(discord(credentials(discordSection))));
  }

  const on = [oidc, twitchSection, discordSection].filter(({ enabled }) => enabled).length;
  if (on === 0) {
    ctx.logger.info('No provider is enabled. Turn one on in the settings of this module.');
  }
});
