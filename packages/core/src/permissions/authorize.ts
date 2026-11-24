import { BUNDLE_NAME_PATTERN } from '../names.js';

/** What a principal is: a signed-in person, an API token, a bundle's extension, or nobody. */
export type PrincipalKind = 'user' | 'token' | 'extension' | 'anonymous';
export const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  'user',
  'token',
  'extension',
  'anonymous',
];

/** Whoever is acting. Roles carry the grants. */
export interface Principal {
  /** `user:<id>`, `token:<id>`, `extension:<bundle>` or `anonymous`. */
  readonly id: string;
  /** A principal without a kind counts as a user. */
  readonly kind?: PrincipalKind | undefined;
  readonly roles: readonly string[];
  /**
   * Limits the principal to what these grants cover, on top of what its roles grant. An API
   * token carries the roles of its creator and its own grants here, so it holds a permission
   * only while both do.
   */
  readonly only?: readonly string[] | undefined;
}

/** Maps each role to the permission patterns it grants. */
export interface Policy {
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

/** A principal and policy that allow everything. For tests and tools; the server never defaults to them. */
export const ALLOW_ALL_PRINCIPAL: Principal = { id: 'local', kind: 'user', roles: ['admin'] };
export const ALLOW_ALL_POLICY: Policy = { roles: { admin: ['*'] } };

/** Who a request without valid credentials acts as. It holds nothing. */
export const ANONYMOUS_PRINCIPAL: Principal = { id: 'anonymous', kind: 'anonymous', roles: [] };

/**
 * Server-side extensions are trusted code, but they still pass through `authorize()` so there
 * is one enforcement path. They act as this principal, checked against this policy.
 */
export const TRUSTED_EXTENSION_ROLE = 'trusted-extension';
export const TRUSTED_EXTENSION_POLICY: Policy = { roles: { [TRUSTED_EXTENSION_ROLE]: ['*'] } };

export function extensionPrincipal(bundle: string): Principal {
  return { id: `extension:${bundle}`, kind: 'extension', roles: [TRUSTED_EXTENSION_ROLE] };
}

/** Required to load the shell and the bundle list, and to follow the server's own replicants. */
export const DASHBOARD_VIEW = 'system:dashboard.view';
/** Required to enable, disable and reload bundles, and to see the state of every bundle. */
export const BUNDLES_MANAGE = 'system:bundles.manage';
/** Required to manage users, roles and grants. Whoever holds it can make anyone an admin. */
export const USERS_MANAGE = 'system:users.manage';
/** Required to create, list and revoke API tokens. */
export const TOKENS_MANAGE = 'system:tokens.manage';
/** Reserved for server settings. */
export const SETTINGS_MANAGE = 'system:settings.manage';
/** Reserved for reading the server log. */
export const LOGS_VIEW = 'system:logs.view';

/** The namespace of what the server itself provides, such as the `system:bundles` replicant. */
export const SYSTEM_BUNDLE = 'system';

/**
 * Stands for "any permission of this bundle". A bundle resource whose manifest entry names no
 * permission requires it: whoever holds at least one permission of the bundle may use the
 * resource. It can be required but never granted.
 */
export const ANY_BUNDLE_PERMISSION = '?';

/** Builds `bundle:<bundle>:<permission>` from a permission name declared in a manifest. */
export function bundlePermission(bundle: string, permission: string | undefined): string {
  return `bundle:${bundle}:${permission ?? ANY_BUNDLE_PERMISSION}`;
}

const GRANT_SEGMENT = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/** Whether a text is something a role or token can be granted: a permission or a wildcard. */
export function isGrantPattern(text: string): boolean {
  if (text === '*') return true;
  const segments = text.split(':');
  const part = (segment: string | undefined) =>
    segment !== undefined && (segment === '*' || GRANT_SEGMENT.test(segment));
  if (segments[0] === 'system') return segments.length === 2 && part(segments[1]);
  if (segments[0] !== 'bundle' || segments.length !== 3) return false;
  const name = segments[1] as string;
  return (name === '*' || BUNDLE_NAME_PATTERN.test(name)) && part(segments[2]);
}

/**
 * The single permission check. A grant matches when it is `*`, or when it has the same number
 * of `:`-separated segments as the permission and each one is equal or `*`. The principal
 * holds the permission when a grant of one of its roles matches and, if it is limited by
 * `only`, one of those grants matches as well.
 */
export function authorize(principal: Principal, permission: string, policy: Policy): boolean {
  const wanted = permission.split(':');
  const held = principal.roles.flatMap((role) => policy.roles[role] ?? []);
  const { only } = principal;
  if (wanted.length === 3 && wanted[0] === 'bundle' && wanted[2] === ANY_BUNDLE_PERMISSION) {
    const bundle = wanted[1] as string;
    const fromRoles = bundleGrants(held, bundle);
    if (only === undefined) return fromRoles.length > 0;
    const fromOnly = bundleGrants(only, bundle);
    // Some single permission of the bundle must be held on both sides.
    return fromRoles.some((a) => fromOnly.some((b) => a === '*' || b === '*' || a === b));
  }
  const matches = (grant: string) => grantMatches(grant, wanted);
  return held.some(matches) && (only === undefined || only.some(matches));
}

/** The permission names of one bundle that the grants cover; `*` stands for all of them. */
function bundleGrants(grants: readonly string[], bundle: string): string[] {
  const names: string[] = [];
  for (const grant of grants) {
    if (grant === '*') {
      names.push('*');
      continue;
    }
    const [kind, target, name, ...rest] = grant.split(':');
    if (kind !== 'bundle' || name === undefined || rest.length > 0) continue;
    if ((target === '*' || target === bundle) && name !== ANY_BUNDLE_PERMISSION) names.push(name);
  }
  return names;
}

export function grantMatches(grant: string, wanted: readonly string[]): boolean {
  if (grant === '*') return true;
  const segments = grant.split(':');
  return (
    segments.length === wanted.length &&
    segments.every((segment, index) => segment === '*' || segment === wanted[index])
  );
}

/** What `effectiveGrants` answers: the grants of the roles and, for a limited principal, its own. */
export interface EffectiveGrants {
  readonly grants: readonly string[];
  readonly only?: readonly string[];
}

/**
 * Everything a principal holds right now, sorted and without duplicates. Two results that are
 * equal as JSON mean the same access, which is how a change of access is noticed.
 */
export function effectiveGrants(principal: Principal, policy: Policy): EffectiveGrants {
  const sorted = (grants: readonly string[]) => [...new Set(grants)].sort();
  const grants = sorted(principal.roles.flatMap((role) => policy.roles[role] ?? []));
  return principal.only === undefined ? { grants } : { grants, only: sorted(principal.only) };
}

/**
 * Whether one of the grants covers the permission, by the same rule as `authorize()`. For
 * code that has a list of grants and no principal, such as a page that decides what to show.
 */
export function grantsCover(grants: readonly string[], permission: string): boolean {
  const wanted = permission.split(':');
  return grants.some((grant) => grantMatches(grant, wanted));
}
