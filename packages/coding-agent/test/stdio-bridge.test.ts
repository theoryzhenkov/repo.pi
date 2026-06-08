import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBridgeCwd } from "../src/bridge/stdio-server.ts";

describe("stdio bridge cwd resolution", () => {
	let baseDir: string;
	let outsideDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "pi-bridge-base-"));
		outsideDir = mkdtempSync(join(tmpdir(), "pi-bridge-outside-"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});

	it("uses the bridge process cwd by default", async () => {
		await expect(resolveBridgeCwd(undefined, baseDir)).resolves.toBe(baseDir);
	});

	it("rejects caller absolute cwd outside the bridge cwd", async () => {
		await expect(resolveBridgeCwd(outsideDir, baseDir)).resolves.toBe(baseDir);
	});

	it("accepts an existing bridge-local cwd", async () => {
		const nested = join(baseDir, "nested");
		mkdirSync(nested);

		await expect(resolveBridgeCwd(nested, baseDir)).resolves.toBe(nested);
	});

	it("rejects non-directory bridge-local cwd", async () => {
		const filePath = join(baseDir, "file.txt");
		writeFileSync(filePath, "not a directory");

		await expect(resolveBridgeCwd(filePath, baseDir)).resolves.toBe(baseDir);
	});
});
