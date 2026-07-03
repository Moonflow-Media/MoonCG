import type { Browser, Page } from "puppeteer";
import { expect } from "vitest";

import { generateTotpToken } from "../../src/server/util/totp";
import { setupTest } from "../helpers/setup";
import * as C from "../helpers/test-constants";

const test = await setupTest("mooncg-login.json");

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
 * Performs a local login via the same form POST the login page uses and
 * returns the session cookie. Used to prepare server-side state (users,
 * sessions) without going through the browser.
 */
async function loginLocalOk(
	username: string,
	password: string,
): Promise<string> {
	const res = await fetch(`${C.rootUrl()}login/local`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username, password }).toString(),
		redirect: "manual",
	});
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe("/dashboard");
	const cookie = getCookie(res, "connect.sid");
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
 * Logs into the dashboard through the login page UI.
 */
async function logInUi(
	page: Page,
	username: string,
	password: string,
): Promise<void> {
	await page.bringToFront();
	await page.goto(C.dashboardUrl());
	expect(page.url()).toBe(C.loginUrl());
	await page.waitForNetworkIdle();

	// Use this instead of .type to ensure that any previous input is cleared.
	await page.evaluate(
		(un, pw) => {
			const usernameInput = document.getElementById(
				"username",
			) as HTMLInputElement;
			const passwordInput = document.getElementById(
				"password",
			) as HTMLInputElement;
			usernameInput.value = un;
			passwordInput.value = pw;
		},
		username,
		password,
	);

	await page.click("#localSubmit");
	await page.waitForNetworkIdle();
	expect(page.url()).toBe(C.dashboardUrl());
	await page.waitForSelector('[data-testid="dashboard-app"]');
}

let adminDashboard: Page | null = null;

/**
 * A dashboard page logged in as the config admin (superuser), shared
 * across the tests in this file.
 */
async function getAdminDashboard(browser: Browser): Promise<Page> {
	if (!adminDashboard) {
		const page = await browser.newPage();
		await logInUi(page, "admin", "password");
		adminDashboard = page;
	}

	await adminDashboard.bringToFront();
	return adminDashboard;
}

function userRow(name: string): string {
	return `[data-testid="user-row"][data-user-name="${name}"]`;
}

/**
 * Navigates the dashboard to the given hash route with a full page reload,
 * so that all pages remount and re-fetch their data. A plain `page.goto()`
 * with a changed hash would be a same-document navigation and keep stale
 * state around.
 */
async function reloadDashboardAt(page: Page, route: string): Promise<void> {
	await page.evaluate((newRoute) => {
		window.location.hash = newRoute;
	}, route);
	await page.reload();
	await page.waitForSelector('[data-testid="dashboard-app"]');
}

async function waitForToast(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(needle) => {
			const container = document.querySelector(
				'[data-testid="toast-container"]',
			);
			return container?.textContent?.includes(needle) ?? false;
		},
		{},
		text,
	);
}

test("admin sees the Users tab and the user list", async ({ browser }) => {
	const page = await getAdminDashboard(browser);

	await page.waitForSelector('[data-testid="tab-users"]');
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector('[data-testid="users"]');

	// The admin's own user is listed with its role.
	await page.waitForSelector(userRow("admin"));
	const roles = await page.$eval(
		`${userRow("admin")} .user-roles`,
		(el) => el.textContent,
	);
	expect(roles).toContain("superuser");
});

test("a user can be created through the UI and appears in the list", async ({
	browser,
}) => {
	const page = await getAdminDashboard(browser);
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector('[data-testid="users-add"]');

	await page.click('[data-testid="users-add"]');
	await page.waitForSelector('[data-testid="user-editor-dialog"]');
	await page.type('[data-testid="user-editor-name"]', "ui-user");
	await page.type('[data-testid="user-editor-password"]', "ui-password");
	await page.click('[data-testid="user-role-option-operator"]');
	await page.click('[data-testid="user-editor-save"]');

	await page.waitForSelector(userRow("ui-user"));
	const roles = await page.$eval(
		`${userRow("ui-user")} .user-roles`,
		(el) => el.textContent,
	);
	expect(roles).toBe("operator");
	const status = await page.$eval(
		`${userRow("ui-user")} .user-status`,
		(el) => el.textContent,
	);
	expect(status).toBe("Enabled");

	// The user actually exists and can log in.
	await loginLocalOk("ui-user", "ui-password");
});

test("creating a duplicate user shows the 409 error as a toast", async ({
	browser,
}) => {
	const page = await getAdminDashboard(browser);
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector('[data-testid="users-add"]');

	await page.click('[data-testid="users-add"]');
	await page.waitForSelector('[data-testid="user-editor-dialog"]');
	await page.type('[data-testid="user-editor-name"]', "ui-user");
	await page.type('[data-testid="user-editor-password"]', "whatever");
	await page.click('[data-testid="user-editor-save"]');

	await waitForToast(page, 'A user with the name "ui-user" already exists.');

	// The dialog stays open so the input can be corrected; dismiss it.
	await page.click('[data-testid="user-editor-cancel"]');
	await page.waitForFunction(
		() => !document.querySelector('[data-testid="user-editor-dialog"]'),
	);
});

test("a user's roles can be changed through the UI", async ({ browser }) => {
	const page = await getAdminDashboard(browser);
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector(userRow("ui-user"));

	await page.click(`${userRow("ui-user")} [data-testid="user-edit"]`);
	await page.waitForSelector('[data-testid="user-editor-dialog"]');
	// Swap operator for viewer.
	await page.click('[data-testid="user-role-option-operator"]');
	await page.click('[data-testid="user-role-option-viewer"]');
	await page.click('[data-testid="user-editor-save"]');

	await page.waitForFunction(
		(selector) =>
			document.querySelector(`${selector} .user-roles`)?.textContent ===
			"viewer",
		{},
		userRow("ui-user"),
	);
});

test("disabling the last admin fails with an understandable toast", async ({
	browser,
}) => {
	const page = await getAdminDashboard(browser);
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector(userRow("admin"));

	await page.click(`${userRow("admin")} [data-testid="user-edit"]`);
	await page.waitForSelector('[data-testid="user-editor-dialog"]');
	await page.click('[data-testid="user-editor-enabled"]');
	await page.click('[data-testid="user-editor-save"]');

	await waitForToast(
		page,
		"Cannot disable or degrade the last active admin user.",
	);

	await page.click('[data-testid="user-editor-cancel"]');
	await page.waitForFunction(
		() => !document.querySelector('[data-testid="user-editor-dialog"]'),
	);

	// The admin is still enabled.
	const status = await page.$eval(
		`${userRow("admin")} .user-status`,
		(el) => el.textContent,
	);
	expect(status).toBe("Enabled");
});

test("a user can be disabled through the UI", async ({ browser }) => {
	const page = await getAdminDashboard(browser);
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector(userRow("ui-user"));

	await page.click(`${userRow("ui-user")} [data-testid="user-edit"]`);
	await page.waitForSelector('[data-testid="user-editor-dialog"]');
	await page.click('[data-testid="user-editor-enabled"]');
	await page.click('[data-testid="user-editor-save"]');

	await page.waitForFunction(
		(selector) =>
			document.querySelector(`${selector} .user-status`)?.textContent ===
			"Disabled",
		{},
		userRow("ui-user"),
	);

	// Disabled users cannot log in anymore.
	const res = await fetch(`${C.rootUrl()}login/local`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			username: "ui-user",
			password: "ui-password",
		}).toString(),
		redirect: "manual",
	});
	expect(res.headers.get("location")).toContain("error=user_disabled");
});

test("a user can be deleted through the UI", async ({ browser }) => {
	const page = await getAdminDashboard(browser);
	await page.click('[data-testid="tab-users"]');
	await page.waitForSelector(userRow("ui-user"));

	await page.click(`${userRow("ui-user")} [data-testid="user-delete"]`);
	await page.waitForSelector('[data-testid="user-delete-dialog"]');
	await page.click('[data-testid="user-delete-confirm"]');

	await page.waitForFunction(
		(selector) => !document.querySelector(selector),
		{},
		userRow("ui-user"),
	);
});

test("an admin can list and end another user's sessions through the UI", async ({
	browser,
}) => {
	// Prepare a user with one active session, bypassing the UI.
	const adminCookie = await loginLocalOk("admin", "password");
	const createRes = await api("POST", "/users", adminCookie, {
		name: "db-session-user",
		password: "session-password",
		roles: ["operator"],
	});
	expect(createRes.status).toBe(201);
	const sessionCookie = await loginLocalOk(
		"db-session-user",
		"session-password",
	);

	// Fully reload the users page so the new user is picked up.
	const page = await getAdminDashboard(browser);
	await reloadDashboardAt(page, "users");
	await page.waitForSelector(userRow("db-session-user"));

	await page.click(
		`${userRow("db-session-user")} [data-testid="user-sessions"]`,
	);
	await page.waitForSelector('[data-testid="user-sessions-dialog"]');
	await page.waitForSelector('[data-testid="user-session-row"]');

	await page.click('[data-testid="user-session-revoke"]');
	await page.waitForFunction(
		() => !document.querySelector('[data-testid="user-session-row"]'),
	);
	await page.click('[data-testid="user-sessions-close"]');

	// The revoked session is actually logged out.
	const meRes = await api("GET", "/me", sessionCookie);
	expect(meRes.status).toBe(302);
	expect(meRes.headers.get("location")).toBe("/login");
});

test("non-admins do not see the Users tab", async ({ browser }) => {
	const adminCookie = await loginLocalOk("admin", "password");
	const createRes = await api("POST", "/users", adminCookie, {
		name: "db-operator-ui",
		password: "operator-password",
		roles: ["operator"],
	});
	expect(createRes.status).toBe(201);

	// A separate browser context keeps the operator's cookies isolated
	// from the admin session used by the other tests.
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await logInUi(page, "db-operator-ui", "operator-password");

		// The Settings tab is shown to every logged-in user; once the app has
		// settled (including the /api/v1/me request), there must be no Users tab.
		await page.waitForSelector('[data-testid="tab-settings"]');
		await page.waitForNetworkIdle();
		expect(await page.$('[data-testid="tab-users"]')).toBeNull();
		expect(await page.$('[data-testid="page-users"]')).toBeNull();

		// The settings self-service sections are available to non-admins.
		await page.click('[data-testid="tab-settings"]');
		await page.waitForSelector('[data-testid="settings-2fa"]');
		await page.waitForSelector('[data-testid="settings-sessions"]');
	} finally {
		await context.close();
	}
});

test("settings lists active sessions and other sessions can be ended", async ({
	browser,
}) => {
	// Create a second admin session that should show up in the list.
	await loginLocalOk("admin", "password");

	// Fully reload the settings page so the session list is fresh.
	const page = await getAdminDashboard(browser);
	await reloadDashboardAt(page, "settings");
	await page.waitForSelector('[data-testid="settings-sessions"]');

	// The browser's own session is marked as current...
	await page.waitForSelector(
		'[data-testid="settings-session-row"][data-current="true"]',
	);
	// ...and the fetch-created session appears as a non-current entry.
	await page.waitForSelector(
		'[data-testid="settings-session-row"][data-current="false"]',
	);

	const victimId = await page.$eval(
		'[data-testid="settings-session-row"][data-current="false"]',
		(el) => el.getAttribute("data-session-id"),
	);
	expect(victimId).toBeTruthy();

	await page.click(
		`[data-testid="settings-session-row"][data-session-id="${victimId}"] ` +
			'[data-testid="settings-session-revoke"]',
	);
	await page.waitForFunction(
		(id) =>
			!document.querySelector(
				`[data-testid="settings-session-row"][data-session-id="${id}"]`,
			),
		{},
		victimId,
	);

	// The current session is unaffected.
	expect(
		await page.$('[data-testid="settings-session-row"][data-current="true"]'),
	).not.toBeNull();
});

test("2FA can be enrolled, verified, and disabled through the settings UI", async ({
	browser,
}) => {
	const page = await getAdminDashboard(browser);
	await reloadDashboardAt(page, "settings");
	await page.waitForSelector('[data-testid="settings-2fa"]');

	// Enroll: shows a QR code and the secret as text.
	await page.waitForSelector('[data-testid="settings-2fa-enroll"]');
	await page.click('[data-testid="settings-2fa-enroll"]');
	await page.waitForSelector('[data-testid="settings-2fa-qr"]');
	const qrSrc = await page.$eval('[data-testid="settings-2fa-qr"]', (el) =>
		el.getAttribute("src"),
	);
	expect(qrSrc).toMatch(/^data:image\//);
	const secret = await page.$eval(
		'[data-testid="settings-2fa-secret"]',
		(el) => el.textContent ?? "",
	);
	expect(secret.length).toBeGreaterThan(0);

	// A wrong token is rejected and 2FA stays off.
	await page.type('[data-testid="settings-2fa-token"]', "000000");
	await page.click('[data-testid="settings-2fa-verify"]');
	await waitForToast(page, "Invalid two-factor token.");

	// A valid token enables 2FA. Clear the previous input through the native
	// value setter so that the controlled React input picks up the change.
	await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>(
			'[data-testid="settings-2fa-token"]',
		);
		const setter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)?.set;
		if (input && setter) {
			setter.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	await page.type(
		'[data-testid="settings-2fa-token"]',
		generateTotpToken(secret),
	);
	await page.click('[data-testid="settings-2fa-verify"]');
	await page.waitForSelector('[data-testid="settings-2fa-status"]');

	// Disable it again with a fresh token.
	await page.type(
		'[data-testid="settings-2fa-token"]',
		generateTotpToken(secret),
	);
	await page.click('[data-testid="settings-2fa-disable"]');
	await page.waitForSelector('[data-testid="settings-2fa-enroll"]');
});
