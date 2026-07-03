import fs from "node:fs";
import path from "node:path";

import { afterAll, expect, test } from "vitest";

import { createTmpDir } from "../../../test/helpers/tmp-dir";
import { purgeModuleCache } from "./module-cache";

// `require` resolves symlinks, so resolve them here too to make sure that
// the cache keys match the paths we assert on.
const tmpDir = fs.realpathSync(createTmpDir());

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("purges modules under a directory so that require re-reads them", () => {
	const bundleDir = path.join(tmpDir, "bundle-a");
	fs.mkdirSync(path.join(bundleDir, "extension"), { recursive: true });
	const entryPath = path.join(bundleDir, "extension", "index.js");
	const helperPath = path.join(bundleDir, "extension", "helper.js");
	fs.writeFileSync(helperPath, "module.exports = 'helper-v1';");
	fs.writeFileSync(
		entryPath,
		"module.exports = { value: 'v1', helper: require('./helper.js') };",
	);

	const first = require(entryPath);
	expect(first.value).toBe("v1");
	expect(first.helper).toBe("helper-v1");

	fs.writeFileSync(helperPath, "module.exports = 'helper-v2';");
	fs.writeFileSync(
		entryPath,
		"module.exports = { value: 'v2', helper: require('./helper.js') };",
	);

	// Without purging, require still returns the stale cached version.
	expect(require(entryPath).value).toBe("v1");

	purgeModuleCache(bundleDir);
	expect(require.cache[entryPath]).toBeUndefined();
	expect(require.cache[helperPath]).toBeUndefined();

	const second = require(entryPath);
	expect(second.value).toBe("v2");
	expect(second.helper).toBe("helper-v2");
});

test("removes purged modules from the children arrays of remaining modules", () => {
	const bundleDir = path.join(tmpDir, "bundle-b");
	fs.mkdirSync(bundleDir, { recursive: true });
	const outsidePath = path.join(tmpDir, "outside-parent.js");
	const childPath = path.join(bundleDir, "child.js");
	fs.writeFileSync(childPath, "module.exports = 'child';");
	fs.writeFileSync(
		outsidePath,
		`module.exports = require(${JSON.stringify(childPath)});`,
	);

	expect(require(outsidePath)).toBe("child");
	const parentModule = require.cache[outsidePath];
	expect(parentModule?.children.some((mod) => mod.id === childPath)).toBe(true);

	purgeModuleCache(bundleDir);

	// The parent module outside of the purged directory stays cached, but no
	// longer references the purged child.
	expect(require.cache[outsidePath]).toBe(parentModule);
	expect(parentModule?.children.some((mod) => mod.id === childPath)).toBe(
		false,
	);
	expect(require.cache[childPath]).toBeUndefined();
});

test("does not purge modules outside of the directory", () => {
	const bundleDir = path.join(tmpDir, "bundle-c");
	fs.mkdirSync(bundleDir, { recursive: true });
	const unrelatedPath = path.join(tmpDir, "unrelated.js");
	fs.writeFileSync(unrelatedPath, "module.exports = 'unrelated';");

	expect(require(unrelatedPath)).toBe("unrelated");
	purgeModuleCache(bundleDir);
	expect(require.cache[unrelatedPath]).toBeDefined();
});
