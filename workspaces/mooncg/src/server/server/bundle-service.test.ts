import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Exit, PubSub, Scope, Stream } from "effect";
import { afterAll, beforeAll, expect, test } from "vitest";

import { testDirPath } from "../../../test/helpers/test-dir-path";
import { createTmpDir } from "../../../test/helpers/tmp-dir";
import { testEffect } from "../_effect/test-effect";
import type { BundleEvent, makeBundleService } from "./bundle-service";

const tmpDir = createTmpDir();

type BundleServiceApi = Effect.Effect.Success<
	ReturnType<typeof makeBundleService>
>;

let scope: Scope.CloseableScope;
let bundleService: BundleServiceApi;

beforeAll(async () => {
	process.env.MOONCG_ROOT = tmpDir;
	fs.cpSync(testDirPath("fixtures/bundle-manager"), tmpDir, {
		recursive: true,
	});

	// The symlink test can't run on Windows unless run with admin privs.
	// For some reason, creating symlinks on Windows requires admin.
	if (os.platform() !== "win32") {
		fs.symlinkSync(
			path.join(tmpDir, "change-panel-symlink-target"),
			path.join(tmpDir, "bundles/change-panel-symlink"),
		);
	}

	const mooncgConfig = {
		bundles: {
			disabled: ["test-disabled-bundle"],
		},
	};

	/**
	 * Delay import so that we have time to set process.env.MOONCG_ROOT first.
	 */
	const { makeBundleService } = await import("./bundle-service");

	scope = await Effect.runPromise(Scope.make());
	bundleService = await Effect.runPromise(
		makeBundleService({
			bundlesPaths: [
				path.join(tmpDir, "bundles"),
				path.join(tmpDir, "custom-bundles"),
			],
			cfgPath: path.join(tmpDir, "cfg"),
			mooncgVersion: "0.7.0",
			mooncgConfig,
		}).pipe(Scope.extend(scope)),
	);

	// Wait for Chokidar to finish its initial scan.
	await Effect.runPromise(
		bundleService.awaitReady.pipe(
			Effect.timeoutFail({
				duration: "15 seconds",
				onTimeout: () =>
					new Error(
						"Timed out while waiting for the bundle service to become ready.",
					),
			}),
		),
	);
}, 30_000);

afterAll(async () => {
	if (scope) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
	}

	try {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	} catch (error) {
		// Ignore error
		console.error(error);
	}
});

/**
 * Subscribes to bundle events and returns an effect that resolves with the
 * first event matching the given tags. Subscription happens eagerly, so
 * events published after this call are guaranteed to be observed.
 */
const subscribeToEvents = Effect.fn("subscribeToEvents")(function* (
	...tags: BundleEvent["_tag"][]
) {
	const subscription = yield* PubSub.subscribe(bundleService.subscribe);
	return Stream.fromQueue(subscription).pipe(
		Stream.filter((event) => tags.includes(event._tag)),
		Stream.runHead,
		Effect.flatten,
	);
});

test(
	"loader - should detect and load bundle configuration files",
	testEffect(
		Effect.gen(function* () {
			let bundle = yield* bundleService.find("config-test-json");
			expect(bundle?.config).toEqual({ bundleConfig: true });
			bundle = yield* bundleService.find("config-test-yaml");
			expect(bundle?.config).toEqual({ bundleConfig: true });
			bundle = yield* bundleService.find("config-test-js");
			expect(bundle?.config).toEqual({ bundleConfig: true });
		}),
	),
);

test(
	"loader - should not load bundles with a non-satisfactory mooncg.compatibleRange",
	testEffect(
		Effect.gen(function* () {
			const bundle = yield* bundleService.find("incompatible-range");
			expect(bundle).toBe(undefined);
		}),
	),
);

test(
	"loader - should not load a bundle that has been disabled",
	testEffect(
		Effect.gen(function* () {
			const bundle = yield* bundleService.find("test-disabled-bundle");
			expect(bundle).toBe(undefined);
		}),
	),
);

test(
	"loader - should not crash or load an invalid bundle",
	testEffect(
		Effect.gen(function* () {
			const bundle = yield* bundleService.find("node_modules");
			expect(bundle).toBe(undefined);
		}),
	),
);

test(
	"loader - should detect and load bundle located in custom bundle paths",
	testEffect(
		Effect.gen(function* () {
			const bundle = yield* bundleService.find("another-test-bundle");
			expect(bundle?.name).toBe("another-test-bundle");
		}),
	),
);

test(
	"watcher - should emit a change event when the manifest file changes",
	testEffect(
		Effect.gen(function* () {
			const firstEvent = yield* subscribeToEvents(
				"BundleChanged",
				"InvalidBundle",
			);

			const manifest = JSON.parse(
				fs.readFileSync(
					`${tmpDir}/bundles/change-manifest/package.json`,
					"utf8",
				),
			);
			manifest._changed = true;

			yield* Effect.sleep("100 millis");
			yield* Effect.sync(() => {
				fs.writeFileSync(
					`${tmpDir}/bundles/change-manifest/package.json`,
					JSON.stringify(manifest),
					"utf8",
				);
			});

			const event = yield* firstEvent;
			if (event._tag === "InvalidBundle") {
				throw new Error(
					`Received an "InvalidBundle" event for bundle "${event.bundle.name}": ${event.error.message}`,
				);
			}

			if (event._tag !== "BundleChanged") {
				throw new Error(`Unexpected event: ${event._tag}`);
			}

			expect(event.bundle.name).toBe("change-manifest");
		}),
	),
);

test(
	"watcher - should emit a change event when a panel HTML file changes",
	testEffect(
		Effect.gen(function* () {
			const firstEvent = yield* subscribeToEvents("BundleChanged");

			const panelPath = `${tmpDir}/bundles/change-panel/dashboard/panel.html`;
			let panel = fs.readFileSync(panelPath, "utf8");
			panel += "\n";
			yield* Effect.sync(() => {
				fs.writeFileSync(panelPath, panel);
			});

			const event = yield* firstEvent;
			if (event._tag !== "BundleChanged") {
				throw new Error(`Unexpected event: ${event._tag}`);
			}

			expect(event.bundle.name).toBe("change-panel");
		}),
	),
);

if (os.platform() !== "win32") {
	// This can't be tested on Windows unless run with admin privs.
	// For some reason, creating symlinks on Windows requires admin.
	test(
		"watcher - should detect panel HTML file changes when the bundle is symlinked",
		testEffect(
			Effect.gen(function* () {
				const firstEvent = yield* subscribeToEvents("BundleChanged");

				const panelPath = `${tmpDir}/bundles/change-panel-symlink/dashboard/panel.html`;
				let panel = fs.readFileSync(panelPath, "utf8");
				panel += "\n";
				yield* Effect.sync(() => {
					fs.writeFileSync(panelPath, panel);
				});

				const event = yield* firstEvent;
				if (event._tag !== "BundleChanged") {
					throw new Error(`Unexpected event: ${event._tag}`);
				}

				expect(event.bundle.name).toBe("change-panel-symlink");
			}),
		),
	);
}

test(
	"watcher - should reload the bundle's config when the bundle is reloaded due to a change",
	testEffect(
		Effect.gen(function* () {
			const firstEvent = yield* subscribeToEvents("BundleChanged");

			const manifest = JSON.parse(
				fs.readFileSync(`${tmpDir}/bundles/change-config/package.json`, "utf8"),
			);
			const config = JSON.parse(
				fs.readFileSync(`${tmpDir}/cfg/change-config.json`, "utf8"),
			);

			config._changed = true;
			manifest._changed = true;
			yield* Effect.sync(() => {
				fs.writeFileSync(
					`${tmpDir}/bundles/change-config/package.json`,
					JSON.stringify(manifest),
				);
				fs.writeFileSync(
					`${tmpDir}/cfg/change-config.json`,
					JSON.stringify(config),
				);
			});

			const event = yield* firstEvent;
			if (event._tag !== "BundleChanged") {
				throw new Error(`Unexpected event: ${event._tag}`);
			}

			expect(event.bundle.name).toBe("change-config");
			expect(event.bundle.config).toEqual({
				bundleConfig: true,
				_changed: true,
			});
		}),
	),
);

test(
	"watcher - should emit an `InvalidBundle` event when a panel HTML file is removed",
	testEffect(
		Effect.gen(function* () {
			const firstEvent = yield* subscribeToEvents("InvalidBundle");

			yield* Effect.sync(() => {
				fs.unlinkSync(`${tmpDir}/bundles/remove-panel/dashboard/panel.html`);
			});

			const event = yield* firstEvent;
			if (event._tag !== "InvalidBundle") {
				throw new Error(`Unexpected event: ${event._tag}`);
			}

			expect(event.bundle.name).toBe("remove-panel");
			expect(event.error.message).toBe(
				'Panel file "panel.html" in bundle "remove-panel" does not exist.',
			);
		}),
	),
);
