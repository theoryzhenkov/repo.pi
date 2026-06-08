import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { ExecutionContext, ToolBackend, ToolBackendCapabilities } from "../execution-context.ts";
import type {
	BashOperations,
	FindOperations,
	GrepOperations,
	GrepResult,
	LsOperations,
	ReadOperations,
	ToolsOptions,
} from "../tools/index.ts";
import type { WriteOperations } from "../tools/write.ts";

export interface StdioBridgeBackendOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

interface BridgeErrorPayload {
	code: string;
	message: string;
	data?: unknown;
}

interface BridgeResponse {
	id: string;
	type: "response";
	ok: boolean;
	result?: unknown;
	error?: BridgeErrorPayload;
}

interface BridgeEvent {
	id?: string;
	type: "event";
	event: string;
	data?: string;
	level?: string;
	message?: string;
}

type BridgeFrame = BridgeResponse | BridgeEvent;

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	onEvent?: (frame: BridgeEvent) => void;
};

function bridgeError(error: BridgeErrorPayload | undefined): Error {
	const err = new Error(error?.message ?? "Bridge request failed");
	if (error?.code) Object.assign(err, { code: error.code });
	return err;
}

function statFromResult(result: unknown): { isDirectory: () => boolean } {
	const value = result as { isDirectory?: boolean };
	return { isDirectory: () => value.isDirectory === true };
}

export class StdioBridgeBackend implements ToolBackend {
	readonly id = "stdio";
	readonly kind = "stdio";
	private child: ChildProcessWithoutNullStreams | undefined;
	private rl: Interface | undefined;
	private sequence = 0;
	private pending = new Map<string, PendingRequest>();
	private initialized: Promise<void> | undefined;
	private capabilities: ToolBackendCapabilities = {};
	private bridgeCwd: string | undefined;
	private readonly options: StdioBridgeBackendOptions;

	constructor(options: StdioBridgeBackendOptions) {
		this.options = options;
	}

	createToolOptions(_ctx: ExecutionContext): ToolsOptions {
		const readOps = this.createReadOperations();
		const writeOps = this.createWriteOperations();
		return {
			read: { operations: readOps, autoResizeImages: true },
			bash: { operations: this.createBashOperations(_ctx) },
			write: { operations: writeOps },
			edit: {
				operations: {
					...readOps,
					...writeOps,
					access: (path) => this.request("fs.access", { path, mode: "readwrite" }).then(() => {}),
				},
			},
			ls: { operations: this.createLsOperations() },
			find: { operations: this.createFindOperations() },
			grep: { operations: this.createGrepOperations() },
		};
	}

	createBashOperations(_ctx: ExecutionContext): BashOperations {
		return {
			exec: async (command, cwd, { onData, signal, timeout, env }) => {
				const id = this.nextId();
				const onAbort = () => {
					void this.request("bash.abort", { targetId: id }).catch(() => {});
				};
				if (signal?.aborted) throw new Error("aborted");
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const result = await this.requestWithId(id, "bash.exec", { command, cwd, timeout, env }, (frame) => {
						if (frame.event === "bash.output" && typeof frame.data === "string")
							onData(Buffer.from(frame.data, "base64"));
					});
					return result as { exitCode: number | null };
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			},
		};
	}

	async initialize(cwd: string): Promise<void> {
		if (!this.initialized) {
			this.start();
			this.initialized = this.request("initialize", {
				protocolVersion: 1,
				cwd,
				client: { name: "pi" },
			}).then((result) => {
				const value = result as { cwd?: string; capabilities?: ToolBackendCapabilities };
				this.bridgeCwd = value.cwd;
				this.capabilities = value.capabilities ?? {};
			});
		}
		return this.initialized;
	}

	getCapabilities(): ToolBackendCapabilities {
		return this.capabilities;
	}

	getCwd(): string | undefined {
		return this.bridgeCwd;
	}

	dispose(): void {
		this.rl?.close();
		this.child?.kill();
		this.rl = undefined;
		this.child = undefined;
		for (const pending of this.pending.values()) pending.reject(new Error("Bridge disposed"));
		this.pending.clear();
	}

	private createReadOperations(): ReadOperations {
		return {
			readFile: async (path) => {
				const result = (await this.request("fs.readFile", { path, encoding: "buffer" })) as {
					content: string;
					encoding: "base64";
				};
				return Buffer.from(result.content, "base64");
			},
			access: (path) => this.request("fs.access", { path, mode: "read" }).then(() => {}),
			detectImageMimeType: async (path) => {
				const result = (await this.request("fs.detectImageMimeType", { path })) as { mimeType?: string | null };
				return result.mimeType;
			},
		};
	}

	private createWriteOperations(): WriteOperations {
		return {
			writeFile: (path, content) => this.request("fs.writeFile", { path, content, encoding: "utf8" }).then(() => {}),
			mkdir: (path) => this.request("fs.mkdir", { path, recursive: true }).then(() => {}),
		};
	}

	private createLsOperations(): LsOperations {
		return {
			exists: async (path) => ((await this.request("fs.access", { path, mode: "exists" })) as { ok: boolean }).ok,
			stat: async (path) => statFromResult(await this.request("fs.stat", { path })),
			readdir: async (path) => ((await this.request("fs.readdir", { path })) as { entries: string[] }).entries,
		};
	}

	private createFindOperations(): FindOperations {
		return {
			exists: async (path) => ((await this.request("fs.access", { path, mode: "exists" })) as { ok: boolean }).ok,
			glob: async (pattern, cwd, options) =>
				((await this.request("search.find", { pattern, cwd, ...options })) as { matches: string[] }).matches,
		};
	}

	private createGrepOperations(): GrepOperations {
		return {
			isDirectory: async (path) => statFromResult(await this.request("fs.stat", { path })).isDirectory(),
			readFile: async (path) =>
				((await this.request("fs.readFile", { path, encoding: "utf8" })) as { content: string }).content,
			grep: async (request) => (await this.request("search.grep", { ...request })) as GrepResult,
		};
	}

	private start(): void {
		if (this.child) return;
		this.child = spawn(this.options.command, this.options.args ?? [], {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
		this.child.on("exit", () => {
			for (const pending of this.pending.values()) pending.reject(new Error("Bridge process exited"));
			this.pending.clear();
		});
		this.rl = createInterface({ input: this.child.stdout });
		this.rl.on("line", (line) => this.handleLine(line));
	}

	private handleLine(line: string): void {
		let frame: BridgeFrame;
		try {
			frame = JSON.parse(line) as BridgeFrame;
		} catch {
			return;
		}
		if (frame.type === "event") {
			if (frame.id) this.pending.get(frame.id)?.onEvent?.(frame);
			return;
		}
		const pending = this.pending.get(frame.id);
		if (!pending) return;
		this.pending.delete(frame.id);
		if (frame.ok) pending.resolve(frame.result);
		else pending.reject(bridgeError(frame.error));
	}

	private request(type: string, params: Record<string, unknown>): Promise<unknown> {
		return this.requestWithId(this.nextId(), type, params);
	}

	private requestWithId(
		id: string,
		type: string,
		params: Record<string, unknown>,
		onEvent?: (frame: BridgeEvent) => void,
	): Promise<unknown> {
		this.start();
		const child = this.child;
		if (!child) return Promise.reject(new Error("Bridge process not started"));
		const payload = { id, type, ...params };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onEvent });
			child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (error) {
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	private nextId(): string {
		this.sequence += 1;
		return `bridge-${this.sequence}`;
	}
}

export async function createStdioExecutionContext(
	cwd: string,
	options: StdioBridgeBackendOptions,
): Promise<ExecutionContext> {
	const backend = new StdioBridgeBackend(options);
	await backend.initialize(cwd);
	return {
		id: "stdio",
		label: "stdio bridge",
		cwd: backend.getCwd() ?? cwd,
		backend,
		capabilities: backend.getCapabilities(),
	};
}
