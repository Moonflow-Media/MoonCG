import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type * as puppeteer from "puppeteer";
import { expect } from "vitest";

import { setupTest } from "../helpers/setup";

const test = await setupTest("mooncg-hot-reload-off.json");

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

function panelContainsMarker(marker: string): boolean {
	const iframe = document.getElementById(
		"hot-reload-bundle_hr-panel_iframe",
	) as HTMLIFrameElement | null;
	return Boolean(iframe?.contentDocument?.body?.textContent?.includes(marker));
}

test(
	"panels are not reloaded when hotReload.dashboard is disabled",
	{ timeout: 30_000 },
	async ({ dashboard }) => {
		await dashboard.waitForFunction(panelContainsMarker, {}, "hr-marker-v1");

		replaceInFile(
			path.join(hrBundleDir(), "dashboard/panel.html"),
			"hr-marker-v1",
			"hr-marker-v2",
		);

		// Give the watcher, debounce, and a potential (unwanted) refresh
		// plenty of time...
		await sleep(3000);

		// ...the panel iframe must still show the old content.
		expect(await dashboard.evaluate(panelContainsMarker, "hr-marker-v1")).toBe(
			true,
		);
	},
);

test(
	"extensions are not reloaded when hotReload.extensions is disabled",
	{ timeout: 30_000 },
	async ({ dashboard }) => {
		expect(await askExtension(dashboard, "hr-getValue")).toBe("original");

		replaceInFile(
			path.join(hrBundleDir(), "extension.js"),
			'"original"',
			'"updated"',
		);

		await sleep(3000);

		expect(await askExtension(dashboard, "hr-getValue")).toBe("original");
	},
);
