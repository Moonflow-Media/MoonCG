import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let tempDir: string;
let originalCwd: string;

function writePackageJson(contents: object) {
	writeFileSync(
		path.join(tempDir, "package.json"),
		JSON.stringify(contents),
		"utf-8",
	);
}

describe("mooncgInstalledPath per project layout", () => {
	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(path.join(tmpdir(), "mooncg-root-paths-test-"));
		process.chdir(tempDir);
		vi.resetModules();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("standalone install (name 'mooncg') resolves to the runtime root", async () => {
		writePackageJson({ name: "mooncg", version: "2.6.4" });

		const { rootPaths, getProjectType } = await import("./main.js");

		expect(getProjectType()).toBe("standalone");
		expect(rootPaths.mooncgInstalledPath).toBe(rootPaths.runtimeRootPath);
	});

	test("monorepo root (mooncgRoot true) resolves to workspaces/mooncg", async () => {
		writePackageJson({ name: "mooncg-monorepo", mooncgRoot: true });

		const { rootPaths, getProjectType } = await import("./main.js");

		expect(getProjectType()).toBe("monorepo");
		expect(rootPaths.mooncgInstalledPath).toBe(
			path.join(rootPaths.runtimeRootPath, "workspaces/mooncg"),
		);
	});

	test("dependency install resolves to node_modules/mooncg", async () => {
		writePackageJson({ name: "my-mooncg-project", version: "1.0.0" });

		const { rootPaths, getProjectType } = await import("./main.js");

		expect(getProjectType()).toBe("dependency");
		expect(rootPaths.mooncgInstalledPath).toBe(
			path.join(rootPaths.runtimeRootPath, "node_modules/mooncg"),
		);
	});
});
