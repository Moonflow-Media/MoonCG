import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { rootPaths } from "@mooncg/internal-util";
import { Ajv, type JSONSchemaType } from "ajv";
import chalk from "chalk";
import { Command } from "commander";

import { isBundleFolder } from "../lib/util.js";

const ajv = new Ajv({ useDefaults: true, strict: true });

interface DefaultconfigOptions {
	mooncg?: boolean;
	force?: boolean;
}

export function defaultconfigCommand(program: Command) {
	program
		.command("defaultconfig [bundle]")
		.description(
			"Generate a bundle's default config from its configschema.json, or MoonCG's own default config (cfg/mooncg.json) with --mooncg",
		)
		.option(
			"--mooncg",
			"Generate MoonCG's own default config at cfg/mooncg.json instead of a bundle config",
		)
		.option("-f, --force", "Overwrite the config file if it already exists")
		.action(action);
}

function getBundlePath(bundleName: string): string | null {
	const rootPath = rootPaths.getRuntimeRoot();

	// Check if root project itself is the bundle
	if (isBundleFolder(rootPath)) {
		try {
			const rootPjsonPath = path.join(rootPath, "package.json");
			const rootPjson = JSON.parse(fs.readFileSync(rootPjsonPath, "utf8"));
			if (rootPjson.name === bundleName) {
				return rootPath;
			}
		} catch {
			// Ignore JSON parse errors
		}
	}

	// Otherwise check bundles directory
	const bundlesPath = path.join(rootPath, "bundles", bundleName);
	if (isBundleFolder(bundlesPath)) {
		return bundlesPath;
	}

	return null;
}

function action(bundleName: string | undefined, options: DefaultconfigOptions) {
	if (options.mooncg) {
		createMooncgDefaultConfig(options.force ?? false);
		return;
	}

	const cwd = process.cwd();
	const rootPath = rootPaths.getRuntimeRoot();

	let resolvedBundleName: string;

	if (!bundleName) {
		// Check if cwd is a bundle
		if (isBundleFolder(cwd)) {
			const pjson = JSON.parse(
				fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
			);
			resolvedBundleName = pjson.name;
		} else if (isBundleFolder(rootPath)) {
			// Check if root project is a bundle (installed mode)
			const pjson = JSON.parse(
				fs.readFileSync(path.join(rootPath, "package.json"), "utf8"),
			);
			resolvedBundleName = pjson.name;
		} else {
			console.error(
				`${chalk.red("Error:")} No bundle found in the current directory!`,
			);
			return;
		}
	} else {
		resolvedBundleName = bundleName;
	}

	const bundlePath = getBundlePath(resolvedBundleName);
	if (!bundlePath) {
		console.error(
			`${chalk.red("Error:")} Bundle ${resolvedBundleName} does not exist`,
		);
		return;
	}

	const schemaPath = path.join(bundlePath, "configschema.json");
	if (!fs.existsSync(schemaPath)) {
		console.error(
			`${chalk.red("Error:")} Bundle ${resolvedBundleName} does not have a configschema.json`,
		);
		return;
	}

	const cfgPath = path.join(rootPath, "cfg");
	if (!fs.existsSync(cfgPath)) {
		fs.mkdirSync(cfgPath);
	}

	const schema: JSONSchemaType<unknown> = JSON.parse(
		fs.readFileSync(schemaPath, "utf8"),
	);
	const configPath = path.join(cfgPath, `${resolvedBundleName}.json`);
	if (fs.existsSync(configPath) && !options.force) {
		console.error(
			`${chalk.red("Error:")} Bundle ${resolvedBundleName} already has a config file`,
		);
	} else {
		try {
			const validate = ajv.compile(schema);
			const data = {};
			validate(data);

			fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
			console.log(
				`${chalk.green("Success:")} Created ${chalk.bold(resolvedBundleName)}'s default config from schema\n`,
			);
		} catch (error) {
			console.error(chalk.red("Error:"), error);
		}
	}
}

function createMooncgDefaultConfig(force: boolean) {
	const rootPath = rootPaths.getRuntimeRoot();

	let getDefaultMooncgConfig: () => Record<string, unknown>;
	try {
		getDefaultMooncgConfig = loadGetDefaultMooncgConfig(rootPath);
	} catch {
		console.error(
			`${chalk.red("Error:")} Could not load the MoonCG config schema. Is a current version of MoonCG installed in this project?`,
		);
		return;
	}

	const configPath = path.join(rootPath, "cfg", "mooncg.json");
	if (fs.existsSync(configPath) && !force) {
		console.error(
			`${chalk.red("Error:")} cfg/mooncg.json already exists. Use --force to overwrite it.`,
		);
		return;
	}

	try {
		const defaultConfig = getDefaultMooncgConfig();
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
		console.log(
			`${chalk.green("Success:")} Created default MoonCG config at ${chalk.bold(configPath)}\n`,
		);
	} catch (error) {
		console.error(chalk.red("Error:"), error);
	}
}

/**
 * Resolves the directory of the MoonCG installation that the given project
 * root uses. Mirrors the project-type detection of `@mooncg/internal-util`
 * (project-type.ts), but is keyed off the passed root path instead of using
 * `rootPaths.mooncgInstalledPath`, because the latter caches `process.cwd()`
 * at first access and ignores the `MOONCG_ROOT` override.
 */
function resolveMooncgInstallPath(rootPath: string): string {
	try {
		const pjson: { name?: string; mooncgRoot?: boolean } = JSON.parse(
			fs.readFileSync(path.join(rootPath, "package.json"), "utf8"),
		);
		if (pjson.mooncgRoot === true) {
			// Monorepo mode: the installation lives in the mooncg workspace.
			return path.join(rootPath, "workspaces/mooncg");
		}
		if (pjson.name === "mooncg") {
			// Legacy standalone mode: the project root itself is the installation.
			return rootPath;
		}
	} catch {
		// Fall through to dependency mode.
	}

	// Installed mode: MoonCG is a dependency of the project.
	return path.join(rootPath, "node_modules/mooncg");
}

/**
 * Loads the `getDefaultMooncgConfig` helper from the MoonCG installation that
 * the target project uses, so the defaults always come from the installed
 * version's real Zod schema instead of being hardcoded in the CLI.
 */
function loadGetDefaultMooncgConfig(
	rootPath: string,
): () => Record<string, unknown> {
	const projectRequire = createRequire(path.join(rootPath, "package.json"));

	let schemaModule: unknown;
	try {
		// Resolve through node_modules — covers installed mode as well as any
		// setup where npm has linked the mooncg package (e.g. workspaces).
		schemaModule = projectRequire("mooncg/config-schema");
	} catch {
		// No node_modules resolution available: load the module straight from
		// the MoonCG installation directory (standalone or monorepo layouts).
		schemaModule = projectRequire(
			path.join(
				resolveMooncgInstallPath(rootPath),
				"dist/server/config-schema.js",
			),
		);
	}

	const candidate = (schemaModule as { getDefaultMooncgConfig?: unknown })
		.getDefaultMooncgConfig;
	if (typeof candidate !== "function") {
		throw new Error(
			"MoonCG installation does not provide getDefaultMooncgConfig",
		);
	}

	return candidate as () => Record<string, unknown>;
}
