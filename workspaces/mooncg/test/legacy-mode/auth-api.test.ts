import socketIoClient from "socket.io-client";
import { expect } from "vitest";

import { generateTotpToken } from "../../src/server/util/totp";
import { setupTest } from "../helpers/setup";
import * as C from "../helpers/test-constants";

const test = await setupTest("mooncg-login.json");

interface ApiError {
	error: { code: string; message: string };
}

/**
 * Extracts a single cookie pair ("name=value") from a fetch response.
 */
function getCookie(res: Response, name: string): string | undefined {
	for (const setCookie of res.headers.getSetCookie()) {
		const pair = setCookie.split(";")[0];
		if (pair?.startsWith(`${name}=`)) {
			return pair;
		}
	}

	return undefined;
}

/**
 * Performs a local login via the same form POST the login page uses.
 * Returns the redirect location and (on success) the session cookie.
 */
async function loginLocal(
	username: string,
	password: string,
	totp?: string,
): Promise<{ location: string; cookie: string | undefined }> {
	const body = new URLSearchParams({ username, password });
	if (totp !== undefined) {
		body.set("totp", totp);
	}

	const res = await fetch(`${C.rootUrl()}login/local`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		redirect: "manual",
	});
	expect(res.status).toBe(302);
	return {
		location: res.headers.get("location") ?? "",
		cookie: getCookie(res, "connect.sid"),
	};
}

async function loginLocalOk(
	username: string,
	password: string,
	totp?: string,
): Promise<string> {
	const { location, cookie } = await loginLocal(username, password, totp);
	expect(location).toBe("/dashboard");
	if (!cookie) {
		throw new Error("expected a session cookie after successful login");
	}

	return cookie;
}

async function api(
	method: string,
	path: string,
	cookie: string,
	body?: unknown,
): Promise<Response> {
	return fetch(`${C.rootUrl()}api/v1${path}`, {
		method,
		headers: {
			cookie,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
	});
}

/**
 * Fetches the dashboard with a session cookie, which causes authCheck to
 * issue a socketToken cookie (the API key used for Socket.IO connections).
 */
async function getSocketToken(cookie: string): Promise<string> {
	const res = await fetch(C.dashboardUrl(), {
		headers: { cookie },
		redirect: "manual",
	});
	expect(res.status).toBe(200);
	const socketToken = getCookie(res, "socketToken");
	if (!socketToken) {
		throw new Error("expected a socketToken cookie on the dashboard response");
	}

	return socketToken.split("=")[1];
}

function connectSocket(
	token: string,
): Promise<ReturnType<typeof socketIoClient>> {
	const socket = socketIoClient(`${C.rootUrl()}?token=${token}`);
	return new Promise((resolve, reject) => {
		socket.once("connect", () => {
			resolve(socket);
		});
		socket.once("connect_error", (error: Error) => {
			reject(error);
		});
	});
}

test("exposes the current user and the seeded roles", async () => {
	const cookie = await loginLocalOk("admin", "password");

	const meRes = await api("GET", "/me", cookie);
	expect(meRes.status).toBe(200);
	const me = (await meRes.json()) as {
		name: string;
		roles: string[];
		totp_enabled: boolean;
		enabled: boolean;
	};
	expect(me.name).toBe("admin");
	expect(me.roles).toContain("superuser");
	expect(me.totp_enabled).toBe(false);
	expect(me.enabled).toBe(true);

	const rolesRes = await api("GET", "/roles", cookie);
	expect(rolesRes.status).toBe(200);
	const roles = (await rolesRes.json()) as { name: string }[];
	const roleNames = roles.map((role) => role.name);
	expect(roleNames).toEqual(
		expect.arrayContaining(["superuser", "admin", "operator", "viewer"]),
	);
});

test("rejects unauthenticated API requests", async () => {
	const res = await fetch(`${C.rootUrl()}api/v1/me`, { redirect: "manual" });
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe("/login");
});

test("admin can create, update, login as, and delete database users", async () => {
	const cookie = await loginLocalOk("admin", "password");

	// Invalid payloads are rejected.
	const missingPassword = await api("POST", "/users", cookie, {
		name: "no-password",
	});
	expect(missingPassword.status).toBe(400);
	expect(((await missingPassword.json()) as ApiError).error.code).toBe(
		"invalid_request",
	);

	const unknownRole = await api("POST", "/users", cookie, {
		name: "bad-role",
		password: "hunter22",
		roles: ["does-not-exist"],
	});
	expect(unknownRole.status).toBe(400);
	expect(((await unknownRole.json()) as ApiError).error.code).toBe(
		"unknown_role",
	);

	// Create a database-backed operator user.
	const createRes = await api("POST", "/users", cookie, {
		name: "db-operator",
		password: "hunter22",
		roles: ["operator"],
	});
	expect(createRes.status).toBe(201);
	const created = (await createRes.json()) as {
		id: string;
		name: string;
		roles: string[];
	};
	expect(created.name).toBe("db-operator");
	expect(created.roles).toEqual(["operator"]);

	// Duplicate names are rejected.
	const duplicate = await api("POST", "/users", cookie, {
		name: "db-operator",
		password: "hunter22",
	});
	expect(duplicate.status).toBe(409);

	// The new user shows up in the list.
	const listRes = await api("GET", "/users", cookie);
	expect(listRes.status).toBe(200);
	const users = (await listRes.json()) as { name: string }[];
	expect(users.map((user) => user.name)).toContain("db-operator");

	// The new user can log in...
	await loginLocalOk("db-operator", "hunter22");

	// ...but not with a wrong password.
	const badLogin = await loginLocal("db-operator", "wrong-password");
	expect(badLogin.location).toContain("/login");
	expect(badLogin.location).not.toBe("/dashboard");

	// Disabled users are rejected during login.
	const disableRes = await api("PATCH", `/users/${created.id}`, cookie, {
		enabled: false,
	});
	expect(disableRes.status).toBe(200);
	const disabledLogin = await loginLocal("db-operator", "hunter22");
	expect(disabledLogin.location).toContain("error=user_disabled");

	// Re-enable and change the password.
	const updateRes = await api("PATCH", `/users/${created.id}`, cookie, {
		enabled: true,
		password: "new-password",
	});
	expect(updateRes.status).toBe(200);
	const oldPasswordLogin = await loginLocal("db-operator", "hunter22");
	expect(oldPasswordLogin.location).not.toBe("/dashboard");
	await loginLocalOk("db-operator", "new-password");

	// Delete the user; their login stops working.
	const deleteTarget = await api("POST", "/users", cookie, {
		name: "db-doomed",
		password: "shortlived",
		roles: ["viewer"],
	});
	expect(deleteTarget.status).toBe(201);
	const doomed = (await deleteTarget.json()) as { id: string };
	const deleteRes = await api("DELETE", `/users/${doomed.id}`, cookie);
	expect(deleteRes.status).toBe(204);

	// A deleted database user falls back to the config user path, which
	// (like any unknown config user) leaves them without roles: they are
	// bounced by authCheck instead of getting access.
	const deletedLogin = await loginLocal("db-doomed", "shortlived");
	expect(deletedLogin.cookie).toBeDefined();
	const deletedMe = await api("GET", "/me", deletedLogin.cookie!);
	expect(deletedMe.status).toBe(302);
	expect(deletedMe.headers.get("location")).toBe("/login");
});

test("the last active admin cannot be deleted, disabled, or degraded", async () => {
	const cookie = await loginLocalOk("admin", "password");
	const me = (await (await api("GET", "/me", cookie)).json()) as { id: string };

	const deleteRes = await api("DELETE", `/users/${me.id}`, cookie);
	expect(deleteRes.status).toBe(409);
	expect(((await deleteRes.json()) as ApiError).error.code).toBe("last_admin");

	const degradeRes = await api("PATCH", `/users/${me.id}`, cookie, {
		roles: ["viewer"],
	});
	expect(degradeRes.status).toBe(409);

	const disableRes = await api("PATCH", `/users/${me.id}`, cookie, {
		enabled: false,
	});
	expect(disableRes.status).toBe(409);
});

test("viewer can read but write attempts are rejected in the ACK", async () => {
	const adminCookie = await loginLocalOk("admin", "password");
	const createRes = await api("POST", "/users", adminCookie, {
		name: "db-viewer",
		password: "viewer-password",
		roles: ["viewer"],
	});
	expect(createRes.status).toBe(201);

	// The dashboard is reachable for viewers.
	const viewerCookie = await loginLocalOk("db-viewer", "viewer-password");
	const token = await getSocketToken(viewerCookie);

	// Viewers must not access the user management API.
	const usersRes = await api("GET", "/users", viewerCookie);
	expect(usersRes.status).toBe(403);
	expect(((await usersRes.json()) as ApiError).error.code).toBe("forbidden");

	const socket = await connectSocket(token);
	try {
		// Declaring (subscribing to) a replicant works.
		const declared = await new Promise<{ revision: number }>(
			(resolve, reject) => {
				socket.emit(
					"replicant:declare",
					{
						name: "authWriteGuard",
						namespace: "test-bundle",
						opts: { defaultValue: "initial" },
					},
					(err: string | undefined, result: { revision: number }) => {
						if (err) {
							reject(new Error(err));
						} else {
							resolve(result);
						}
					},
				);
			},
		);

		// Proposing operations is rejected via the ACK; the socket stays connected.
		const proposeError = await new Promise<unknown>((resolve) => {
			socket.emit(
				"replicant:proposeOperations",
				{
					name: "authWriteGuard",
					namespace: "test-bundle",
					operations: [
						{ path: "/", method: "overwrite", args: { newValue: "hacked" } },
					],
					opts: { defaultValue: "initial" },
					revision: declared.revision,
				},
				(err: unknown) => {
					resolve(err);
				},
			);
		});
		expect(proposeError).toBe(
			"Unauthorized: modifying replicants requires WRITE permission",
		);
		expect(socket.connected).toBe(true);

		// Sending messages is also rejected via the ACK.
		const messageError = await new Promise<unknown>((resolve) => {
			socket.emit(
				"message",
				{
					messageName: "some-message",
					bundleName: "test-bundle",
					content: "hi",
				},
				(err: unknown) => {
					resolve(err);
				},
			);
		});
		expect(messageError).toBe(
			"Unauthorized: sending messages requires WRITE permission",
		);
		expect(socket.connected).toBe(true);

		// Reads still work, and the rejected write did not change the value.
		const readValue = await new Promise<unknown>((resolve, reject) => {
			socket.emit(
				"replicant:read",
				{ name: "authWriteGuard", namespace: "test-bundle" },
				(err: string | undefined, value: unknown) => {
					if (err) {
						reject(new Error(err));
					} else {
						resolve(value);
					}
				},
			);
		});
		expect(readValue).toBe("initial");
	} finally {
		socket.removeAllListeners();
		socket.close();
	}
});

test("2FA can be enrolled, is enforced at login, and can be reset", async () => {
	const adminCookie = await loginLocalOk("admin", "password");
	const createRes = await api("POST", "/users", adminCookie, {
		name: "db-totp",
		password: "totp-password",
		roles: ["operator"],
	});
	expect(createRes.status).toBe(201);
	const created = (await createRes.json()) as { id: string };

	const cookie = await loginLocalOk("db-totp", "totp-password");

	// Enroll: returns the secret and an otpauth:// URL.
	const enrollRes = await api("POST", "/me/2fa/enroll", cookie);
	expect(enrollRes.status).toBe(200);
	const enrollment = (await enrollRes.json()) as {
		secret: string;
		otpauthUrl: string;
	};
	expect(enrollment.otpauthUrl).toContain("otpauth://totp/");

	// A wrong token does not activate 2FA.
	const badVerify = await api("POST", "/me/2fa/verify", cookie, {
		token: "000000",
	});
	expect(badVerify.status).toBe(400);
	expect(((await badVerify.json()) as ApiError).error.code).toBe(
		"totp_invalid",
	);

	// A valid token activates 2FA.
	const goodVerify = await api("POST", "/me/2fa/verify", cookie, {
		token: generateTotpToken(enrollment.secret),
	});
	expect(goodVerify.status).toBe(200);
	const verified = (await goodVerify.json()) as { totp_enabled: boolean };
	expect(verified.totp_enabled).toBe(true);

	// Login without a TOTP token now fails with totp_required.
	const noTotp = await loginLocal("db-totp", "totp-password");
	expect(noTotp.location).toContain("error=totp_required");

	// Login with a wrong TOTP token fails with totp_invalid.
	const wrongTotp = await loginLocal("db-totp", "totp-password", "000000");
	expect(wrongTotp.location).toContain("error=totp_invalid");

	// Login with a valid TOTP token works.
	await loginLocalOk(
		"db-totp",
		"totp-password",
		generateTotpToken(enrollment.secret),
	);

	// An admin can reset 2FA, after which plain logins work again.
	const resetRes = await api(
		"POST",
		`/users/${created.id}/2fa/reset`,
		adminCookie,
	);
	expect(resetRes.status).toBe(204);
	await loginLocalOk("db-totp", "totp-password");
});

test("sessions can be listed and individually revoked", async () => {
	const adminCookie = await loginLocalOk("admin", "password");
	const createRes = await api("POST", "/users", adminCookie, {
		name: "db-sessions",
		password: "sessions-password",
		roles: ["operator"],
	});
	expect(createRes.status).toBe(201);

	// Two independent logins => two active sessions.
	const cookieA = await loginLocalOk("db-sessions", "sessions-password");
	const cookieB = await loginLocalOk("db-sessions", "sessions-password");

	interface SessionInfo {
		id: string;
		current: boolean;
		createdAt?: number;
		userAgent?: string;
	}

	const listRes = await api("GET", "/me/sessions", cookieA);
	expect(listRes.status).toBe(200);
	const sessions = (await listRes.json()) as SessionInfo[];
	expect(sessions.length).toBeGreaterThanOrEqual(2);
	const currentA = sessions.find((session) => session.current);
	expect(currentA).toBeDefined();
	expect(typeof currentA?.createdAt).toBe("number");

	const listResB = await api("GET", "/me/sessions", cookieB);
	const sessionsB = (await listResB.json()) as SessionInfo[];
	const currentB = sessionsB.find((session) => session.current);
	expect(currentB).toBeDefined();
	expect(currentB!.id).not.toBe(currentA!.id);

	// Session A revokes session B.
	const revokeRes = await api(
		"DELETE",
		`/me/sessions/${currentB!.id}`,
		cookieA,
	);
	expect(revokeRes.status).toBe(204);

	// The revoked session is logged out...
	const meB = await api("GET", "/me", cookieB);
	expect(meB.status).toBe(302);
	expect(meB.headers.get("location")).toBe("/login");

	// ...while the revoking session keeps working.
	const meA = await api("GET", "/me", cookieA);
	expect(meA.status).toBe(200);

	// Sessions of other users cannot be revoked through /me.
	const adminSessions = (await (
		await api("GET", "/me/sessions", adminCookie)
	).json()) as SessionInfo[];
	const adminSession = adminSessions.find((session) => session.current);
	const crossRevoke = await api(
		"DELETE",
		`/me/sessions/${adminSession!.id}`,
		cookieA,
	);
	expect(crossRevoke.status).toBe(404);

	// Admins can list and revoke sessions of other users.
	const usersRes = await api("GET", "/users", adminCookie);
	const users = (await usersRes.json()) as { id: string; name: string }[];
	const sessionUser = users.find((user) => user.name === "db-sessions");
	expect(sessionUser).toBeDefined();
	const adminListRes = await api(
		"GET",
		`/users/${sessionUser!.id}/sessions`,
		adminCookie,
	);
	expect(adminListRes.status).toBe(200);
	const adminSeenSessions = (await adminListRes.json()) as SessionInfo[];
	expect(adminSeenSessions.some((session) => session.id === currentA!.id)).toBe(
		true,
	);

	const adminRevoke = await api(
		"DELETE",
		`/users/${sessionUser!.id}/sessions/${currentA!.id}`,
		adminCookie,
	);
	expect(adminRevoke.status).toBe(204);
	const meAAfter = await api("GET", "/me", cookieA);
	expect(meAAfter.status).toBe(302);
});
