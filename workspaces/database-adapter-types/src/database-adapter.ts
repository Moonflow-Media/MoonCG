import type {
	ApiKey,
	Identity,
	Replicant,
	Role,
	Session,
	User,
} from "./models.ts";

type MaybePromise<T> = T | Promise<T>;

export interface DatabaseAdapter {
	findUser: (id: User["id"]) => MaybePromise<User | null>;
	getSuperUserRole: () => MaybePromise<Role>;
	upsertUser: (user: {
		name: User["name"];
		provider_type: Identity["provider_type"];
		provider_hash: Identity["provider_hash"];
		provider_access_token?: Identity["provider_access_token"];
		provider_refresh_token?: Identity["provider_refresh_token"];
		roles: User["roles"];
	}) => MaybePromise<User>;
	isSuperUser: (user: User) => boolean;

	/**
	 * Checks whether `user` may perform `action` (bitmask, see `Action`)
	 * on the entity identified by `entityId`. Supports wildcard matching
	 * ("*", exact match, prefix wildcards like "users:*").
	 */
	hasPermission: (user: User, entityId: string, action: number) => boolean;

	findRole: (name: Role["name"]) => MaybePromise<Role | null>;
	listRoles: () => MaybePromise<Role[]>;

	listUsers: () => MaybePromise<User[]>;
	/**
	 * Finds the "local" identity whose provider_hash equals the given username.
	 * Includes the associated user (with roles).
	 */
	findLocalIdentByUsername: (username: string) => MaybePromise<Identity | null>;
	/**
	 * Creates a database-backed local user with a hashed password
	 * (stored on the local identity's provider_secret).
	 */
	createLocalUser: (user: {
		name: User["name"];
		passwordHash: string;
		roles: User["roles"];
		enabled?: User["enabled"];
	}) => MaybePromise<User>;
	/**
	 * Applies a partial update to a user (and, where applicable,
	 * to their local identity). Returns the updated user, or null
	 * if no user with the given id exists.
	 */
	updateLocalUser: (
		userId: User["id"],
		update: {
			name?: User["name"];
			passwordHash?: string;
			roles?: User["roles"];
			enabled?: User["enabled"];
			totp_secret?: User["totp_secret"];
			totp_enabled?: User["totp_enabled"];
		},
	) => MaybePromise<User | null>;
	/**
	 * Deletes a user along with their identities, api keys and sessions.
	 * Returns false if no user with the given id exists.
	 */
	deleteUser: (userId: User["id"]) => MaybePromise<boolean>;

	getSession: (id: Session["id"]) => MaybePromise<Session | null>;
	setSession: (session: Session) => MaybePromise<void>;
	touchSession: (
		id: Session["id"],
		expiredAt: Session["expiredAt"],
	) => MaybePromise<void>;
	destroySessionById: (id: Session["id"]) => MaybePromise<void>;
	listSessionsByUser: (userId: User["id"]) => MaybePromise<Session[]>;

	createApiKey: () => MaybePromise<ApiKey>;
	findApiKey: (token: string) => MaybePromise<ApiKey | null>;
	saveUser: (user: User) => MaybePromise<void>;
	deleteSecretKey: (token: string) => MaybePromise<void>;
	saveReplicant: (replicant: {
		namespace: string;
		name: string;
		value: any;
		on: (event: "change", handler: (newVal: unknown) => void) => void;
		off: (event: "change", handler: (newVal: unknown) => void) => void;
	}) => Promise<void>;
	getAllReplicants: () => MaybePromise<Replicant[]>;
}
