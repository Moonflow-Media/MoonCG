import type { Identity as IdentityModel } from "@mooncg/database-adapter-types";
import {
	Column,
	Entity,
	ManyToOne,
	PrimaryGeneratedColumn,
	type Relation,
} from "typeorm";

import { User } from "./User.ts";

@Entity({ name: "identity" })
export class Identity implements IdentityModel {
	@PrimaryGeneratedColumn("uuid")
	id!: string;

	@Column("text")
	provider_type!: "twitch" | "steam" | "local" | "discord";

	/**
	 * Hashed password for local, auth token from twitch, etc.
	 */
	@Column("text")
	provider_hash!: string;

	/**
	 * scrypt password hash for provider_type "local" database users.
	 * Identities created through the static config login flow leave this null.
	 */
	@Column("text", { nullable: true })
	provider_secret: string | null = null;

	/**
	 * Only used by Twitch and Discord providers.
	 */
	@Column("text", { nullable: true })
	provider_access_token: string | null = null;

	/**
	 * Only used by Twitch and Discord providers.
	 */
	@Column("text", { nullable: true })
	provider_refresh_token: string | null = null;

	@ManyToOne(() => User, (user) => user.identities)
	user!: Relation<User>;
}
