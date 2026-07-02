import fs from "node:fs";
import path from "node:path";

import type * as puppeteer from "puppeteer";
import { expect } from "vitest";

import type { MoonCG } from "../../src/types/mooncg";
import { setupTest } from "../helpers/setup";
import * as C from "../helpers/test-constants";

const test = await setupTest();

const UPLOAD_SOURCE_PATH = path.resolve(
	__dirname,
	"../fixtures/assets-to-upload/#twitter_banner.png",
);
const TWITTER_BANNER_PATH = path.join(
	C.assetsRoot(),
	"test-bundle/assets/#twitter_banner.png",
);
const INITIAL_FILE_PATH = path.join(
	C.assetsRoot(),
	"test-bundle/assets/initial.png",
);

test("picks up pre-existing files on startup", async ({ apis }) => {
	const assetRep =
		apis.extension.Replicant<MoonCG.AssetFile[]>("assets:assets");

	// Wait for replicant to have value
	await new Promise<void>((resolve) => {
		const handler = () => {
			if (assetRep.value && assetRep.value.length > 0) {
				assetRep.off("change", handler);
				resolve();
			}
		};
		if (assetRep.value && assetRep.value.length > 0) {
			resolve();
		} else {
			assetRep.on("change", handler);
		}
	});

	expect(fs.existsSync(INITIAL_FILE_PATH)).toBe(true);
	expect(assetRep.value).toHaveLength(1);
	expect(assetRep.value?.[0]).toMatchObject({
		name: "initial",
		category: "assets",
		namespace: "test-bundle",
	});
});

test.for([0, 1])(
	`uploading and re-uploading file`,
	async (i, { apis, dashboard }) => {
		const assetRep =
			apis.extension.Replicant<MoonCG.AssetFile[]>("assets:assets");

		// Make sure the file to upload does not exist first
		if (i === 0) {
			expect(fs.existsSync(TWITTER_BANNER_PATH)).toBe(false);
			// 1 file from pre-existing initial.png
			expect(assetRep.value ?? []).toHaveLength(1);
		} else {
			// Second upload: file already exists, verify replicant has initial + first upload
			expect(fs.existsSync(TWITTER_BANNER_PATH)).toBe(true);
			expect(assetRep.value ?? []).toHaveLength(2);
			expect(
				assetRep.value?.find((f) => f.name === "#twitter_banner"),
			).toBeTruthy();
		}

		await dashboard.bringToFront();
		await dashboard.click('[data-testid="tab-assets"]');
		const categorySelector =
			'[data-testid="asset-category-test-bundle-assets"]';
		await dashboard.waitForSelector(categorySelector);

		const uploadsBefore = await dashboard.$eval(categorySelector, (el) =>
			Number(el.getAttribute("data-successful-uploads")),
		);

		await dashboard.click(`${categorySelector} [data-testid="asset-add"]`);
		const fileInputEl: puppeteer.ElementHandle<HTMLInputElement> =
			(await dashboard.waitForSelector(
				`${categorySelector} [data-testid="asset-file-input"]`,
			)) as any;

		// Upload the file
		await fileInputEl.uploadFile(UPLOAD_SOURCE_PATH);

		// Wait for upload to complete on the server
		await dashboard.waitForFunction(
			(selector: string, expected: number) => {
				const el = document.querySelector(selector);
				return (
					Boolean(el) &&
					Number(el!.getAttribute("data-successful-uploads")) >= expected
				);
			},
			{},
			categorySelector,
			uploadsBefore + 1,
		);

		// Close the upload dialog again so it doesn't block later interactions.
		await dashboard.click(
			`${categorySelector} [data-testid="upload-dialog-close"]`,
		);

		expect(fs.existsSync(TWITTER_BANNER_PATH)).toBe(true);

		await new Promise<void>((resolve) => {
			let isInitial = true;
			const handler = () => {
				if (i === 0 && isInitial) {
					isInitial = false;
					return;
				}
				assetRep.off("change", handler);
				resolve();
			};
			assetRep.on("change", handler);
		});

		// Verify replicant was updated correctly (initial.png + #twitter_banner.png)
		expect(assetRep.value).toHaveLength(2);
		const uploadedFile = assetRep.value?.find(
			(f) => f.name === "#twitter_banner",
		);
		expect(uploadedFile).toMatchObject({
			name: "#twitter_banner",
			category: "assets",
			namespace: "test-bundle",
		});

		// On second upload, verify the change handler updated the existing entry
		// (not added a duplicate) and recalculated the hash
		if (i === 1) {
			expect(assetRep.value ?? []).toHaveLength(2); // Still only 2 files (initial + twitter_banner)
			expect(uploadedFile?.sum).toBeTruthy(); // Hash was recalculated
		}
	},
);

test("retrieval - 200", async () => {
	const response = await fetch(
		`${C.rootUrl()}assets/test-bundle/assets/%23twitter_banner.png`,
	);
	expect(response.status).toBe(200);
	expect((await response.arrayBuffer()).byteLength).toBe(
		fs.readFileSync(TWITTER_BANNER_PATH).length,
	);
});

test("retrieval - 404", async () => {
	const response = await fetch(
		`${C.rootUrl()}assets/test-bundle/assets/bad.png`,
	);
	expect(response.status).toBe(404);
});

test("deletion - 200", async ({ apis, dashboard }) => {
	const assetRep =
		apis.extension.Replicant<MoonCG.AssetFile[]>("assets:assets");

	// Should have 2 files: initial.png and #twitter_banner.png
	expect(assetRep.value).toHaveLength(2);

	await dashboard.bringToFront();
	await dashboard.click('[data-testid="tab-assets"]');

	// Find the #twitter_banner file specifically
	const deleteButton = await dashboard.waitForSelector(
		'[data-testid="asset-category-test-bundle-assets"]' +
			' [data-testid="asset-file"][data-file-name="#twitter_banner"]' +
			' [data-testid="asset-delete"]',
	);
	if (!deleteButton) {
		throw new Error("#twitter_banner asset file not found");
	}

	await deleteButton.click();

	// Wait for the replicant to reflect the deletion
	await new Promise<void>((resolve) => {
		const handler = () => {
			if (
				assetRep.value?.length === 1 &&
				!assetRep.value.some((f) => f.name === "#twitter_banner")
			) {
				assetRep.off("change", handler);
				resolve();
			}
		};
		if (
			assetRep.value?.length === 1 &&
			!assetRep.value.some((f) => f.name === "#twitter_banner")
		) {
			resolve();
		} else {
			assetRep.on("change", handler);
		}
	});

	expect(fs.existsSync(TWITTER_BANNER_PATH)).toBe(false);
	// initial.png should still exist
	expect(assetRep.value).toHaveLength(1);
	expect(assetRep.value?.[0]?.name).toBe("initial");
});

test("deletion - 410", async ({}) => {
	const response = await fetch(
		`${C.rootUrl()}assets/test-bundle/assets/bad.png`,
		{ method: "delete" },
	);
	expect(response.status).toBe(410);
});
