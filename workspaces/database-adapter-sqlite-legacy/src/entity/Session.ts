import type { Session as SessionModel } from "@mooncg/database-adapter-types";
import { Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "session" })
export class Session implements SessionModel {
	@PrimaryColumn("varchar", { length: 255 })
	id!: string;

	/**
	 * Unix timestamp (in milliseconds) at which this session expires.
	 */
	@Index()
	@Column("bigint", {
		transformer: {
			from: (value: string | number): number => Number(value),
			to: (value: number): number => value,
		},
	})
	expiredAt!: number;

	/**
	 * The serialized express-session JSON payload.
	 */
	@Column("text")
	json!: string;

	/**
	 * The id of the user this session belongs to.
	 * Null for sessions that are not (yet) associated with a login.
	 */
	@Index()
	@Column("varchar", { nullable: true })
	user_id: string | null = null;
}
