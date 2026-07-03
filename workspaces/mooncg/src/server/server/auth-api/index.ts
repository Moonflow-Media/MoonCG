import type {
	DatabaseAdapter,
	Role,
	Session,
	User,
} from "@mooncg/database-adapter-types";
import { Action } from "@mooncg/database-adapter-types";
import express from "express";

import type { RootNS } from "../../../types/socket-protocol";
import { UnAuthErrCode } from "../../../types/socket-protocol";
import { createLogger } from "../../logger";
import { hashPassword } from "../../util/password";
import {
	buildOtpauthUrl,
	generateTotpSecret,
	verifyTotpToken,
} from "../../util/totp";

const log = createLogger("auth-api");

interface SessionMeta {
	createdAt?: number;
	ip?: string;
	userAgent?: string;
}

function sendError(
	res: express.Response,
	status: number,
	code: string,
	message: string,
): void {
	res.status(status).json({ error: { code, message } });
}

function serializeUser(user: User) {
	return {
		id: user.id,
		name: user.name,
		created_at: user.created_at,
		enabled: user.enabled !== false,
		totp_enabled: user.totp_enabled === true,
		roles: (user.roles ?? []).map((role) => role.name),
	};
}

function serializeRole(role: Role) {
	return {
		id: role.id,
		name: role.name,
		permissions: (role.permissions ?? []).map((permission) => ({
			entityId: permission.entityId,
			actions: permission.actions,
		})),
	};
}

function parseSessionMeta(session: Session): SessionMeta {
	try {
		const data: unknown = JSON.parse(session.json);
		const meta = bodyProperty(data, "meta");
		if (typeof meta === "object" && meta !== null) {
			const createdAt = bodyProperty(meta, "createdAt");
			const ip = bodyProperty(meta, "ip");
			const userAgent = bodyProperty(meta, "userAgent");
			return {
				createdAt: typeof createdAt === "number" ? createdAt : undefined,
				ip: typeof ip === "string" ? ip : undefined,
				userAgent: typeof userAgent === "string" ? userAgent : undefined,
			};
		}
	} catch {
		// Malformed session JSON; treat as having no metadata.
	}

	return {};
}

function serializeSession(session: Session, currentSessionId: string | null) {
	const meta = parseSessionMeta(session);
	return {
		id: session.id,
		expiredAt: session.expiredAt,
		createdAt: meta.createdAt,
		ip: meta.ip,
		userAgent: meta.userAgent,
		current: currentSessionId !== null && session.id === currentSessionId,
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function bodyProperty(body: unknown, key: string): unknown {
	if (typeof body === "object" && body !== null) {
		const value: unknown = Reflect.get(body, key);
		return value;
	}

	return undefined;
}

function isAdminLike(user: User): boolean {
	return (user.roles ?? []).some(
		(role) => role.name === "superuser" || role.name === "admin",
	);
}

export function createAuthApiRouter(
	db: DatabaseAdapter,
	io: RootNS,
): express.Router {
	const router = express.Router();

	/**
	 * Disconnects all sockets that belong to the given session,
	 * notifying them with a protocol error first.
	 */
	async function disconnectSessionSockets(sessionId: string): Promise<void> {
		const sockets = await io.fetchSockets();
		for (const socket of sockets) {
			if (socket.data.sessionId !== sessionId) {
				continue;
			}

			socket.emit("protocol_error", {
				message: "Your session has been terminated",
				code: UnAuthErrCode.InvalidSession,
				type: "UnauthorizedError",
			});

			// Give the client a moment to receive the error before disconnecting.
			setTimeout(() => {
				socket.disconnect(true);
			}, 500);
		}
	}

	async function destroyAllUserSessions(userId: string): Promise<void> {
		const sessions = await db.listSessionsByUser(userId);
		for (const session of sessions) {
			await db.destroySessionById(session.id);
			await disconnectSessionSockets(session.id);
		}
	}

	/**
	 * Returns true when the given user is the last enabled user with an
	 * admin-like role (superuser or admin). Such users must not be deleted,
	 * disabled or degraded, otherwise nobody could manage the instance anymore.
	 */
	async function isLastActiveAdmin(user: User): Promise<boolean> {
		if (user.enabled === false || !isAdminLike(user)) {
			return false;
		}

		const users = await db.listUsers();
		const activeAdmins = users.filter(
			(candidate) => candidate.enabled !== false && isAdminLike(candidate),
		);
		return activeAdmins.length <= 1;
	}

	type AuthedHandler = (
		user: User,
		req: express.Request,
		res: express.Response,
	) => Promise<void> | void;

	/**
	 * Wraps a handler, resolving the authenticated user (put into
	 * res.locals by authCheck) and converting thrown errors into 500s.
	 */
	const withUser =
		(handler: AuthedHandler): express.RequestHandler =>
		async (req, res, next) => {
			try {
				const user = res.locals.authenticatedUser;
				if (!user) {
					sendError(res, 401, "unauthorized", "Authentication required.");
					return;
				}

				await handler(user, req, res);
			} catch (error: unknown) {
				next(error);
			}
		};

	/**
	 * Like withUser, but additionally requires WRITE access to the
	 * user management namespace ("users:*", superuser/admin only).
	 */
	const withUserManagement = (handler: AuthedHandler): express.RequestHandler =>
		withUser(async (user, req, res) => {
			if (!db.hasPermission(user, "users:*", Action.WRITE)) {
				sendError(
					res,
					403,
					"forbidden",
					"You do not have permission to manage users.",
				);
				return;
			}

			await handler(user, req, res);
		});

	async function resolveRoles(
		rolesValue: unknown,
		res: express.Response,
	): Promise<Role[] | undefined> {
		if (
			!Array.isArray(rolesValue) ||
			rolesValue.some((role) => typeof role !== "string")
		) {
			sendError(
				res,
				400,
				"invalid_request",
				'"roles" must be an array of role names.',
			);
			return undefined;
		}

		const roles: Role[] = [];
		for (const roleName of rolesValue) {
			if (typeof roleName !== "string") {
				continue;
			}

			const role = await db.findRole(roleName);
			if (!role) {
				sendError(res, 400, "unknown_role", `Unknown role "${roleName}".`);
				return undefined;
			}

			roles.push(role);
		}

		return roles;
	}

	router.get(
		"/me",
		withUser((user, _req, res) => {
			res.json({
				...serializeUser(user),
				// Lets the dashboard decide whether to show the user management
				// UI without having to replicate the permission model client-side.
				canManageUsers: db.hasPermission(user, "users:*", Action.WRITE),
			});
		}),
	);

	router.get(
		"/roles",
		withUser(async (_user, _req, res) => {
			const roles = await db.listRoles();
			res.json(roles.map(serializeRole));
		}),
	);

	router.get(
		"/users",
		withUserManagement(async (_user, _req, res) => {
			const users = await db.listUsers();
			res.json(users.map(serializeUser));
		}),
	);

	router.post(
		"/users",
		withUserManagement(async (_user, req, res) => {
			const body: unknown = req.body;
			const name = optionalString(bodyProperty(body, "name"))?.trim();
			const password = optionalString(bodyProperty(body, "password"));
			const enabled = optionalBoolean(bodyProperty(body, "enabled"));
			const rolesValue = bodyProperty(body, "roles") ?? [];

			if (!name) {
				sendError(
					res,
					400,
					"invalid_request",
					'"name" is required and must be a non-empty string.',
				);
				return;
			}

			if (!password) {
				sendError(
					res,
					400,
					"invalid_request",
					'"password" is required and must be a non-empty string.',
				);
				return;
			}

			const roles = await resolveRoles(rolesValue, res);
			if (!roles) {
				return;
			}

			const existingIdent = await db.findLocalIdentByUsername(name);
			if (existingIdent) {
				sendError(
					res,
					409,
					"conflict",
					`A user with the name "${name}" already exists.`,
				);
				return;
			}

			const user = await db.createLocalUser({
				name,
				passwordHash: hashPassword(password),
				roles,
				enabled: enabled ?? true,
			});

			log.info('Created local user "%s"', name);
			res.status(201).json(serializeUser(user));
		}),
	);

	router.patch(
		"/users/:id",
		withUserManagement(async (_user, req, res) => {
			const targetId = req.params.id ?? "";
			const target = await db.findUser(targetId);
			if (!target) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			const body: unknown = req.body;
			const name = optionalString(bodyProperty(body, "name"))?.trim();
			const password = optionalString(bodyProperty(body, "password"));
			const enabled = optionalBoolean(bodyProperty(body, "enabled"));
			const rolesValue = bodyProperty(body, "roles");

			let roles: Role[] | undefined;
			if (rolesValue !== undefined) {
				roles = await resolveRoles(rolesValue, res);
				if (!roles) {
					return;
				}
			}

			const wouldDisable = enabled === false && target.enabled !== false;
			const wouldDegrade =
				roles !== undefined &&
				!roles.some(
					(role) => role.name === "superuser" || role.name === "admin",
				) &&
				isAdminLike(target);
			if ((wouldDisable || wouldDegrade) && (await isLastActiveAdmin(target))) {
				sendError(
					res,
					409,
					"last_admin",
					"Cannot disable or degrade the last active admin user.",
				);
				return;
			}

			if (name !== undefined && name !== target.name) {
				if (!name) {
					sendError(
						res,
						400,
						"invalid_request",
						'"name" must be a non-empty string.',
					);
					return;
				}

				const existingIdent = await db.findLocalIdentByUsername(name);
				if (existingIdent && existingIdent.user.id !== target.id) {
					sendError(
						res,
						409,
						"conflict",
						`A user with the name "${name}" already exists.`,
					);
					return;
				}
			}

			const updated = await db.updateLocalUser(target.id, {
				name,
				passwordHash:
					password === undefined ? undefined : hashPassword(password),
				roles,
				enabled,
			});
			if (!updated) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			// Disabling a user terminates their active sessions.
			if (wouldDisable) {
				await destroyAllUserSessions(target.id);
			}

			res.json(serializeUser(updated));
		}),
	);

	router.delete(
		"/users/:id",
		withUserManagement(async (_user, req, res) => {
			const targetId = req.params.id ?? "";
			const target = await db.findUser(targetId);
			if (!target) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			if (await isLastActiveAdmin(target)) {
				sendError(
					res,
					409,
					"last_admin",
					"Cannot delete the last active admin user.",
				);
				return;
			}

			await destroyAllUserSessions(target.id);
			await db.deleteUser(target.id);
			log.info('Deleted user "%s"', target.name);
			res.status(204).end();
		}),
	);

	router.post(
		"/users/:id/2fa/reset",
		withUserManagement(async (_user, req, res) => {
			const targetId = req.params.id ?? "";
			const updated = await db.updateLocalUser(targetId, {
				totp_secret: null,
				totp_enabled: false,
			});
			if (!updated) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			log.info('Reset 2FA for user "%s"', updated.name);
			res.status(204).end();
		}),
	);

	router.get(
		"/users/:id/sessions",
		withUserManagement(async (_user, req, res) => {
			const targetId = req.params.id ?? "";
			const target = await db.findUser(targetId);
			if (!target) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			const sessions = await db.listSessionsByUser(target.id);
			const now = Date.now();
			res.json(
				sessions
					.filter((session) => session.expiredAt > now)
					.map((session) => serializeSession(session, null)),
			);
		}),
	);

	router.delete(
		"/users/:id/sessions/:sessionId",
		withUserManagement(async (_user, req, res) => {
			const targetId = req.params.id ?? "";
			const sessionId = req.params.sessionId ?? "";
			const session = await db.getSession(sessionId);
			if (session?.user_id !== targetId) {
				sendError(res, 404, "not_found", "No such session.");
				return;
			}

			await db.destroySessionById(sessionId);
			await disconnectSessionSockets(sessionId);
			res.status(204).end();
		}),
	);

	router.get(
		"/me/sessions",
		withUser(async (user, req, res) => {
			const sessions = await db.listSessionsByUser(user.id);
			const now = Date.now();
			const currentSessionId = optionalString(req.sessionID) ?? null;
			res.json(
				sessions
					.filter((session) => session.expiredAt > now)
					.map((session) => serializeSession(session, currentSessionId)),
			);
		}),
	);

	router.delete(
		"/me/sessions/:sessionId",
		withUser(async (user, req, res) => {
			const sessionId = req.params.sessionId ?? "";
			const session = await db.getSession(sessionId);
			if (session?.user_id !== user.id) {
				sendError(res, 404, "not_found", "No such session.");
				return;
			}

			await db.destroySessionById(sessionId);
			await disconnectSessionSockets(sessionId);
			res.status(204).end();
		}),
	);

	router.post(
		"/me/2fa/enroll",
		withUser(async (user, _req, res) => {
			if (user.totp_enabled) {
				sendError(
					res,
					409,
					"already_enrolled",
					"Two-factor authentication is already enabled. Disable it first to re-enroll.",
				);
				return;
			}

			const secret = generateTotpSecret();
			const updated = await db.updateLocalUser(user.id, {
				totp_secret: secret,
				totp_enabled: false,
			});
			if (!updated) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			res.json({
				secret,
				otpauthUrl: buildOtpauthUrl(secret, user.name),
			});
		}),
	);

	router.post(
		"/me/2fa/verify",
		withUser(async (user, req, res) => {
			const token = optionalString(bodyProperty(req.body, "token"));
			if (!token) {
				sendError(res, 400, "invalid_request", '"token" is required.');
				return;
			}

			const freshUser = await db.findUser(user.id);
			if (!freshUser?.totp_secret) {
				sendError(
					res,
					400,
					"not_enrolled",
					"Two-factor authentication enrollment has not been started.",
				);
				return;
			}

			if (!verifyTotpToken(freshUser.totp_secret, token)) {
				sendError(res, 400, "totp_invalid", "Invalid two-factor token.");
				return;
			}

			const updated = await db.updateLocalUser(user.id, { totp_enabled: true });
			if (!updated) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			log.info('Enabled 2FA for user "%s"', user.name);
			res.json(serializeUser(updated));
		}),
	);

	router.delete(
		"/me/2fa",
		withUser(async (user, req, res) => {
			const freshUser = await db.findUser(user.id);
			if (!freshUser?.totp_enabled || !freshUser.totp_secret) {
				sendError(
					res,
					400,
					"not_enrolled",
					"Two-factor authentication is not enabled.",
				);
				return;
			}

			const token = optionalString(bodyProperty(req.body, "token"));
			if (!token) {
				sendError(res, 400, "invalid_request", '"token" is required.');
				return;
			}

			if (!verifyTotpToken(freshUser.totp_secret, token)) {
				sendError(res, 400, "totp_invalid", "Invalid two-factor token.");
				return;
			}

			const updated = await db.updateLocalUser(user.id, {
				totp_secret: null,
				totp_enabled: false,
			});
			if (!updated) {
				sendError(res, 404, "not_found", "No such user.");
				return;
			}

			log.info('Disabled 2FA for user "%s"', user.name);
			res.json(serializeUser(updated));
		}),
	);

	router.use((_req, res) => {
		sendError(res, 404, "not_found", "Unknown API endpoint.");
	});

	return router;
}
