import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockProgram, MockCommand } from "../../test/mocks/program.js";
import { setupTmpDir } from "../../test/tmp-dir.js";
import { defaultconfigCommand } from "./defaultconfig.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

let program: MockCommand;

beforeEach(() => {
	// Set up environment.
	const tempFolder = setupTmpDir();
	process.env["MOONCG_ROOT"] = tempFolder;
	process.chdir(tempFolder);
	fs.writeFileSync("package.json", JSON.stringify({ name: "mooncg" }));

	// Copy fixtures.
	fs.cpSync(path.resolve(dirname, "../../test/fixtures/"), "./", {
		recursive: true,
	});

	// Build program.
	program = createMockProgram();
	defaultconfigCommand(program);
});

describe("when run with a bundle argument", () => {
	it("should successfully create a bundle config file when bundle has configschema.json", async () => {
		await program.runWith("defaultconfig config-schema");
		const config = JSON.parse(
			fs.readFileSync("./cfg/config-schema.json", { encoding: "utf8" }),
		);
		expect(config.username).toBe("user");
		expect(config.value).toBe(5);
		expect(config.nodefault).toBeUndefined();
	});

	it("should print an error when the target bundle does not have a configschema.json", async () => {
		const spy = vi.spyOn(console, "error");
		fs.mkdirSync(
			path.resolve(process.cwd(), "./bundles/missing-schema-bundle"),
			{ recursive: true },
		);
		fs.writeFileSync(
			"./bundles/missing-schema-bundle/package.json",
			JSON.stringify({
				name: "missing-schema-bundle",
				mooncg: { compatibleRange: "^2.0.0" },
			}),
		);
		await program.runWith("defaultconfig missing-schema-bundle");
		expect(spy.mock.calls[0]).toMatchInlineSnapshot(
			`
			[
			  "Error: Bundle missing-schema-bundle does not have a configschema.json",
			]
		`,
		);
		spy.mockRestore();
	});

	it("should print an error when the target bundle does not exist", async () => {
		const spy = vi.spyOn(console, "error");
		await program.runWith("defaultconfig not-installed");
		expect(spy.mock.calls[0]).toMatchInlineSnapshot(
			`
			[
			  "Error: Bundle not-installed does not exist",
			]
		`,
		);
		spy.mockRestore();
	});

	it("should print an error when the target bundle already has a config", async () => {
		const spy = vi.spyOn(console, "error");
		fs.mkdirSync("./cfg");
		fs.writeFileSync(
			"./cfg/config-schema.json",
			JSON.stringify({ fake: "data" }),
		);
		await program.runWith("defaultconfig config-schema");
		expect(spy.mock.calls[0]).toMatchInlineSnapshot(
			`
			[
			  "Error: Bundle config-schema already has a config file",
			]
		`,
		);
		spy.mockRestore();
	});

	it("should overwrite an existing bundle config when --force is passed", async () => {
		fs.mkdirSync("./cfg");
		fs.writeFileSync(
			"./cfg/config-schema.json",
			JSON.stringify({ fake: "data" }),
		);
		await program.runWith("defaultconfig config-schema --force");
		const config = JSON.parse(
			fs.readFileSync("./cfg/config-schema.json", { encoding: "utf8" }),
		);
		expect(config.fake).toBeUndefined();
		expect(config.username).toBe("user");
	});
});

// The real mooncg workspace package, linked into temp projects so the command
// can load the built "mooncg/config-schema" module from it.
const mooncgWorkspaceDir = path.resolve(dirname, "../../../mooncg");

describe("when run with --mooncg", () => {
	beforeEach(() => {
		fs.mkdirSync("./node_modules", { recursive: true });
		fs.symlinkSync(
			mooncgWorkspaceDir,
			path.resolve("./node_modules/mooncg"),
			"junction",
		);
	});

	it("should create cfg/mooncg.json (and the cfg dir) with all schema defaults", async () => {
		expect(fs.existsSync("./cfg")).toBe(false);
		await program.runWith("defaultconfig --mooncg");
		const config = JSON.parse(
			fs.readFileSync("./cfg/mooncg.json", { encoding: "utf8" }),
		);

		expect(config.host).toBe("0.0.0.0");
		expect(config.port).toBe(9090);
		expect(config.exitOnUncaught).toBe(true);

		expect(config.logging.console.enabled).toBe(true);
		expect(config.logging.console.level).toBe("info");
		expect(config.logging.file.enabled).toBe(false);
		expect(config.logging.file.path).toBe("logs/mooncg.log");

		expect(config.bundles.enabled).toBeNull();
		expect(config.bundles.disabled).toBeNull();
		expect(config.bundles.paths).toEqual([]);

		expect(config.login.enabled).toBe(false);
		expect(config.login.sessionTTL).toBe(604800);
		expect(config.login.steam.enabled).toBe(false);
		expect(config.login.steam.allowedIds).toEqual([]);
		expect(config.login.twitch.enabled).toBe(false);
		expect(config.login.twitch.scope).toBe("user_read");
		expect(config.login.discord.enabled).toBe(false);
		expect(config.login.discord.scope).toBe("identify");
		expect(config.login.local.enabled).toBe(false);
		expect(config.login.local.allowedUsers).toEqual([]);

		expect(config.ssl.enabled).toBe(false);
		expect(config.ssl.allowHTTP).toBe(false);

		expect(config.hotReload.dashboard).toBe(true);
		expect(config.hotReload.graphics).toBe(false);
		expect(config.hotReload.extensions).toBe(true);

		expect(config.sentry.enabled).toBe(false);

		// baseURL has no static default (derived from host/port at runtime),
		// so it must not be written to the config file.
		expect(config.baseURL).toBeUndefined();
	});

	it("should generate a config that passes the real MoonCG config schema", async () => {
		await program.runWith("defaultconfig --mooncg");
		const config = JSON.parse(
			fs.readFileSync("./cfg/mooncg.json", { encoding: "utf8" }),
		);

		const projectRequire = createRequire(
			path.join(process.cwd(), "package.json"),
		);
		const schemaModule = projectRequire("mooncg/config-schema") as {
			mooncgConfigSchema: {
				safeParse: (value: unknown) => { success: boolean };
			};
		};
		expect(schemaModule.mooncgConfigSchema.safeParse(config).success).toBe(
			true,
		);
	});

	it("should print an error when cfg/mooncg.json already exists", async () => {
		const spy = vi.spyOn(console, "error");
		fs.mkdirSync("./cfg");
		fs.writeFileSync("./cfg/mooncg.json", JSON.stringify({ port: 1234 }));
		await program.runWith("defaultconfig --mooncg");
		expect(spy.mock.calls[0]).toMatchInlineSnapshot(
			`
			[
			  "Error: cfg/mooncg.json already exists. Use --force to overwrite it.",
			]
		`,
		);
		const config = JSON.parse(
			fs.readFileSync("./cfg/mooncg.json", { encoding: "utf8" }),
		);
		expect(config.port).toBe(1234);
		spy.mockRestore();
	});

	it("should overwrite an existing cfg/mooncg.json when --force is passed", async () => {
		fs.mkdirSync("./cfg");
		fs.writeFileSync("./cfg/mooncg.json", JSON.stringify({ port: 1234 }));
		await program.runWith("defaultconfig --mooncg --force");
		const config = JSON.parse(
			fs.readFileSync("./cfg/mooncg.json", { encoding: "utf8" }),
		);
		expect(config.port).toBe(9090);
	});
});

describe("when run with --mooncg in a project without MoonCG", () => {
	it("should print an error when the MoonCG config schema cannot be loaded", async () => {
		const spy = vi.spyOn(console, "error");
		await program.runWith("defaultconfig --mooncg");
		expect(spy.mock.calls[0]).toMatchInlineSnapshot(
			`
			[
			  "Error: Could not load the MoonCG config schema. Is a current version of MoonCG installed in this project?",
			]
		`,
		);
		expect(fs.existsSync("./cfg/mooncg.json")).toBe(false);
		spy.mockRestore();
	});
});

describe("when run with --mooncg in a monorepo-mode project without a node_modules link", () => {
	beforeEach(() => {
		// Monorepo mode: root package.json has mooncgRoot: true and the MoonCG
		// installation lives at <root>/workspaces/mooncg. No node_modules link
		// exists, so the command must fall back to loading the schema module
		// straight from the installation directory.
		const tempFolder = setupTmpDir();
		process.env["MOONCG_ROOT"] = tempFolder;
		process.chdir(tempFolder);
		fs.writeFileSync(
			"package.json",
			JSON.stringify({ name: "my-monorepo", mooncgRoot: true }),
		);
		fs.mkdirSync("./workspaces", { recursive: true });
		fs.symlinkSync(
			mooncgWorkspaceDir,
			path.resolve("./workspaces/mooncg"),
			"junction",
		);

		program = createMockProgram();
		defaultconfigCommand(program);
	});

	it("should load the schema from workspaces/mooncg and create cfg/mooncg.json", async () => {
		await program.runWith("defaultconfig --mooncg");
		const config = JSON.parse(
			fs.readFileSync("./cfg/mooncg.json", { encoding: "utf8" }),
		);
		expect(config.host).toBe("0.0.0.0");
		expect(config.port).toBe(9090);
	});
});

describe("when run with no arguments", () => {
	it("should successfully create a bundle config file when run from inside bundle directory", async () => {
		process.chdir("./bundles/config-schema");
		await program.runWith("defaultconfig");
		expect(fs.existsSync("../../cfg/config-schema.json")).toBe(true);
	});

	it("should print an error when in a folder with no package.json", async () => {
		fs.mkdirSync(path.resolve(process.cwd(), "./bundles/not-a-bundle"), {
			recursive: true,
		});
		process.chdir("./bundles/not-a-bundle");

		const spy = vi.spyOn(console, "error");
		await program.runWith("defaultconfig");
		expect(spy.mock.calls[0]).toMatchInlineSnapshot(
			`
			[
			  "Error: No bundle found in the current directory!",
			]
		`,
		);
		spy.mockRestore();
	});
});

describe("installed mode (MoonCG as dependency)", () => {
	beforeEach(() => {
		// Set up installed mode environment.
		const tempFolder = setupTmpDir();
		process.env["MOONCG_ROOT"] = tempFolder;
		process.chdir(tempFolder);

		// Root is a bundle project with mooncg field
		fs.writeFileSync(
			"package.json",
			JSON.stringify({
				name: "my-awesome-bundle",
				mooncg: { compatibleRange: "^2.0.0" },
			}),
		);

		// Create configschema.json in root
		fs.writeFileSync(
			"configschema.json",
			JSON.stringify({
				type: "object",
				properties: {
					installedMode: { type: "boolean", default: true },
					value: { type: "number", default: 42 },
				},
			}),
		);

		// Build program.
		program = createMockProgram();
		defaultconfigCommand(program);
	});

	it("should create config for root bundle when bundle name matches root package", async () => {
		await program.runWith("defaultconfig my-awesome-bundle");
		const config = JSON.parse(
			fs.readFileSync("./cfg/my-awesome-bundle.json", { encoding: "utf8" }),
		);
		expect(config.installedMode).toBe(true);
		expect(config.value).toBe(42);
	});

	it("should create config for root bundle when run with no arguments", async () => {
		await program.runWith("defaultconfig");
		expect(fs.existsSync("./cfg/my-awesome-bundle.json")).toBe(true);
		const config = JSON.parse(
			fs.readFileSync("./cfg/my-awesome-bundle.json", { encoding: "utf8" }),
		);
		expect(config.installedMode).toBe(true);
	});

	it("should still check bundles directory when bundle name doesn't match root", async () => {
		// Create a bundle in bundles directory
		fs.mkdirSync("./bundles/another-bundle", { recursive: true });
		fs.writeFileSync(
			"./bundles/another-bundle/package.json",
			JSON.stringify({
				name: "another-bundle",
				mooncg: { compatibleRange: "^2.0.0" },
			}),
		);
		fs.writeFileSync(
			"./bundles/another-bundle/configschema.json",
			JSON.stringify({
				type: "object",
				properties: {
					fromBundlesDir: { type: "boolean", default: true },
				},
			}),
		);

		await program.runWith("defaultconfig another-bundle");
		const config = JSON.parse(
			fs.readFileSync("./cfg/another-bundle.json", { encoding: "utf8" }),
		);
		expect(config.fromBundlesDir).toBe(true);
	});
});
