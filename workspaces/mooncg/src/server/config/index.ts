import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

import { rootPaths } from "@mooncg/internal-util";

import { loadConfig } from "./loader";

const { cfgPath } = parseArgs({
	options: { cfgPath: { type: "string" } },
	strict: false,
}).values;

const cfgDirectoryPath =
	(typeof cfgPath === "string" ? cfgPath : undefined) ??
	path.join(rootPaths.getRuntimeRoot(), "cfg");

// Make 'cfg' folder if it doesn't exist
if (!fs.existsSync(cfgDirectoryPath)) {
	fs.mkdirSync(cfgDirectoryPath, { recursive: true });
}

const { config, filteredConfig } = loadConfig(cfgDirectoryPath);
export { config, filteredConfig };

export const exitOnUncaught = config.exitOnUncaught;

// TODO: Remove this in the next major release
export const sentryEnabled = config.sentry?.enabled;
