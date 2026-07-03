/**
 * Bitmask of actions that a permission can grant.
 */
export const Action = {
	NONE: 0,
	READ: 1 << 0,
	WRITE: 1 << 1,
} as const;

export type Action = (typeof Action)[keyof typeof Action];

/**
 * Entity id namespaces that are NOT granted by the global "*" wildcard.
 * Permissions for these must be granted explicitly (e.g. "users:*").
 * The superuser role bypasses this restriction entirely.
 */
const PROTECTED_NAMESPACES = ["users:"];

function matchesProtectedNamespace(entityId: string): boolean {
	return PROTECTED_NAMESPACES.some(
		(namespace) =>
			entityId.startsWith(namespace) || entityId === namespace.slice(0, -1),
	);
}

function permissionMatches(
	permissionEntityId: string,
	entityId: string,
): boolean {
	// Exact match always wins.
	if (permissionEntityId === entityId) {
		return true;
	}

	// The global wildcard matches everything except protected namespaces.
	if (permissionEntityId === "*") {
		return !matchesProtectedNamespace(entityId);
	}

	// Prefix wildcards such as "users:*" match "users:<anything>".
	if (permissionEntityId.endsWith(":*")) {
		const prefix = permissionEntityId.slice(0, -1);
		return entityId.startsWith(prefix);
	}

	return false;
}

/**
 * Checks whether the given user may perform `action` on the entity
 * identified by `entityId`.
 *
 * - Users with the "superuser" role are always allowed.
 * - Otherwise, at least one permission of one of the user's roles must
 *   match the entity id (exactly, via the global "*" wildcard, or via a
 *   prefix wildcard like "users:*") and include all requested action bits.
 * - The global "*" wildcard does not grant access to protected namespaces
 *   (currently "users:*", i.e. the user management API).
 */
interface PermissionLike {
	entityId: string;
	actions: number;
}

interface RoleLike {
	name: string;
	/**
	 * May be undefined when the relation was not loaded from the database.
	 */
	permissions?: PermissionLike[];
}

interface UserLike {
	/**
	 * May be undefined when the relation was not loaded from the database.
	 */
	roles?: RoleLike[];
}

export function hasPermission(
	user: UserLike,
	entityId: string,
	action: number,
): boolean {
	const roles = user.roles ?? [];
	if (roles.some((role) => role.name === "superuser")) {
		return true;
	}

	return roles.some((role) =>
		(role.permissions ?? []).some(
			(permission) =>
				(permission.actions & action) === action &&
				permissionMatches(permission.entityId, entityId),
		),
	);
}
