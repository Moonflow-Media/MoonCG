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

/** The sections of the generic provider, and so its ids: a fixed few named slots. */
export const OIDC_SLOTS = ['oidc', 'oidc2', 'oidc3'] as const;

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
 * External logins: up to three generic OpenID Connect providers and the presets for Twitch
 * and Discord. Each is a section of the configuration and registers a login provider when it is
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

  // The generic provider in up to three slots, each a section of its own with its own
  // secret. `oidc` is the first, as it always was; links name the slot they were made for.
  const generic = OIDC_SLOTS.map((id, index) => ({ id, index, values: section(ctx.config, id) }));
  for (const { id, index, values } of generic) {
    if (!values.enabled) continue;
    const label = index === 0 ? 'OpenID Connect' : `OpenID Connect ${index + 1}`;
    need(label, values);
    const scopes = Array.isArray(values.values.scopes)
      ? values.values.scopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined;
    ctx.auth.registerProvider(
      createOidcProvider({
        id,
        name:
          text(values.values.name) ||
          (index === 0 ? 'Single sign-on' : `Single sign-on ${index + 1}`),
        issuer: text(values.values.issuer),
        scopes,
        icon: ICON,
        ...credentials(values),
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

  const on = [...generic.map(({ values }) => values), twitchSection, discordSection].filter(
    ({ enabled }) => enabled,
  ).length;
  if (on === 0) {
    ctx.logger.info('No provider is enabled. Turn one on in the settings of this module.');
  }
});
