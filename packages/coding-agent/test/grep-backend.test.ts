import { describe, expect, it, vi } from "vitest";
import { createGrepToolDefinition, type GrepOperations } from "../src/core/tools/grep.js";
import { ensureTool } from "../src/utils/tools-manager.js";

vi.mock("../src/utils/tools-manager.js", () => ({
	ensureTool: vi.fn(async () => {
		throw new Error("ensureTool should not run for delegated grep");
	}),
}));

describe("grep delegated backend", () => {
	it("does not require local ripgrep before delegating grep", async () => {
		const operations: GrepOperations = {
			isDirectory: vi.fn(() => {
				throw new Error("isDirectory should not run for delegated grep");
			}),
			readFile: vi.fn(() => {
				throw new Error("readFile should not run for delegated grep");
			}),
			grep: vi.fn(async (request) => ({ output: `${request.path}: delegated` })),
		};
		const tool = createGrepToolDefinition("/bridge", { operations });

		const result = await tool.execute(
			"grep-test",
			{ pattern: "needle", path: "src" },
			undefined,
			undefined,
			{} as never,
		);

		expect(ensureTool).not.toHaveBeenCalled();
		expect(operations.grep).toHaveBeenCalledWith({
			pattern: "needle",
			path: "/bridge/src",
			glob: undefined,
			ignoreCase: undefined,
			literal: undefined,
			context: 0,
			limit: 100,
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "/bridge/src: delegated" });
	});
});
