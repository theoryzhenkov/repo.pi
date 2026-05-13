import type { BashOperations, ToolsOptions } from "./tools/index.js";

export interface ToolBackendCapabilities {
	bash?: boolean;
	read?: boolean;
	write?: boolean;
	edit?: boolean;
	ls?: boolean;
	find?: boolean;
	grep?: boolean;
	images?: boolean;
	abort?: boolean;
}

export interface ExecutionContext {
	id: string;
	label?: string;
	cwd: string;
	backend: ToolBackend;
	capabilities: ToolBackendCapabilities;
}

export interface ToolBackend {
	id: string;
	kind: "local" | "stdio" | string;
	createToolOptions(ctx: ExecutionContext): ToolsOptions;
	createBashOperations(ctx: ExecutionContext): BashOperations;
	dispose?(): Promise<void> | void;
}
