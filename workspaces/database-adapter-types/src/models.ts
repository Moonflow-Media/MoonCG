export interface User {
	id: string;
	created_at: number;
	name: string;
	/**
	 * Whether this user is allowed to log in.
	 * Disabled users are rejected during authentication.
	 */
	enabled: boolean;
	/**
	 * Base32-encoded TOTP secret. Only set once a user has started
	 * (or completed) TOTP enrollment.
	 */
	totp_secret: string | null;
	/**
	 * Whether TOTP two-factor authentication is enforced for this user.
	 */
	totp_enabled: boolean;
	roles: Role[];
	identities: Identity[];
	apiKeys: ApiKey[];
}

export interface Role {
	id: string;
	name: string;
	permissions: Permission[];
}

export interface Identity {
	id: string;
	provider_type: "twitch" | "steam" | "local" | "discord";
	provider_hash: string;
	/**
	 * Password hash (scrypt) for provider_type "local" database users.
	 * Identities created through the static config login flow leave this null.
	 */
	provider_secret: string | null;
	provider_access_token: string | null;
	provider_refresh_token: string | null;
	user: User;
}

export interface ApiKey {
	secret_key: string;
	user: User;
}

export interface Permission {
	id: string;
	name: string;
	role: Role;
	entityId: string;
	actions: number;
}

export interface Replicant {
	namespace: string;
	name: string;
	value: string;
}

export interface Session {
	id: string;
	/**
	 * Unix timestamp (in milliseconds) at which this session expires.
	 */
	expiredAt: number;
	/**
	 * The serialized express-session JSON payload.
	 */
	json: string;
	/**
	 * The id of the user this session belongs to.
	 * Null for sessions that are not (yet) associated with a login.
	 */
	user_id: string | null;
}
