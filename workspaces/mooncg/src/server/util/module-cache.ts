import path from "node:path";

import { isChildPath } from "./is-child-path.js";

/**
 * Removes all entries from the CommonJS `require.cache` whose file lives
 * inside the given directory, so that a subsequent `require` re-reads the
 * files from disk.
 *
 * In addition to deleting the cache entries themselves, the entries are
 * also removed from the `children` arrays of all remaining cached modules.
 * Without this, the deleted modules would be kept alive (and could leak)
 * via their parents.
 *
 * Note: this only works for CommonJS modules. ES modules (`import`) have no
 * invalidation mechanism in Node.js and therefore cannot be hot-reloaded.
 */
export function purgeModuleCache(dir: string): void {
	const cache = require.cache;
	const idsToPurge = new Set<string>();

	for (const id of Object.keys(cache)) {
		const cachedModule = cache[id];
		if (!cachedModule) {
			continue;
		}

		const filename = cachedModule.filename || id;
		if (!path.isAbsolute(filename)) {
			continue;
		}

		if (isChildPath(dir, filename)) {
			idsToPurge.add(id);
		}
	}

	if (idsToPurge.size === 0) {
		return;
	}

	// Clean up the `children` arrays of every remaining cached module, so
	// the purged modules are not retained through parent references.
	for (const id of Object.keys(cache)) {
		const cachedModule = cache[id];
		if (!cachedModule || cachedModule.children.length === 0) {
			continue;
		}

		cachedModule.children = cachedModule.children.filter(
			(child) => !idsToPurge.has(child.id),
		);
	}

	for (const id of idsToPurge) {
		delete cache[id];
	}
}
