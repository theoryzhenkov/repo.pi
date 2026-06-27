import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionContext, ToolBackend, ToolBackendCapabilities } from "../src/core/execution-context.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashOperations, ToolsOptions } from "../src/core/tools/index.ts";

class CapturingBackend implements ToolBackend {
	readonly id = "capture";
	readonly kind = "test";
	readonly capabilities: ToolBackendCapabilities = { read: true, write: true, edit: true, bash: true };
	disposed = false;
	readPath: string | undefined;

	createToolOptions(_ctx: ExecutionContext): ToolsOptions {
		return {
			read: {
				operations: {
					access: async (path) => {
						this.readPath = path;
					},
					readFile: async (path) => {
						this.readPath = path;
						return Buffer.from("bridged content");
					},
				},
			},
		};
	}

	createBashOperations(_ctx: ExecutionContext): BashOperations {
		return {
			exec: async () => ({ exitCode: 0 }),
		};
	}

	dispose(): void {
		this.disposed = true;
	}
}

function createContext(cwd: string, backend: CapturingBackend): ExecutionContext {
	return {
		id: "capture",
		label: "capturing bridge",
		cwd,
		backend,
		capabilities: backend.capabilities,
	};
}

describe("AgentSession execution context switching", () => {
	let tempDir: string;
	let remoteDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-execution-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");
		mkdirSync(remoteDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rebuilds built-in tools when the execution context changes", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const backend = new CapturingBackend();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		session.setExecutionContext(createContext(remoteDir, backend));

		const readTool = session.getToolDefinition("read");
		expect(readTool).toBeDefined();
		const result = await readTool!.execute("read-1", { path: "file.txt" }, undefined, undefined, {
			model: session.model,
		} as never);

		expect(backend.readPath).toBe(join(remoteDir, "file.txt"));
		expect(result.content[0]).toMatchObject({ type: "text", text: "bridged content" });

		session.dispose();
	});

	it("disposes the previous backend when switching contexts", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const firstBackend = new CapturingBackend();
		const secondBackend = new CapturingBackend();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			executionContext: createContext(remoteDir, firstBackend),
		});

		session.setExecutionContext(createContext(tempDir, secondBackend));

		expect(firstBackend.disposed).toBe(true);
		expect(secondBackend.disposed).toBe(false);

		session.dispose();
		expect(secondBackend.disposed).toBe(true);
	});
});
