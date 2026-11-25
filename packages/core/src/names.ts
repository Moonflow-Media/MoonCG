/** Bundle names: lowercase letters, digits and single dashes. They appear in URLs and permissions. */
export const BUNDLE_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Separates the bundle namespace from a replicant name, as in `scoreboard:score`. */
export const NAMESPACE_SEPARATOR = ':';

/**
 * Whether a name is one Windows reserves for a device, in any case: `con`, `nul`, `com1` and
 * the like. No folder can have such a name there, so no bundle has it anywhere: a bundle
 * that installs on one machine installs on every other.
 */
export function isReservedDeviceName(name: string): boolean {
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name);
}
