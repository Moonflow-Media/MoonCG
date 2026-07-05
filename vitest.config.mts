import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		env: {
			test: "true",
			MOONCG_TEST: "true",
		},
		coverage: {
			include: ["workspaces/*/src"],
			// *.tmpl are HTML/EJS templates the coverage remapper cannot parse
			exclude: [
				"workspaces/mooncg/src/client",
				"**/*.tmpl",
				"**/*.tsbuildinfo",
			],
		},
		maxWorkers: "50%",
		projects: [
			{
				test: {
					name: "unit",
					dir: "workspaces/mooncg/src",
				},
			},
			{
				test: {
					name: "e2e-legacy",
					dir: "workspaces/mooncg/test/legacy-mode",
					testTimeout: 15_000,
				},
			},
			{
				test: {
					name: "e2e-installed",
					dir: "workspaces/mooncg/test/installed-mode",
					testTimeout: 15_000,
				},
			},
			"workspaces/cli",
			"workspaces/database-adapter-sqlite-legacy",
			"workspaces/database-adapter-types",
			"workspaces/internal-util",
		],
	},
});
