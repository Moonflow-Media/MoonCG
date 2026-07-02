import path from "node:path";

import * as E from "fp-ts/Either";
import { flow, pipe } from "fp-ts/function";
import * as IOE from "fp-ts/IOEither";
import * as O from "fp-ts/Option";

import type { MoonCG } from "../../types/mooncg";
import { readJsonFileSync } from "../util-fp/read-json-file-sync";
import { parseAssets } from "./assets";
import { parseBundleConfig, parseDefaults } from "./config";
import { parseExtension } from "./extension";
import { parseGit } from "./git";
import { parseGraphics } from "./graphics";
import { parseManifest } from "./manifest";
import { parseMounts } from "./mounts";
import { parsePanels } from "./panels";
import { parseSounds } from "./sounds";

const readBundlePackageJson = (bundlePath: string) =>
	pipe(
		bundlePath,
		(bundlePath: string) => path.join(bundlePath, "package.json"),
		readJsonFileSync,
		IOE.map((json) => json as MoonCG.PackageJSON),
		IOE.mapLeft((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return new Error(
					`Bundle at path ${bundlePath} does not contain a package.json!`,
				);
			}
			if (error instanceof SyntaxError) {
				return new Error(
					`${bundlePath}'s package.json is not valid JSON, please check it against a validator such as jsonlint.com`,
				);
			}
			return error;
		}),
	);

const parseBundleMooncgConfig = flow(
	(bundlePath: string) => path.join(bundlePath, "mooncg.config.js"),
	IOE.tryCatchK(require, E.toError),
	IOE.match(
		() => ({}),
		(config) => config.default || config,
	),
	IOE.fromIO,
	IOE.flatMap((config) => {
		if (
			typeof config !== "object" ||
			config === null ||
			Array.isArray(config)
		) {
			return IOE.left(new Error("mooncg.config.js must export an object"));
		}
		return IOE.right(config as MoonCG.MooncgBundleConfig);
	}),
);

export const parseBundle = (
	bundlePath: string,
	bundleCfg?: MoonCG.Bundle.UnknownConfig,
): MoonCG.Bundle => {
	const manifest = pipe(
		bundlePath,
		readBundlePackageJson,
		IOE.flatMap(parseManifest(bundlePath)),
		IOE.getOrElse((error) => {
			throw error;
		}),
	)();

	const dashboardDir = path.resolve(bundlePath, "dashboard");
	const graphicsDir = path.resolve(bundlePath, "graphics");

	const mooncgBundleConfig = pipe(
		parseBundleMooncgConfig(bundlePath),
		IOE.getOrElse((error) => {
			throw error;
		}),
	)();

	const config = pipe(
		bundleCfg,
		O.fromNullable,
		O.match(
			() => parseDefaults(manifest.name)(bundlePath),
			IOE.tryCatchK(
				(bundleCfg) => parseBundleConfig(manifest.name, bundlePath, bundleCfg),
				E.toError,
			),
		),
		IOE.getOrElse((error) => {
			throw error;
		}),
	)();

	const bundle: MoonCG.Bundle = {
		...manifest,
		dir: bundlePath,
		config,
		dashboard: {
			dir: dashboardDir,
			panels: parsePanels(dashboardDir, manifest),
		},
		mount: parseMounts(manifest),
		graphics: parseGraphics(graphicsDir, manifest),
		assetCategories: parseAssets(manifest),
		hasExtension: parseExtension(bundlePath, manifest),
		git: parseGit(bundlePath),
		...parseSounds(bundlePath, manifest),
		mooncgBundleConfig,
	};

	return bundle;
};
