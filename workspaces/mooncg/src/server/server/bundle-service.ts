import fs from "node:fs";
import path from "node:path";

import { isLegacyProject, rootPaths } from "@mooncg/internal-util";
import { cosmiconfigSync as cosmiconfig } from "cosmiconfig";
import {
	Clock,
	Data,
	Deferred,
	Duration,
	Effect,
	Fiber,
	HashSet,
	Option,
	PubSub,
	Queue,
	Ref,
	Stream,
} from "effect";
import semver from "semver";

import type { MoonCG } from "../../types/mooncg.js";
import {
	getWatcher,
	listenToAdd,
	listenToChange,
	listenToError,
	listenToUnlink,
} from "../_effect/chokidar.js";
import { parseGit as parseBundleGit } from "../bundle-parser/git.js";
import { parseBundle } from "../bundle-parser/index.js";
import { isChildPath } from "../util/is-child-path.js";

/**
 * Milliseconds
 */
const READY_WAIT_THRESHOLD = 1000;

const blacklistedBundleDirectories = ["node_modules", "bower_components"];

export type BundleEvent = Data.TaggedEnum<{
	Ready: object;
	BundleChanged: { bundle: MoonCG.Bundle };
	GitChanged: { bundle: MoonCG.Bundle };
	InvalidBundle: { bundle: MoonCG.Bundle; error: Error };
	BundleRemoved: { bundleName: string };
}>;

export const BundleEvent = Data.taggedEnum<BundleEvent>();

export interface BundleServiceOptions {
	readonly bundlesPaths: readonly string[];
	readonly cfgPath: string;
	readonly mooncgVersion: string;
	readonly mooncgConfig: {
		readonly bundles?: {
			readonly enabled?: readonly string[] | null;
			readonly disabled?: readonly string[] | null;
		} | null;
	};
}

export const makeBundleService = Effect.fn("makeBundleService")(
	function* (options: BundleServiceOptions) {
		const { bundlesPaths, cfgPath, mooncgVersion, mooncgConfig } = options;

		const bundleRootPaths = isLegacyProject()
			? [...bundlesPaths]
			: [rootPaths.runtimeRootPath, ...bundlesPaths];

		const bundlesRef = yield* Ref.make<MoonCG.Bundle[]>([]);
		const pubsub = yield* PubSub.unbounded<BundleEvent>();
		const readySignal = yield* Deferred.make<void>();
		const lastAddTime = yield* Ref.make(yield* Clock.currentTimeMillis);
		const pendingChanges = yield* Ref.make(HashSet.empty<string>());
		const backoffFiber = yield* Ref.make(
			Option.none<Fiber.RuntimeFiber<void>>(),
		);
		const gitChangeFiber = yield* Ref.make(
			Option.none<Fiber.RuntimeFiber<void>>(),
		);
		const delayedChanges = yield* Queue.unbounded<string>();

		// Start up the watcher, but don't watch any files yet.
		// We'll add the files we want to watch as bundles are loaded.
		const watcher = yield* getWatcher([], {
			persistent: true,
			ignoreInitial: true,
			followSymlinks: true,
			ignored: [
				/\/.+___jb_.+___/, // Ignore temp files created by JetBrains IDEs
				/\/node_modules\//, // Ignore node_modules folders
				/\/bower_components\//, // Ignore bower_components folders
				/\/.+\.lock/, // Ignore lockfiles
			],
		});

		/**
		 * Returns a shallow-cloned array of all currently active bundles.
		 */
		const all = Effect.fn("BundleService.all")(function* () {
			const bundles = yield* Ref.get(bundlesRef);
			return bundles.slice(0);
		});

		/**
		 * Returns the bundle with the given name. undefined if not found.
		 */
		const find = Effect.fn("BundleService.find")(function* (name: string) {
			const bundles = yield* Ref.get(bundlesRef);
			return bundles.find((bundle) => bundle.name === name);
		});

		/**
		 * Removes a bundle with the given name from the internal list.
		 * Does nothing if no match found.
		 */
		const remove = Effect.fn("BundleService.remove")(function* (
			bundleName: string,
		) {
			const bundles = yield* Ref.get(bundlesRef);
			const index = bundles.findIndex((bundle) => bundle?.name === bundleName);
			if (index === -1) {
				return;
			}

			yield* Ref.set(
				bundlesRef,
				bundles.filter((_, i) => i !== index),
			);
			yield* PubSub.publish(pubsub, BundleEvent.BundleRemoved({ bundleName }));
		});

		/**
		 * Adds a bundle to the internal list, replacing any existing bundle
		 * with the same name.
		 */
		const add = Effect.fn("BundleService.add")(function* (
			bundle: MoonCG.Bundle,
		) {
			const existing = yield* find(bundle.name);
			if (existing) {
				yield* remove(bundle.name);
			}

			yield* Ref.update(bundlesRef, (bundles) => [...bundles, bundle]);
		});

		/**
		 * Checks if a given path is a panel HTML file of a given bundle.
		 */
		const isPanelHTMLFile = Effect.fn("BundleService.isPanelHTMLFile")(
			function* (bundleName: string, filePath: string) {
				const bundle = yield* find(bundleName);
				return (
					bundle?.dashboard.panels.some((panel) =>
						panel.path.endsWith(filePath),
					) ?? false
				);
			},
		);

		const runGitChanged = Effect.fn("BundleService.runGitChanged")(function* (
			bundleName: string,
		) {
			yield* Effect.sleep("250 millis");
			yield* Ref.set(gitChangeFiber, Option.none());

			const bundle = yield* find(bundleName);
			if (!bundle) {
				return;
			}

			bundle.git = yield* Effect.sync(() => parseBundleGit(bundle.dir));
			yield* PubSub.publish(pubsub, BundleEvent.GitChanged({ bundle }));
		});

		/**
		 * Functional equivalent of the old lodash `debounce` git change handler:
		 * only the most recent invocation within a 250ms window is processed.
		 */
		const debouncedGitChangeHandler = Effect.fn(
			"BundleService.debouncedGitChangeHandler",
		)(function* (bundleName: string) {
			const current = yield* Ref.get(gitChangeFiber);
			if (Option.isSome(current)) {
				yield* Fiber.interrupt(current.value);
			}

			const fiber = yield* Effect.forkScoped(runGitChanged(bundleName));
			yield* Ref.set(gitChangeFiber, Option.some(fiber));
		});

		const runBackoff = Effect.fn("BundleService.runBackoff")(function* () {
			yield* Effect.sleep("500 millis");
			yield* Ref.set(backoffFiber, Option.none());

			const changed = yield* Ref.getAndSet(
				pendingChanges,
				HashSet.empty<string>(),
			);
			for (const bundleName of changed) {
				yield* Effect.logDebug(
					`Backoff finished, emitting change event for ${bundleName}`,
				);
				yield* Queue.offer(delayedChanges, bundleName);
			}
		});

		/**
		 * Resets the backoff timer used to avoid event thrashing when many
		 * files change rapidly.
		 */
		const resetBackoffTimer = Effect.fn("BundleService.resetBackoffTimer")(
			function* () {
				const current = yield* Ref.get(backoffFiber);
				if (Option.isSome(current)) {
					yield* Fiber.interrupt(current.value);
				}

				const fiber = yield* Effect.forkScoped(runBackoff());
				yield* Ref.set(backoffFiber, Option.some(fiber));
			},
		);

		const processChange = Effect.fn("BundleService.processChange")(function* (
			bundleName: string,
		) {
			const bundle = yield* find(bundleName);

			// It's rare for `bundle` to be undefined here, but it can happen
			// when using black/whitelisting.
			if (!bundle) {
				return;
			}

			const backoffActive = yield* Ref.get(backoffFiber);
			if (Option.isSome(backoffActive)) {
				yield* Effect.logDebug(
					`Backoff active, delaying processing of change detected in ${bundleName}`,
				);
				yield* Ref.update(pendingChanges, HashSet.add(bundleName));
				yield* resetBackoffTimer();
				return;
			}

			yield* Effect.logDebug(`Processing change event for ${bundleName}`);
			yield* resetBackoffTimer();

			yield* Effect.try({
				try: () => parseBundle(bundle.dir, loadBundleCfg(cfgPath, bundle.name)),
				catch: (error) =>
					error instanceof Error ? error : new Error(String(error)),
			}).pipe(
				Effect.matchEffect({
					onSuccess: (reparsedBundle) =>
						add(reparsedBundle).pipe(
							Effect.andThen(
								PubSub.publish(
									pubsub,
									BundleEvent.BundleChanged({ bundle: reparsedBundle }),
								),
							),
						),
					onFailure: (error) =>
						Effect.logWarning(
							`Unable to handle the bundle "${bundleName}" change:\n${error.stack}`,
						).pipe(
							Effect.andThen(
								PubSub.publish(
									pubsub,
									BundleEvent.InvalidBundle({ bundle, error }),
								),
							),
						),
				}),
			);
		});

		/**
		 * Processes a bundle change after a 100ms delay, without blocking the
		 * caller (mirrors the old `setTimeout(..., 100)` behavior).
		 */
		const handleChange = Effect.fn("BundleService.handleChange")(function* (
			bundleName: string,
		) {
			yield* Effect.forkScoped(
				Effect.sleep("100 millis").pipe(
					Effect.andThen(() => processChange(bundleName)),
				),
			);
		});

		// Changes released from the backoff buffer are processed like regular
		// changes. A queue is used to break the reference cycle between the
		// backoff fiber and the change handler.
		yield* Effect.forkScoped(
			Stream.fromQueue(delayedChanges).pipe(
				Stream.runForEach((bundleName) => handleChange(bundleName)),
			),
		);

		const handleAddEvent = Effect.fn("BundleService.handleAddEvent")(function* (
			filePath: string,
		) {
			for (const bundlesPath of bundleRootPaths) {
				const bundleName = getParentProjectName(filePath, bundlesPath);
				if (!bundleName) {
					continue;
				}

				// In theory, the bundle parser would have thrown an error long before
				// this block would execute, because in order for us to be adding a
				// panel HTML file, that means that the file would have been missing,
				// which the parser does not allow and would throw an error for.
				// Just in case though, its here.
				if (yield* isPanelHTMLFile(bundleName, filePath)) {
					yield* handleChange(bundleName);
				} else if (isGitData(bundleName, filePath)) {
					yield* debouncedGitChangeHandler(bundleName);
				}

				const ready = yield* Deferred.isDone(readySignal);
				if (!ready) {
					yield* Ref.set(lastAddTime, yield* Clock.currentTimeMillis);
				}
			}
		});

		const handleChangeEvent = Effect.fn("BundleService.handleChangeEvent")(
			function* (filePath: string) {
				for (const bundlesPath of bundleRootPaths) {
					const bundleName = getParentProjectName(filePath, bundlesPath);
					if (!bundleName) {
						continue;
					}

					if (
						isManifest(bundleName, filePath) ||
						(yield* isPanelHTMLFile(bundleName, filePath))
					) {
						yield* handleChange(bundleName);
					} else if (isGitData(bundleName, filePath)) {
						yield* debouncedGitChangeHandler(bundleName);
					}
				}
			},
		);

		const handleUnlinkEvent = Effect.fn("BundleService.handleUnlinkEvent")(
			function* (filePath: string) {
				for (const bundlesPath of bundleRootPaths) {
					const bundleName = getParentProjectName(filePath, bundlesPath);
					if (!bundleName) {
						continue;
					}

					if (yield* isPanelHTMLFile(bundleName, filePath)) {
						// This will cause MoonCG to crash, because the parser will throw
						// an error due to a panel's HTML file no longer being present.
						yield* handleChange(bundleName);
					} else if (isGitData(bundleName, filePath)) {
						yield* debouncedGitChangeHandler(bundleName);
					}
				}
			},
		);

		// Subscribe to watcher events before any bundles (and thus watch paths)
		// are loaded, mirroring the old event handler registration order.
		const addStream = yield* listenToAdd(watcher);
		const changeStream = yield* listenToChange(watcher);
		const unlinkStream = yield* listenToUnlink(watcher);
		const errorStream = yield* listenToError(watcher);

		yield* Effect.forkScoped(
			addStream.pipe(Stream.runForEach((event) => handleAddEvent(event.path))),
		);
		yield* Effect.forkScoped(
			changeStream.pipe(
				Stream.runForEach((event) => handleChangeEvent(event.path)),
			),
		);
		yield* Effect.forkScoped(
			unlinkStream.pipe(
				Stream.runForEach((event) => handleUnlinkEvent(event.path)),
			),
		);
		yield* Effect.forkScoped(
			errorStream.pipe(
				Stream.runForEach((event) =>
					Effect.logError(
						event.error instanceof Error ? event.error.stack : event.error,
					),
				),
			),
		);

		const loadBundleAtPath = Effect.fn("BundleService.loadBundleAtPath")(
			function* (bundlePath: string) {
				const isDirectory = yield* Effect.sync(() =>
					fs.statSync(bundlePath).isDirectory(),
				);
				if (!isDirectory) {
					return;
				}

				// Prevent attempting to load unwanted directories.
				// Those specified above and all dot-prefixed.
				const bundleFolderName = path.basename(bundlePath);
				if (
					blacklistedBundleDirectories.includes(bundleFolderName) ||
					bundleFolderName.startsWith(".")
				) {
					return;
				}

				const bundlePackageJson: { name: string } = JSON.parse(
					yield* Effect.sync(() =>
						fs.readFileSync(path.join(bundlePath, "package.json"), "utf-8"),
					),
				);
				const bundleName = bundlePackageJson.name;

				if (mooncgConfig.bundles?.disabled?.includes(bundleName)) {
					yield* Effect.logDebug(
						`Not loading bundle ${bundleName} as it is disabled in config`,
					);
					return;
				}

				if (
					mooncgConfig.bundles?.enabled &&
					!mooncgConfig.bundles.enabled.includes(bundleName)
				) {
					yield* Effect.logDebug(
						`Not loading bundle ${bundleName} as it is not enabled in config`,
					);
					return;
				}

				yield* Effect.logDebug(`Loading bundle ${bundleName}`);

				// Parse each bundle and push the result onto the bundles array
				const bundle = yield* Effect.sync(() =>
					parseBundle(bundlePath, loadBundleCfg(cfgPath, bundleName)),
				);

				if (isLegacyProject()) {
					if (!bundle.compatibleRange) {
						yield* Effect.logError(
							`${bundle.name}'s package.json does not have a "mooncg.compatibleRange" property.`,
						);
						return;
					}

					// Check if the bundle is compatible with this version of MoonCG
					if (!semver.satisfies(mooncgVersion, bundle.compatibleRange)) {
						yield* Effect.logError(
							`${bundle.name} requires MoonCG version ${bundle.compatibleRange}, current version is ${mooncgVersion}`,
						);
						return;
					}
				}

				yield* Ref.update(bundlesRef, (bundles) => [...bundles, bundle]);

				// Use `chokidar` to watch for file changes within bundles.
				// Workaround for https://github.com/paulmillr/chokidar/issues/419
				// This workaround is necessary to fully support symlinks.
				// This is applied after the bundle has been validated and loaded.
				// Bundles that do not properly load upon startup are not recognized for updates.
				yield* Effect.sync(() => {
					watcher.add([
						path.join(bundlePath, ".git"), // Watch `.git` directories.
						path.join(bundlePath, "dashboard"), // Watch `dashboard` directories.
						path.join(bundlePath, "package.json"), // Watch each bundle's `package.json`.
					]);
				});
			},
		);

		const loadInitialBundles = Effect.fn("BundleService.loadInitialBundles")(
			function* () {
				for (const bundlesPath of bundleRootPaths) {
					yield* Effect.logTrace(`Loading bundles from ${bundlesPath}`);

					if (bundlesPath === rootPaths.runtimeRootPath) {
						yield* loadBundleAtPath(rootPaths.runtimeRootPath);
					} else if (fs.existsSync(bundlesPath)) {
						const bundleFolders = yield* Effect.sync(() =>
							fs.readdirSync(bundlesPath),
						);
						for (const bundleFolderName of bundleFolders) {
							yield* loadBundleAtPath(path.join(bundlesPath, bundleFolderName));
						}
					}
				}
			},
		);

		yield* loadInitialBundles();

		// Emit `Ready` once no `add` events have been observed for
		// READY_WAIT_THRESHOLD milliseconds (the old refreshable ready timer).
		const watchReady = Effect.fn("BundleService.watchReady")(function* () {
			let remaining = READY_WAIT_THRESHOLD;
			while (remaining > 0) {
				yield* Effect.sleep(Duration.millis(remaining));
				const last = yield* Ref.get(lastAddTime);
				const now = yield* Clock.currentTimeMillis;
				remaining = READY_WAIT_THRESHOLD - (now - last);
			}

			yield* Deferred.succeed(readySignal, undefined);
			yield* PubSub.publish(pubsub, BundleEvent.Ready());
		});

		yield* Effect.forkScoped(watchReady());

		return {
			all,
			find,
			add,
			remove,
			/**
			 * The PubSub that all bundle events are published to.
			 * Consume with `Stream.fromPubSub` or `PubSub.subscribe`.
			 */
			subscribe: pubsub,
			/**
			 * Resolves once the initial Chokidar scan has settled.
			 * Resolves immediately when the service is already ready.
			 */
			awaitReady: Deferred.await(readySignal),
		};
	},
	Effect.annotateLogs("module", "bundle-manager"),
);

export class BundleService extends Effect.Service<BundleService>()(
	"BundleService",
	{
		scoped: makeBundleService,
	},
) {}

/**
 * Checks if a given path is the manifest file for a given bundle.
 */
function isManifest(bundleName: string, filePath: string): boolean {
	return (
		path.dirname(filePath).endsWith(bundleName) &&
		path.basename(filePath) === "package.json"
	);
}

/**
 * Checks if a given path is in the .git dir of a bundle.
 */
function isGitData(bundleName: string, filePath: string): boolean {
	const regex = new RegExp(`${bundleName}\\${path.sep}\\.git`);
	return regex.test(filePath);
}

/**
 * Determines which config file to use for a bundle.
 */
function loadBundleCfg(
	cfgDir: string,
	bundleName: string,
): MoonCG.Bundle.UnknownConfig | undefined {
	try {
		const cc = cosmiconfig("mooncg", {
			searchPlaces: [
				`${bundleName}.json`,
				`${bundleName}.yaml`,
				`${bundleName}.yml`,
				`${bundleName}.js`,
				`${bundleName}.config.js`,
			],
			stopDir: cfgDir,
		});
		const result = cc.search(cfgDir);
		return result?.config;
	} catch (_: unknown) {
		throw new Error(
			`Config for bundle "${bundleName}" could not be read. Ensure that it is valid JSON, YAML, or CommonJS.`,
		);
	}
}

function getParentProjectName(
	changePath: string,
	rootPath: string,
): string | false {
	if (rootPath !== changePath && !isChildPath(rootPath, changePath)) {
		return false;
	}
	const filePath = path.join(changePath, "package.json");
	try {
		const fileContent = fs.readFileSync(filePath, "utf-8");
		try {
			const parsed: { name?: unknown } = JSON.parse(fileContent);
			return typeof parsed.name === "string" ? parsed.name : false;
		} catch {
			return false;
		}
	} catch {
		const parentDir = path.join(changePath, "..");
		if (parentDir === changePath) {
			return false;
		}
		return getParentProjectName(parentDir, rootPath);
	}
}
