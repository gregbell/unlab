// The browser's WebMCP API, as far as this page uses it: register a tool with
// an abort signal, and unregister it by aborting. The API is in origin trial,
// so it is read off `document` or `navigator` by duck type, never trusted to
// check a tool's input against its schema.

import type { JsonSchema, ToolAnnotations } from "../commands/index.ts";

export interface WebMcpTool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly annotations: ToolAnnotations;
	/** Resolves with what the agent reads, `{ error }` for a call that failed or was refused; rejects only when the agent aborts. */
	execute(input: unknown, options: { readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface ModelContextLike {
	/** May return a promise; aborting `signal` removes the tool. */
	registerTool(tool: WebMcpTool, options: { readonly signal: AbortSignal }): unknown;
}

function asModelContext(value: unknown): ModelContextLike | null {
	if (typeof value !== "object" || value === null || !("registerTool" in value)) return null;
	const { registerTool } = value;
	if (typeof registerTool !== "function") return null;
	return { registerTool: (tool, options) => Reflect.apply(registerTool, value, [tool, options]) };
}

/** `document.modelContext`, else `navigator.modelContext` from earlier drafts, else null: then no agent can call in. */
export function detectModelContext(doc: object, nav: object): ModelContextLike | null {
	return asModelContext(Reflect.get(doc, "modelContext")) ?? asModelContext(Reflect.get(nav, "modelContext"));
}
