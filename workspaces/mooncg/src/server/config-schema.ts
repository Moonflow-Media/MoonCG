import { mooncgConfigSchema } from "../types/mooncg-config-schema.js";

export { mooncgConfigSchema };
export type { MoonCGConfig } from "../types/mooncg-config-schema.js";

/**
 * Builds a complete default MoonCG config from the config schema.
 *
 * The optional feature blocks (login.steam, login.twitch, login.discord,
 * login.local) have no default of their own, so they are seeded with empty
 * objects to populate their nested defaults as well. This makes those blocks
 * explicit (with `enabled: false`) where a missing config file would leave
 * them undefined — behaviorally equivalent while the features stay disabled,
 * but not byte-for-byte identical to the no-config-file case.
 *
 * `baseURL` is omitted from the result because it has no static default —
 * it is derived from `host` and `port` at runtime.
 */
export function getDefaultMooncgConfig() {
	const { baseURL, ...defaults } = mooncgConfigSchema.parse({
		login: {
			steam: {},
			twitch: {},
			discord: {},
			local: {},
		},
	});
	return defaults;
}
