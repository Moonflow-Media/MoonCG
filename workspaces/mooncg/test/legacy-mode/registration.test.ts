import { setTimeout } from "node:timers/promises";

import { expect } from "vitest";

import { setupTest } from "../helpers/setup";
import * as C from "../helpers/test-constants";
import * as util from "../helpers/utilities";

const test = await setupTest();

test("singleInstance - scripts get injected into /instance/*.html routes", async ({
	dashboard,
}) => {
	await dashboard.bringToFront();
	await dashboard.click('[data-testid="tab-graphics"]');

	const response = await fetch(`${C.rootUrl()}instance/killed.html`);
	expect(response.status).toBe(200);
	const body = await response.text();
	expect(body).toMatch('<script src="/api.js">');
	expect(body).toMatch('<script src="/socket.io/socket.io.js"></script>');
});

test(
	"singleInstance - should redirect to busy.html when the instance is already taken",
	{ skip: true },
	async ({ singleInstance, browser }) => {
		expect(singleInstance.url()).toMatch(
			"/bundles/test-bundle/graphics/single_instance.html",
		);
		const newPage = await browser.newPage();
		await newPage.goto(C.singleInstanceUrl());
		await newPage.waitForNetworkIdle();
		expect(newPage.url()).toMatch("/instance/busy.html");

		await singleInstance.goto("https://example.com");
		await newPage.goto(C.singleInstanceUrl());
		await newPage.waitForNetworkIdle();
		expect(newPage.url()).toBe(C.singleInstanceUrl());

		await newPage.close();
	},
);

test(
	"singleInstance - should redirect to killed.html when the instance is killed",
	{ skip: true },
	async ({ dashboard, singleInstance }) => {
		await dashboard.bringToFront();
		await dashboard.click('[data-testid="tab-graphics"]');

		const graphicBoard = await dashboard.waitForSelector(
			'[data-testid="graphics-bundle-test-bundle"] [data-graphic-url$="single_instance.html"]',
		);

		const expandButton: any = await dashboard.evaluateHandle(
			(el: any) => el.querySelector('[data-testid="graphic-collapse"]'),
			graphicBoard,
		);
		await expandButton.click();

		const button: any = await dashboard.evaluateHandle(
			(el: any) =>
				el.querySelector(
					'[data-testid="graphic-instance"] [data-testid="instance-kill"]',
				),
			graphicBoard,
		);
		await button.click();

		await singleInstance.bringToFront();

		await singleInstance.waitForFunction(
			(rootUrl: string) =>
				location.href ===
				`${rootUrl}instance/killed.html?pathname=/bundles/test-bundle/graphics/single_instance.html`,
			{},
			C.rootUrl(),
		);

		// wait for the registration system to clear the socket out, takes a second or so
		await setTimeout(2500);
	},
);

test("refresh all instances in a bundle", async ({ graphic, dashboard }) => {
	await util.waitForRegistration(graphic);

	await dashboard.bringToFront();
	await dashboard.click('[data-testid="tab-graphics"]');

	const reload = await dashboard.waitForSelector(
		'[data-testid="graphics-bundle-test-bundle"] [data-testid="bundle-reload-all"]',
	);
	await reload!.click();

	const confirm = await dashboard.waitForSelector(
		'[data-testid="graphics-bundle-test-bundle"] [data-testid="bundle-reload-all-confirm"]',
	);

	await Promise.all([confirm!.click(), graphic.waitForNavigation()]);

	const refreshMarker = await util.waitForRegistration(graphic);
	expect(refreshMarker).toBe(undefined);
});

test("refresh all instances of a graphic", async ({ graphic, dashboard }) => {
	await util.waitForRegistration(graphic);

	await dashboard.bringToFront();
	await dashboard.click('[data-testid="tab-graphics"]');

	const reload = await dashboard.waitForSelector(
		'[data-testid="graphic"] [data-testid="graphic-reload"]:not([disabled])',
	);
	if (!reload) {
		throw new Error("graphic reload button not found");
	}

	await Promise.all([reload.click(), graphic.waitForNavigation()]);

	const refreshMarker = await util.waitForRegistration(graphic);
	expect(refreshMarker).toBe(undefined);
});

test("refresh individual instance", async ({ graphic, dashboard }) => {
	await util.waitForRegistration(graphic);

	await dashboard.bringToFront();
	// The instance list may be collapsed (hidden), so the click is dispatched
	// directly on the DOM node instead of through Puppeteer's mouse emulation.
	const reload = await dashboard.waitForSelector(
		'[data-testid="graphic"] [data-testid="graphic-instance"]:last-of-type [data-testid="instance-reload"]',
	);
	if (!reload) {
		throw new Error("instance reload button not found");
	}

	await Promise.all([
		graphic.waitForNavigation(),
		// https://github.com/puppeteer/puppeteer/issues/6033#issuecomment-1129520106
		dashboard.evaluate((rel) => {
			(rel as HTMLElement).click();
		}, reload),
	]);

	const refreshMarker = await util.waitForRegistration(graphic);
	expect(refreshMarker).toBe(undefined);
});

test("dragging the graphic generates the correct url for obs", async ({
	dashboard,
}) => {
	await dashboard.bringToFront();
	await dashboard.click('[data-testid="tab-graphics"]');

	const graphicLink = await dashboard.waitForSelector(
		'[data-testid="graphic"] [data-testid="graphic-url"]',
	);
	if (!graphicLink) {
		throw new Error("graphic url link not found");
	}

	await dashboard.evaluateHandle((gl: HTMLElement) => {
		gl.addEventListener("dragstart", (ev: DragEvent) => {
			ev.preventDefault();

			if (!ev.dataTransfer) {
				return;
			}

			const data = ev.dataTransfer.getData("text/uri-list");
			console.log(data);
		});
	}, graphicLink as any);

	const linkBoundingBox = await graphicLink.boundingBox();
	if (!linkBoundingBox) {
		throw new Error("linkBoundingBox is null");
	}

	await dashboard.bringToFront();

	// Move mouse to centre of link and start dragging
	await dashboard.mouse.move(
		linkBoundingBox.x + linkBoundingBox.width / 2,
		linkBoundingBox.y + linkBoundingBox.height / 2,
	);
	await dashboard.mouse.down();

	const promise = new Promise<void>((resolve) => {
		dashboard.on("console", (msg) => {
			// This allows other console messages to come through while the test is running, as long as the required message comes through eventually
			if (
				msg.text() ===
				`${C.rootUrl()}bundles/test-bundle/graphics/index.html?layer-name=index&layer-height=720&layer-width=1280`
			) {
				resolve();
			}
		});
	});

	// Move to top left of screen over 10 ticks
	// Dragstart event should be called during this
	await dashboard.mouse.move(0, 0, { steps: 10 });

	await setTimeout(200);

	await promise;
});
