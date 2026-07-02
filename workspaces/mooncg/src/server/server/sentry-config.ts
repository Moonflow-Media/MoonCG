import * as os from "node:os";
import * as path from "node:path";

import { rootPaths } from "@mooncg/internal-util";
import * as Sentry from "@sentry/node";
import { Effect, PubSub, Stream } from "effect";
import express from "express";

import type { MoonCG } from "../../types/mooncg.js";
import { config } from "../config/index.js";
import { authCheck } from "../util/authcheck.js";
import { mooncgPackageJson } from "../util/mooncg-package-json.js";
import { BundleEvent, type BundleService } from "./bundle-service.js";

const baseSentryConfig = {
	dsn: config.sentry.enabled ? config.sentry.dsn : "",
	serverName: os.hostname(),
	version: mooncgPackageJson.version,
};

export const sentryConfigRouter = Effect.fn("sentryConfigRouter")(function* (
	bundleService: BundleService,
) {
	const bundleMetadata: {
		name: string;
		git: MoonCG.Bundle.GitData;
		version: string;
	}[] = [];
	const app = express();

	yield* Effect.forkScoped(
		bundleService.awaitReady.pipe(
			Effect.andThen(() => bundleService.all()),
			Effect.andThen((bundles) =>
				Effect.sync(() => {
					Sentry.configureScope((scope) => {
						bundles.forEach((bundle) => {
							bundleMetadata.push({
								name: bundle.name,
								git: bundle.git,
								version: bundle.version,
							});
						});
						scope.setExtra("bundles", bundleMetadata);
					});
				}),
			),
		),
	);

	const bundleEventsSubscription = yield* PubSub.subscribe(
		bundleService.subscribe,
	);
	yield* Effect.forkScoped(
		Stream.fromQueue(bundleEventsSubscription).pipe(
			Stream.filter(BundleEvent.$is("GitChanged")),
			Stream.runForEach(({ bundle }) =>
				Effect.sync(() => {
					const metadataToUpdate = bundleMetadata.find(
						(data) => data.name === bundle.name,
					);
					if (!metadataToUpdate) {
						return;
					}

					metadataToUpdate.git = bundle.git;
					metadataToUpdate.version = bundle.version;
				}),
			),
		),
	);

	// Render a pre-configured Sentry instance for client pages that request it.
	app.get("/sentry.js", authCheck, (_req, res) => {
		res.type(".js");
		res.render(
			path.join(
				rootPaths.mooncgInstalledPath,
				"dist/server/templates/sentry.js.tmpl",
			),
			{
				baseSentryConfig,
				bundleMetadata,
			},
		);
	});

	return app;
});
