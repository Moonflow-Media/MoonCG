import path from "node:path";

import { rootPaths } from "@mooncg/internal-util";
import sqlite3 from "better-sqlite3";
import { DataSource } from "typeorm";

import { ApiKey } from "./entity/ApiKey.ts";
import { Identity } from "./entity/Identity.ts";
import { Permission } from "./entity/Permission.ts";
import { Replicant } from "./entity/Replicant.ts";
import { Role } from "./entity/Role.ts";
import { Session } from "./entity/Session.ts";
import { User } from "./entity/User.ts";
import { initialize1669424617013 } from "./migration/1669424617013-initialize.ts";
import { defaultRoles1669424781583 } from "./migration/1669424781583-default-roles.ts";
import { authUsers1783038858752 } from "./migration/1783038858752-auth-users.ts";

const testing = process.env["MOONCG_TEST"]?.toLowerCase() === "true";

export const dataSource = new DataSource({
	type: "better-sqlite3",
	driver: sqlite3,

	/**
	 * TypeORM has this special :memory: key which indicates
	 * that an in-memory version of SQLite should be used.
	 *
	 * I can't find ANY documentation on this,
	 * only references to it in GitHub issue threads
	 * and in the TypeORM source code.
	 *
	 * But, bad docs aside, it is still useful
	 * and we use it for tests.
	 */
	database: testing
		? ":memory:"
		: path.join(rootPaths.getRuntimeRoot(), "db/mooncg.sqlite3"),
	logging: false,
	entities: [ApiKey, Identity, Permission, Replicant, Role, Session, User],
	migrations: [
		initialize1669424617013,
		defaultRoles1669424781583,
		authUsers1783038858752,
	],
	migrationsRun: true,
	synchronize: false,
});
