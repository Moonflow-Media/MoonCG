import { describe, expect, it } from "vitest";

import { Action, hasPermission } from "./has-permission.ts";

function makeRole(
	name: string,
	permissions: { entityId: string; actions: number }[],
) {
	return { name, permissions };
}

const superuser = { roles: [makeRole("superuser", [])] };
const admin = {
	roles: [
		makeRole("admin", [
			{ entityId: "*", actions: Action.READ | Action.WRITE },
			{ entityId: "users:*", actions: Action.READ | Action.WRITE },
		]),
	],
};
const operator = {
	roles: [
		makeRole("operator", [
			{ entityId: "*", actions: Action.READ | Action.WRITE },
		]),
	],
};
const viewer = {
	roles: [makeRole("viewer", [{ entityId: "*", actions: Action.READ }])],
};

describe("hasPermission", () => {
	it("always allows the superuser role", () => {
		expect(hasPermission(superuser, "dashboard", Action.READ)).toBe(true);
		expect(hasPermission(superuser, "users:*", Action.WRITE)).toBe(true);
		expect(
			hasPermission(superuser, "anything", Action.READ | Action.WRITE),
		).toBe(true);
	});

	it("denies users without roles", () => {
		expect(hasPermission({ roles: [] }, "dashboard", Action.READ)).toBe(false);
		expect(hasPermission({}, "dashboard", Action.READ)).toBe(false);
	});

	it("grants the viewer role READ but not WRITE", () => {
		expect(hasPermission(viewer, "dashboard", Action.READ)).toBe(true);
		expect(hasPermission(viewer, "replicants:bundle:rep", Action.READ)).toBe(
			true,
		);
		expect(hasPermission(viewer, "dashboard", Action.WRITE)).toBe(false);
		expect(hasPermission(viewer, "replicants:bundle:rep", Action.WRITE)).toBe(
			false,
		);
		expect(hasPermission(viewer, "dashboard", Action.READ | Action.WRITE)).toBe(
			false,
		);
	});

	it("grants the operator role READ and WRITE but no user management", () => {
		expect(hasPermission(operator, "dashboard", Action.READ)).toBe(true);
		expect(hasPermission(operator, "replicants:bundle:rep", Action.WRITE)).toBe(
			true,
		);
		expect(hasPermission(operator, "users:*", Action.WRITE)).toBe(false);
		expect(hasPermission(operator, "users:some-id", Action.READ)).toBe(false);
		expect(hasPermission(operator, "users", Action.READ)).toBe(false);
	});

	it("grants the admin role user management via the users:* permission", () => {
		expect(hasPermission(admin, "dashboard", Action.READ)).toBe(true);
		expect(hasPermission(admin, "users:*", Action.WRITE)).toBe(true);
		expect(hasPermission(admin, "users:some-id", Action.WRITE)).toBe(true);
	});

	it("matches exact entity ids", () => {
		const user = {
			roles: [makeRole("custom", [{ entityId: "dashboard", actions: 1 }])],
		};
		expect(hasPermission(user, "dashboard", Action.READ)).toBe(true);
		expect(hasPermission(user, "dashboard2", Action.READ)).toBe(false);
	});

	it("matches prefix wildcards", () => {
		const user = {
			roles: [
				makeRole("custom", [
					{ entityId: "replicants:*", actions: Action.READ | Action.WRITE },
				]),
			],
		};
		expect(hasPermission(user, "replicants:bundle:rep", Action.WRITE)).toBe(
			true,
		);
		expect(hasPermission(user, "messages:bundle", Action.WRITE)).toBe(false);
	});

	it("requires all requested action bits", () => {
		const user = {
			roles: [makeRole("custom", [{ entityId: "*", actions: Action.WRITE }])],
		};
		expect(hasPermission(user, "dashboard", Action.WRITE)).toBe(true);
		expect(hasPermission(user, "dashboard", Action.READ)).toBe(false);
		expect(hasPermission(user, "dashboard", Action.READ | Action.WRITE)).toBe(
			false,
		);
	});

	it("collects permissions across multiple roles", () => {
		const user = {
			roles: [
				makeRole("a", [{ entityId: "dashboard", actions: Action.READ }]),
				makeRole("b", [{ entityId: "assets", actions: Action.WRITE }]),
			],
		};
		expect(hasPermission(user, "dashboard", Action.READ)).toBe(true);
		expect(hasPermission(user, "assets", Action.WRITE)).toBe(true);
		expect(hasPermission(user, "assets", Action.READ)).toBe(false);
	});
});
