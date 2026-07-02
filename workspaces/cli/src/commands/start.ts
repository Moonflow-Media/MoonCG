import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { pathContainsMoonCG } from "../lib/util.js";

export function startCommand(program: Command) {
	program
		.command("start")
		.option("-d, --disable-source-maps", "Disable source map support")
		.description("Start MoonCG")
		.action(async () => {
			const projectDir = recursivelyFindProject(process.cwd());

			// Check if mooncg is already installed
			if (pathContainsMoonCG(projectDir)) {
				await import(pathToFileURL(path.join(projectDir, "index.js")).href);
				return;
			}

			// Check if MoonCG is installed as a dependency
			const mooncgDependencyPath = path.join(projectDir, "node_modules/mooncg");
			if (pathContainsMoonCG(mooncgDependencyPath)) {
				await import(
					pathToFileURL(path.join(mooncgDependencyPath, "index.js")).href
				);
			}
		});
}

function recursivelyFindProject(startDir: string) {
	if (!path.isAbsolute(startDir)) {
		throw new Error("startDir must be an absolute path");
	}
	const packageJsonDir = path.join(startDir, "package.json");
	if (fs.existsSync(packageJsonDir)) {
		return startDir;
	}
	const parentDir = path.dirname(startDir);
	if (parentDir === startDir) {
		throw new Error("Could not find a project directory");
	}
	return recursivelyFindProject(parentDir);
}
