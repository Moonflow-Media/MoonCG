import path from "node:path";

import { getNearestProjectDirFromCwd } from "./find-nodejs-project.ts";
import { getProjectType } from "./project-type.ts";

let _cachedRuntimeRootPath: string | undefined;

function getRuntimeRootPath(): string {
	if (_cachedRuntimeRootPath === undefined) {
		_cachedRuntimeRootPath = getNearestProjectDirFromCwd();
	}
	return _cachedRuntimeRootPath;
}

let _cachedMooncgInstalledPath: string | undefined;

function getMooncgInstalledPath(): string {
	if (_cachedMooncgInstalledPath === undefined) {
		const runtimeRoot = getRuntimeRootPath();
		switch (getProjectType()) {
			case "monorepo":
				_cachedMooncgInstalledPath = path.join(
					runtimeRoot,
					"workspaces/mooncg",
				);
				break;
			case "standalone":
				_cachedMooncgInstalledPath = runtimeRoot;
				break;
			case "dependency":
				_cachedMooncgInstalledPath = path.join(
					runtimeRoot,
					"node_modules/mooncg",
				);
				break;
		}
	}
	return _cachedMooncgInstalledPath;
}

export const rootPaths = {
	get runtimeRootPath() {
		return getRuntimeRootPath();
	},
	get mooncgInstalledPath() {
		return getMooncgInstalledPath();
	},
	/**
	 * Allow overriding the runtime root path via environment variable mainly for tests
	 */
	getRuntimeRoot: () => {
		const { MOONCG_ROOT } = process.env;
		if (MOONCG_ROOT) {
			return MOONCG_ROOT;
		}
		return getRuntimeRootPath();
	},
};
