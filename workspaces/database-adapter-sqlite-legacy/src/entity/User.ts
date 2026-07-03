import type { User as UserModel } from "@mooncg/database-adapter-types";
import {
	Column,
	CreateDateColumn,
	Entity,
	JoinTable,
	ManyToMany,
	OneToMany,
	PrimaryGeneratedColumn,
} from "typeorm";

import { ApiKey } from "./ApiKey.ts";
import { Identity } from "./Identity.ts";
import { Role } from "./Role.ts";

@Entity({ name: "user" })
export class User implements UserModel {
	@PrimaryGeneratedColumn("uuid")
	id!: string;

	@CreateDateColumn()
	created_at!: number;

	@Column("text")
	name!: string;

	/**
	 * Whether this user is allowed to log in.
	 */
	@Column("boolean", { default: true })
	enabled!: boolean;

	/**
	 * Base32-encoded TOTP secret. Only set once a user has started
	 * (or completed) TOTP enrollment.
	 */
	@Column("text", { nullable: true })
	totp_secret: string | null = null;

	/**
	 * Whether TOTP two-factor authentication is enforced for this user.
	 */
	@Column("boolean", { default: false })
	totp_enabled!: boolean;

	@ManyToMany(() => Role)
	@JoinTable()
	roles!: Role[];

	@OneToMany(() => Identity, (identity) => identity.user)
	identities!: Identity[];

	@OneToMany(() => ApiKey, (apiKey) => apiKey.user)
	apiKeys!: ApiKey[];
}
