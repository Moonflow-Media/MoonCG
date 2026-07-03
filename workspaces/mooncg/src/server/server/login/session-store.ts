import type { DatabaseAdapter } from "@mooncg/database-adapter-types";
import type { SessionData } from "express-session";
import expressSession from "express-session";

/**
 * A small express-session store backed by the database adapter's
 * Session entity. Replaces the default (leaky, non-persistent) MemoryStore.
 */
export class DatabaseSessionStore extends expressSession.Store {
	constructor(
		private readonly _db: DatabaseAdapter,
		private readonly _ttlSeconds: number,
	) {
		super();
	}

	override get(
		sid: string,
		callback: (err: unknown, session?: SessionData | null) => void,
	): void {
		void (async () => {
			try {
				const session = await this._db.getSession(sid);
				if (!session) {
					callback(undefined, undefined);
					return;
				}

				if (session.expiredAt <= Date.now()) {
					await this._db.destroySessionById(sid);
					callback(undefined, undefined);
					return;
				}

				const data: SessionData = JSON.parse(session.json);
				callback(undefined, data);
			} catch (error: unknown) {
				callback(error);
			}
		})();
	}

	override set(
		sid: string,
		session: SessionData,
		callback?: (err?: unknown) => void,
	): void {
		void (async () => {
			try {
				await this._db.setSession({
					id: sid,
					expiredAt: Date.now() + this._getTtlMs(session),
					json: JSON.stringify(session),
					user_id: session.passport?.user ?? null,
				});
				callback?.();
			} catch (error: unknown) {
				callback?.(error);
			}
		})();
	}

	override destroy(sid: string, callback?: (err?: unknown) => void): void {
		void (async () => {
			try {
				await this._db.destroySessionById(sid);
				callback?.();
			} catch (error: unknown) {
				callback?.(error);
			}
		})();
	}

	override touch(
		sid: string,
		session: SessionData,
		callback?: (err?: unknown) => void,
	): void {
		void (async () => {
			try {
				await this._db.touchSession(sid, Date.now() + this._getTtlMs(session));
				callback?.();
			} catch (error: unknown) {
				callback?.(error);
			}
		})();
	}

	private _getTtlMs(session: SessionData): number {
		const { maxAge } = session.cookie;
		if (typeof maxAge === "number" && maxAge > 0) {
			return maxAge;
		}

		return this._ttlSeconds * 1000;
	}
}
