/** Whoever is acting: a user, an API token, the server itself. Roles carry the grants. */
export interface Principal {
  readonly id: string;
  readonly roles: readonly string[];
}

/** Maps each role to the permission patterns it grants. */
export interface Policy {
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

/** Until real authentication exists, every request acts as this principal. */
export const ALLOW_ALL_PRINCIPAL: Principal = { id: 'local', roles: ['admin'] };
export const ALLOW_ALL_POLICY: Policy = { roles: { admin: ['*'] } };

/**
 * Server-side extensions are trusted code, but they still pass through `authorize()` so there
 * is one enforcement path. They act as this principal, checked against this policy.
 */
export const TRUSTED_EXTENSION_ROLE = 'trusted-extension';
export const TRUSTED_EXTENSION_POLICY: Policy = { roles: { [TRUSTED_EXTENSION_ROLE]: ['*'] } };

export function extensionPrincipal(bundle: string): Principal {
  return { id: `extension:${bundle}`, roles: [TRUSTED_EXTENSION_ROLE] };
}

/** Required to load the shell, the SDK, the bundle list and to open a socket. */
export const DASHBOARD_VIEW = 'system:dashboard.view';

/** The permission a bundle resource requires when its manifest maps it to none. */
export const IMPLICIT_BUNDLE_PERMISSION = 'access';

/** Builds `bundle:<bundle>:<permission>` from a permission name declared in a manifest. */
export function bundlePermission(bundle: string, permission: string | undefined): string {
  return `bundle:${bundle}:${permission ?? IMPLICIT_BUNDLE_PERMISSION}`;
}

/**
 * The single permission check. A grant matches when it is `*`, or when it has the same number
 * of `:`-separated segments as the permission and each one is equal or `*`.
 */
export function authorize(principal: Principal, permission: string, policy: Policy): boolean {
  const wanted = permission.split(':');
  return principal.roles.some((role) =>
    (policy.roles[role] ?? []).some((grant) => grantMatches(grant, wanted)),
  );
}

export function grantMatches(grant: string, wanted: readonly string[]): boolean {
  if (grant === '*') return true;
  const segments = grant.split(':');
  return (
    segments.length === wanted.length &&
    segments.every((segment, index) => segment === '*' || segment === wanted[index])
  );
}

/** Required to enable, disable and reload bundles. */
export const BUNDLES_MANAGE = 'system:bundles.manage';

/** The namespace of what the server itself provides, such as the `system:bundles` replicant. */
export const SYSTEM_BUNDLE = 'system';
