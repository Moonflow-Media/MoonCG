import { beforeEach, expect, test, vi } from "vitest";

import {
	createMockProgram,
	type MockCommand,
} from "../../test/mocks/program.ts";
import { startCommand } from "./start.ts";

let program: MockCommand;

beforeEach(() => {
	program = createMockProgram();
	startCommand(program);
});

test("should start MoonCG", async () => {
	const [port] = await Promise.all([
		vi.waitUntil(() => process.env["MOONCG_TEST_PORT"], { timeout: 5000 }),
		program.runWith("start"),
	]);
	expect(port).toBeTypeOf("string");
	expect(port).toMatch(/^\d+$/);
});
