import type { DatabaseAdapter } from "@mooncg/database-adapter-types";
import { Action } from "@mooncg/database-adapter-types";

import type { TypedServerSocket } from "../../types/socket-protocol";
import { config } from "../config";

/**
 * Checks whether the user behind a socket may perform a write operation
 * (Replicant mutations, sending messages) on the given entity.
 *
 * When login security is disabled, everything is allowed (the socket
 * would not have been able to connect otherwise anyway).
 */
export function canSocketWrite(
	db: DatabaseAdapter,
	socket: TypedServerSocket,
	entityId: string,
): boolean {
	if (!config.login.enabled) {
		return true;
	}

	const { user } = socket.data;
	if (!user) {
		return false;
	}

	return db.hasPermission(user, entityId, Action.WRITE);
}
