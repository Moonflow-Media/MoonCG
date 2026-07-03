/**
 * Typed client for the auth REST API (`/api/v1`).
 *
 * All requests are cookie-authenticated (same as the assets endpoints),
 * and errors follow the `{ error: { code, message } }` format.
 */

export interface ApiUser {
	id: string;
	name: string;
	created_at: number;
	enabled: boolean;
	totp_enabled: boolean;
	roles: string[];
}

export interface ApiMe extends ApiUser {
	canManageUsers: boolean;
}

export interface ApiRole {
	id: string;
	name: string;
	permissions: { entityId: string; actions: number }[];
}

export interface ApiSession {
	id: string;
	expiredAt: number;
	createdAt?: number;
	ip?: string;
	userAgent?: string;
	current: boolean;
}

export interface TotpEnrollment {
	secret: string;
	otpauthUrl: string;
}

export class ApiRequestError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiRequestError";
		this.code = code;
		this.status = status;
	}
}

async function requestRaw(
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const response = await fetch(`/api/v1${path}`, {
		method,
		credentials: "include",
		headers:
			body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	if (!response.ok) {
		let code = "unknown";
		let message = `HTTP ${response.status}`;
		try {
			const data = (await response.json()) as {
				error?: { code?: string; message?: string };
			};
			code = data.error?.code ?? code;
			message = data.error?.message ?? message;
		} catch {
			// Non-JSON error response (e.g. a login redirect); keep the fallback.
		}

		throw new ApiRequestError(response.status, code, message);
	}

	return response;
}

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await requestRaw(method, path, body);
	return (await response.json()) as T;
}

async function requestVoid(
	method: string,
	path: string,
	body?: unknown,
): Promise<void> {
	await requestRaw(method, path, body);
}

export const authApi = {
	getMe: () => request<ApiMe>("GET", "/me"),
	listRoles: () => request<ApiRole[]>("GET", "/roles"),

	listUsers: () => request<ApiUser[]>("GET", "/users"),
	createUser: (data: {
		name: string;
		password: string;
		roles: string[];
		enabled?: boolean;
	}) => request<ApiUser>("POST", "/users", data),
	updateUser: (
		id: string,
		data: {
			name?: string;
			password?: string;
			roles?: string[];
			enabled?: boolean;
		},
	) => request<ApiUser>("PATCH", `/users/${encodeURIComponent(id)}`, data),
	deleteUser: (id: string) =>
		requestVoid("DELETE", `/users/${encodeURIComponent(id)}`),
	resetUserTotp: (id: string) =>
		requestVoid("POST", `/users/${encodeURIComponent(id)}/2fa/reset`),
	listUserSessions: (id: string) =>
		request<ApiSession[]>("GET", `/users/${encodeURIComponent(id)}/sessions`),
	revokeUserSession: (id: string, sessionId: string) =>
		requestVoid(
			"DELETE",
			`/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
		),

	listMySessions: () => request<ApiSession[]>("GET", "/me/sessions"),
	revokeMySession: (sessionId: string) =>
		requestVoid("DELETE", `/me/sessions/${encodeURIComponent(sessionId)}`),
	enrollTotp: () => request<TotpEnrollment>("POST", "/me/2fa/enroll"),
	verifyTotp: (token: string) =>
		request<ApiUser>("POST", "/me/2fa/verify", { token }),
	disableTotp: (token: string) =>
		request<ApiUser>("DELETE", "/me/2fa", { token }),
};

/**
 * Formats an unknown error (usually an ApiRequestError) for display in a toast.
 */
export function formatApiError(error: unknown): string {
	if (error instanceof ApiRequestError) {
		return error.message;
	}

	return error instanceof Error ? error.message : String(error);
}
