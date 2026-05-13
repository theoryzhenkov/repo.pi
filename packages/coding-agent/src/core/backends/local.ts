import type { ExecutionContext, ToolBackend, ToolBackendCapabilities } from "../execution-context.js";
import { type BashOperations, createLocalBashOperations, type ToolsOptions } from "../tools/index.js";

export interface LocalBackendOptions {
	autoResizeImages?: boolean;
	commandPrefix?: string;
	shellPath?: string;
}

export class LocalToolBackend implements ToolBackend {
	readonly id = "local";
	readonly kind = "local";

	constructor(private readonly options: LocalBackendOptions = {}) {}

	createToolOptions(_ctx: ExecutionContext): ToolsOptions {
		return {
			read: { autoResizeImages: this.options.autoResizeImages },
			bash: { commandPrefix: this.options.commandPrefix, shellPath: this.options.shellPath },
		};
	}

	createBashOperations(_ctx: ExecutionContext): BashOperations {
		return createLocalBashOperations({ shellPath: this.options.shellPath });
	}
}

export const localBackendCapabilities: ToolBackendCapabilities = {
	bash: true,
	read: true,
	write: true,
	edit: true,
	ls: true,
	find: true,
	grep: true,
	images: true,
	abort: true,
};

export function createLocalExecutionContext(cwd: string, options?: LocalBackendOptions): ExecutionContext {
	return {
		id: "local",
		label: "Local",
		cwd,
		backend: new LocalToolBackend(options),
		capabilities: localBackendCapabilities,
	};
}
