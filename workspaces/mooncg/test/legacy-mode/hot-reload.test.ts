import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type * as puppeteer from "puppeteer";
import { expect } from "vitest";

import { setupTest } from "../helpers/setup";
import * as C from "../helpers/test-constants";

const test = await setupTest("mooncg-hot-reload.json");

const hrBundleName = "hot-reload-bundle";

function hrBundleDir(): string {
	return path.join(process.env.MOONCG_ROOT!, "bundles", hrBundleName);
}

function replaceInFile(filePath: string, search: string, replacement: string) {
	const content = fs.readFileSync(filePath, "utf8");
	if (!content.includes(search)) {
		throw new Error(`"${search}" not found in ${filePath}`);
	}

	fs.writeFileSync(filePath, content.replaceAll(search, replacement), "utf8");
}

/**
 * Sends a message to the hot-reload-bundle extension and resolves with its
 * acknowledgement, or with "__timeout__" when no extension handler responds
 * in time (e.g. while the extension is unloaded mid-reload).
 */
async function askExtension(dashboard: puppeteer.Page, messageName: string) {
	return dashboard.evaluate(
		async (msg, bundle) =>
			Promise.race([
				window.dashboardApi.sendMessageToBundle<string>(msg, bundle),
				new Promise<string>((resolve) => {
					setTimeout(() => {
						resolve("__timeout__");
					}, 1500);
				}),
			]),
		messageName,
		hrBundleName,
	);
}

async function waitForExtensionResponse(
	dashboard: puppeteer.Page,
	expected: string,
	timeoutMs = 10_000,
) {
	const deadline = Date.now() + timeoutMs;
	let last: string | undefined;
	while (Date.now() < deadline) {
		last = await askExtension(dashboard, "hr-getValue");
		if (last === expected) {
			return last;
		}

		await sleep(250);
	}

	return last;
}

function panelContainsMarker(marker: string): boolean {
	const iframe = document.getElementById(
		"hot-reload-bundle_hr-panel_iframe",
	) as HTMLIFrameElement | null;
	return Boolean(iframe?.contentDocument?.body?.textContent?.includes(marker));
}

test(
	"extension hot reload replaces handlers exactly once and keeps replicant state",
	{ timeout: 30_000 },
	async ({ apis, dashboard, server }) => {
		// Sanity: the original extension responds with its original value.
		expect(await askExtension(dashboard, "hr-getValue")).toBe("original");
		expect(
			(server.getExtensions()[hrBundleName] as { response: string }).response,
		).toBe("original");

		// Set some replicant state that must survive the reload.
		const marker = apis.extension.Replicant<string | null>(
			"persist-marker",
			hrBundleName,
			{ defaultValue: null, persistent: false },
		);
		marker.value = "survives";

		// Baseline ping: increments pingCount to 1.
		expect(await askExtension(dashboard, "hr-ping")).toBe("original");
		await sleep(100);
		expect(apis.extension.readReplicant("pingCount", hrBundleName)).toBe(1);

		// Change the extension code on disk.
		replaceInFile(
			path.join(hrBundleDir(), "extension.js"),
			'"original"',
			'"updated"',
		);

		// The reload is debounced; poll until the new handler responds.
		expect(await waitForExtensionResponse(dashboard, "updated")).toBe(
			"updated",
		);

		// bundleUnloading was emitted to the old instance exactly once.
		expect(apis.extension.readReplicant("unloadCount", hrBundleName)).toBe(1);

		// Replicant state survived the reload.
		expect(apis.extension.readReplicant("persist-marker", hrBundleName)).toBe(
			"survives",
		);
		expect(apis.extension.readReplicant("pingCount", hrBundleName)).toBe(1);

		// The old handler is gone: one message fires the (new) handler
		// exactly once — the counter increments by exactly 1 and the response
		// carries the new content.
		expect(await askExtension(dashboard, "hr-ping")).toBe("updated");
		await sleep(250);
		expect(apis.extension.readReplicant("pingCount", hrBundleName)).toBe(2);

		// The extensions registry now holds the new extension export.
		expect(
			(server.getExtensions()[hrBundleName] as { response: string }).response,
		).toBe("updated");
	},
);

test(
	"dashboard panels automatically reload when their bundle changes",
	{ timeout: 30_000 },
	async ({ dashboard }) => {
		await dashboard.waitForFunction(panelContainsMarker, {}, "hr-marker-v1");

		replaceInFile(
			path.join(hrBundleDir(), "dashboard/panel.html"),
			"hr-marker-v1",
			"hr-marker-v2",
		);

		await dashboard.waitForFunction(panelContainsMarker, {}, "hr-marker-v2");
	},
);

test(
	"graphics are not automatically reloaded by default",
	{ timeout: 30_000 },
	async ({ browser }) => {
		const graphicPage = await browser.newPage();
		try {
			await graphicPage.goto(`${C.rootUrl()}bundles/${hrBundleName}/graphics/`);
			await graphicPage.waitForFunction(
				() => (window as any).__hrGraphicLoaded__ === true,
			);
			await graphicPage.evaluate(() => {
				(window as any).__notReloaded__ = true;
				(window as any).__dashboardRefreshSeen__ = false;
				window.socket.on("dashboard:bundleRefresh", (bundleName) => {
					if (bundleName === "hot-reload-bundle") {
						(window as any).__dashboardRefreshSeen__ = true;
					}
				});
			});

			// Trigger a BundleChanged for the graphic's bundle.
			replaceInFile(
				path.join(hrBundleDir(), "dashboard/panel.html"),
				"hr-marker-v2",
				"hr-marker-v3",
			);

			// The `dashboard:bundleRefresh` broadcast for this change proves
			// that the refresh cycle ran...
			await graphicPage.waitForFunction(
				() => (window as any).__dashboardRefreshSeen__ === true,
			);
			await sleep(1000);

			// ...but the graphic must NOT have been reloaded
			// (hotReload.graphics defaults to false).
			expect(
				await graphicPage.evaluate(() => (window as any).__notReloaded__),
			).toBe(true);
		} finally {
			await graphicPage.close();
		}
	},
);
