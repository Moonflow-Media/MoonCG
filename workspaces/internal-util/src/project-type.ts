import fs from "node:fs";
import path from "node:path";

import { getNearestProjectDirFromCwd } from "./find-nodejs-project.ts";

export type ProjectType = "standalone" | "monorepo" | "dependency";

let _cachedProjectType: ProjectType | undefined;

export function getProjectType(): ProjectType {
	if (_cachedProjectType === undefined) {
		const rootPackageJson: { name?: string; mooncgRoot?: boolean } = JSON.parse(
			fs.readFileSync(
				path.join(getNearestProjectDirFromCwd(), "package.json"),
				"utf-8",
			),
		);

		if (rootPackageJson.mooncgRoot === true) {
			_cachedProjectType = "monorepo";
		} else if (rootPackageJson.name === "mooncg") {
			_cachedProjectType = "standalone";
		} else {
			_cachedProjectType = "dependency";
			console.warn(
				"MoonCG is installed as a dependency. This is an experimental feature. Please report any issues you encounter.",
			);
		}
	}
	return _cachedProjectType;
}

export function isLegacyProject(): boolean {
	return getProjectType() !== "dependency";
}
