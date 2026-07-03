import { Action } from "@mooncg/database-adapter-types";
import { type MigrationInterface, type QueryRunner } from "typeorm";

const ADMIN_ROLE_ID = "5e186f60-9700-4c85-b515-99e26e6b41d0";
const ADMIN_PERMISSION_ID = "f19fca4b-8de5-401f-b0c2-9db54f38e58a";
const ADMIN_USERS_PERMISSION_ID = "24bd0d97-59d1-46db-b6bb-a1a51d40ba43";
const OPERATOR_ROLE_ID = "1f288d92-4ef6-4832-8087-abbcfa2cc7f6";
const OPERATOR_PERMISSION_ID = "3e615aa4-25e5-42ea-8c94-59ba98136da7";
const VIEWER_ROLE_ID = "3c07f22d-8552-4b30-a2ce-96e46f16467d";
const VIEWER_PERMISSION_ID = "cf1ad336-0946-4d5f-8b96-e9d637fd147d";

/**
 * Auth system extension:
 * - Identity.provider_secret (scrypt hash for database-backed local users)
 * - User.totp_secret / User.totp_enabled (TOTP 2FA)
 * - User.enabled (account lockout)
 * - Session.user_id (+ index) for "active sessions per user"
 * - Seeds the default roles admin / operator / viewer
 */
export class authUsers1783038858752 implements MigrationInterface {
	name = "authUsers1783038858752";

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "identity" ADD COLUMN "provider_secret" text`,
		);
		await queryRunner.query(`ALTER TABLE "user" ADD COLUMN "totp_secret" text`);
		await queryRunner.query(
			`ALTER TABLE "user" ADD COLUMN "totp_enabled" boolean NOT NULL DEFAULT (0)`,
		);
		await queryRunner.query(
			`ALTER TABLE "user" ADD COLUMN "enabled" boolean NOT NULL DEFAULT (1)`,
		);
		await queryRunner.query(`ALTER TABLE "session" ADD COLUMN "user_id" varchar`);
		await queryRunner.query(
			`CREATE INDEX "IDX_session_user_id" ON "session" ("user_id")`,
		);

		const readWrite = Action.READ | Action.WRITE;

		// admin: full access like superuser, plus explicit access to the
		// user management API ("users:*" is not covered by the "*" wildcard).
		await queryRunner.query(
			`INSERT INTO role (id, name) VALUES ('${ADMIN_ROLE_ID}', 'admin');`,
		);
		await queryRunner.query(
			`INSERT INTO permission (name, id, roleId, entityId, actions) VALUES ('admin', '${ADMIN_PERMISSION_ID}', '${ADMIN_ROLE_ID}', '*', ${readWrite});`,
		);
		await queryRunner.query(
			`INSERT INTO permission (name, id, roleId, entityId, actions) VALUES ('admin-users', '${ADMIN_USERS_PERMISSION_ID}', '${ADMIN_ROLE_ID}', 'users:*', ${readWrite});`,
		);

		// operator: full read/write access, but no user management.
		await queryRunner.query(
			`INSERT INTO role (id, name) VALUES ('${OPERATOR_ROLE_ID}', 'operator');`,
		);
		await queryRunner.query(
			`INSERT INTO permission (name, id, roleId, entityId, actions) VALUES ('operator', '${OPERATOR_PERMISSION_ID}', '${OPERATOR_ROLE_ID}', '*', ${readWrite});`,
		);

		// viewer: read-only access.
		await queryRunner.query(
			`INSERT INTO role (id, name) VALUES ('${VIEWER_ROLE_ID}', 'viewer');`,
		);
		await queryRunner.query(
			`INSERT INTO permission (name, id, roleId, entityId, actions) VALUES ('viewer', '${VIEWER_PERMISSION_ID}', '${VIEWER_ROLE_ID}', '*', ${Action.READ});`,
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DELETE FROM permission WHERE id = ?`, [
			VIEWER_PERMISSION_ID,
		]);
		await queryRunner.query(`DELETE FROM role WHERE id = ?`, [VIEWER_ROLE_ID]);
		await queryRunner.query(`DELETE FROM permission WHERE id = ?`, [
			OPERATOR_PERMISSION_ID,
		]);
		await queryRunner.query(`DELETE FROM role WHERE id = ?`, [OPERATOR_ROLE_ID]);
		await queryRunner.query(`DELETE FROM permission WHERE id = ?`, [
			ADMIN_USERS_PERMISSION_ID,
		]);
		await queryRunner.query(`DELETE FROM permission WHERE id = ?`, [
			ADMIN_PERMISSION_ID,
		]);
		await queryRunner.query(`DELETE FROM role WHERE id = ?`, [ADMIN_ROLE_ID]);
		await queryRunner.query(`DROP INDEX "IDX_session_user_id"`);
		await queryRunner.query(`ALTER TABLE "session" DROP COLUMN "user_id"`);
		await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "enabled"`);
		await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "totp_enabled"`);
		await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "totp_secret"`);
		await queryRunner.query(
			`ALTER TABLE "identity" DROP COLUMN "provider_secret"`,
		);
	}
}
