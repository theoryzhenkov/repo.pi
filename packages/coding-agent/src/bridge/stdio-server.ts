import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { glob } from "glob";
import { createLocalBashOperations } from "../core/tools/bash.ts";
import { createGrepToolDefinition, type GrepToolDetails } from "../core/tools/grep.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

interface BridgeRequest {
	id: string;
	type: string;
	[key: string]: unknown;
}

type ResponseResult = Record<string, unknown> | string[] | string | number | boolean | null;

const runningBash = new Map<string, AbortController>();
let bridgeCwd = process.cwd();

function send(frame: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sendOk(id: string, result: ResponseResult): void {
	send({ id, type: "response", ok: true, result });
}

function sendError(id: string, error: unknown): void {
	const nodeError = error as NodeJS.ErrnoException;
	send({
		id,
		type: "response",
		ok: false,
		error: {
			code: nodeError.code ?? (nodeError.message === "aborted" ? "ABORTED" : "ERROR"),
			message: error instanceof Error ? error.message : String(error),
		},
	});
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function isWithinPath(basePath: string, candidatePath: string): boolean {
	const relativePath = relative(basePath, candidatePath);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export async function resolveBridgeCwd(requestedCwd: unknown, baseCwd = process.cwd()): Promise<string> {
	if (typeof requestedCwd !== "string" || requestedCwd.length === 0) {
		return baseCwd;
	}

	const candidate = resolve(baseCwd, requestedCwd);
	if (!isWithinPath(baseCwd, candidate)) {
		return baseCwd;
	}

	try {
		const info = await stat(candidate);
		return info.isDirectory() ? candidate : baseCwd;
	} catch {
		return baseCwd;
	}
}

function modeToConstant(mode: unknown): number {
	if (mode === "read") return constants.R_OK;
	if (mode === "write") return constants.W_OK;
	if (mode === "readwrite") return constants.R_OK | constants.W_OK;
	return constants.F_OK;
}

async function handleRequest(request: BridgeRequest): Promise<void> {
	const id = request.id;
	switch (request.type) {
		case "initialize":
			bridgeCwd = await resolveBridgeCwd(request.cwd);
			sendOk(id, {
				cwd: bridgeCwd,
				server: { name: "pi-bridge", version: 1 },
				capabilities: {
					bash: true,
					read: true,
					write: true,
					edit: true,
					ls: true,
					find: true,
					grep: true,
					images: true,
					abort: true,
				},
				limits: {},
			});
			return;
		case "fs.readFile": {
			const path = stringValue(request.path);
			if (request.encoding === "utf8") sendOk(id, { content: await readFile(path, "utf8") });
			else sendOk(id, { content: (await readFile(path)).toString("base64"), encoding: "base64" });
			return;
		}
		case "fs.access": {
			try {
				await access(stringValue(request.path), modeToConstant(request.mode));
				sendOk(id, { ok: true });
			} catch (error) {
				if (request.mode === "exists") sendOk(id, { ok: false });
				else throw error;
			}
			return;
		}
		case "fs.writeFile":
			await writeFile(stringValue(request.path), stringValue(request.content), "utf8");
			sendOk(id, {});
			return;
		case "fs.mkdir":
			await mkdir(stringValue(request.path), { recursive: request.recursive !== false });
			sendOk(id, {});
			return;
		case "fs.stat": {
			const info = await stat(stringValue(request.path));
			sendOk(id, { isDirectory: info.isDirectory(), isFile: info.isFile(), size: info.size, mtimeMs: info.mtimeMs });
			return;
		}
		case "fs.readdir":
			sendOk(id, { entries: await readdir(stringValue(request.path)) });
			return;
		case "fs.detectImageMimeType":
			sendOk(id, { mimeType: await detectSupportedImageMimeTypeFromFile(stringValue(request.path)) });
			return;
		case "search.find": {
			const matches = await glob(stringValue(request.pattern), {
				cwd: stringValue(request.cwd, bridgeCwd),
				ignore: Array.isArray(request.ignore) ? (request.ignore as string[]) : [],
				dot: true,
				nodir: true,
				absolute: true,
				maxDepth: undefined,
			});
			sendOk(id, { matches: matches.slice(0, numberValue(request.limit) ?? 1000) });
			return;
		}
		case "search.grep": {
			const tool = createGrepToolDefinition(bridgeCwd);
			const result = (await tool.execute(
				id,
				{
					pattern: stringValue(request.pattern),
					path: stringValue(request.path, bridgeCwd),
					glob: typeof request.glob === "string" ? request.glob : undefined,
					ignoreCase: request.ignoreCase === true,
					literal: request.literal === true,
					context: numberValue(request.context),
					limit: numberValue(request.limit),
				},
				undefined,
				undefined,
				{} as never,
			)) as { content: Array<{ text?: string }>; details?: GrepToolDetails };
			sendOk(id, { output: result.content[0]?.text ?? "", details: result.details });
			return;
		}
		case "bash.exec": {
			const abortController = new AbortController();
			runningBash.set(id, abortController);
			try {
				const result = await createLocalBashOperations().exec(
					stringValue(request.command),
					stringValue(request.cwd, bridgeCwd),
					{
						signal: abortController.signal,
						timeout: numberValue(request.timeout),
						env:
							typeof request.env === "object" && request.env !== null
								? (request.env as NodeJS.ProcessEnv)
								: undefined,
						onData: (data) => send({ id, type: "event", event: "bash.output", data: data.toString("base64") }),
					},
				);
				sendOk(id, result);
			} finally {
				runningBash.delete(id);
			}
			return;
		}
		case "bash.abort":
			runningBash.get(stringValue(request.targetId))?.abort();
			sendOk(id, {});
			return;
		default:
			throw Object.assign(new Error(`Unsupported request type: ${request.type}`), { code: "UNSUPPORTED" });
	}
}

export function runStdioBridge(): void {
	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		let request: BridgeRequest;
		try {
			request = JSON.parse(line) as BridgeRequest;
		} catch {
			send({ type: "event", event: "log", level: "error", message: "Malformed JSON request" });
			return;
		}
		void handleRequest(request).catch((error) => sendError(request.id, error));
	});
}
