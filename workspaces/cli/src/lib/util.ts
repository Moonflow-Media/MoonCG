import fs from "node:fs";
import path from "node:path";

/**
 * Checks if the given directory contains a MoonCG installation.
 * @param pathToCheck
 */
export function pathContainsMoonCG(pathToCheck: string): boolean {
	const pjsonPath = path.join(pathToCheck, "package.json");
	try {
		const pjson = JSON.parse(fs.readFileSync(pjsonPath, "utf-8"));
		return pjson.name.toLowerCase() === "mooncg";
	} catch {
		return false;
	}
}

/**
 * Gets the nearest MoonCG installation folder. First looks in process.cwd(), then looks
 * in every parent folder until reaching the root. Throws an error if no MoonCG installation
 * could be found.
 */
export function getMoonCGPath() {
	let curr = process.cwd();
	do {
		if (pathContainsMoonCG(curr)) {
			return curr;
		}

		const nextCurr = path.resolve(curr, "..");
		if (nextCurr === curr) {
			throw new Error(
				"MoonCG installation could not be found in this directory or any parent directory.",
			);
		}

		curr = nextCurr;
	} while (fs.lstatSync(curr).isDirectory());

	throw new Error(
		"MoonCG installation could not be found in this directory or any parent directory.",
	);
}

/**
 * Checks if the given directory is a MoonCG bundle.
 */
export function isBundleFolder(pathToCheck: string) {
	const pjsonPath = path.join(pathToCheck, "package.json");
	if (fs.existsSync(pjsonPath)) {
		const pjson = JSON.parse(fs.readFileSync(pjsonPath, "utf8"));
		return typeof pjson.mooncg === "object";
	}

	return false;
}

/**
 * Gets the currently-installed MoonCG version string, in the format "vX.Y.Z"
 */
export function getCurrentMoonCGVersion(): string {
	const mooncgPath = getMoonCGPath();
	return JSON.parse(fs.readFileSync(`${mooncgPath}/package.json`, "utf8"))
		.version;
}
