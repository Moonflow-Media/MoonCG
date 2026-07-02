import type * as Puppeteer from "puppeteer";

import type { MoonCG } from "../../src/types/mooncg";

export const waitOneTick = async (): Promise<void> =>
	new Promise((resolve) => {
		process.nextTick(resolve);
	});

export const waitForRegistration = async (
	page: Puppeteer.Page,
): Promise<unknown> => {
	const response = await page.evaluate(
		async () =>
			new Promise((resolve) => {
				if ((window as any).__mooncgRegistrationAccepted__) {
					finish();
				} else {
					window.addEventListener("mooncg-registration-accepted", finish);
				}

				function finish(): void {
					resolve((window as any).__refreshMarker__);
					(window as any).__refreshMarker__ = "__refreshMarker__";
				}
			}),
	);

	return response;
};

export function invokeAck(ack?: MoonCG.Acknowledgement, ...args: any[]): void {
	if (!ack) {
		throw new Error("no callback provided");
	}

	if (ack.handled) {
		throw new Error("cb already handled");
	}

	if (args.length > 0) {
		ack(...args);
		return;
	}

	ack();
}
