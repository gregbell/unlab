import type { Page } from "@playwright/test";

interface RegisteredTool {
	readonly name: string;
	readonly title: string;
	readonly annotations: Record<string, boolean>;
}

declare global {
	interface Document {
		readonly modelContext: {
			getTools(): Promise<RegisteredTool[]>;
			executeTool(tool: RegisteredTool, input: object, options?: { signal?: AbortSignal }): Promise<string>;
		};
	}
	interface Window {
		/** Calls left running between evaluates. */
		running?: Map<string, { readonly reply: Promise<string>; readonly controller: AbortController }>;
	}
}

export const registered = (page: Page) =>
	page.evaluate(async () => (await document.modelContext.getTools()).map((tool) => tool.name).sort());

/** Starts a call and leaves it running under `key`, as an agent waiting on a person would. */
export const start = (page: Page, key: string, name: string, input: object) =>
	page.evaluate(
		async ([key, name, input]) => {
			const tool = (await document.modelContext.getTools()).find((tool) => tool.name === name);
			if (!tool) throw new Error(`${name} is not registered`);
			const controller = new AbortController();
			const reply = document.modelContext.executeTool(tool, input, { signal: controller.signal });
			reply.catch(() => {});
			window.running ??= new Map();
			window.running.set(key, { reply, controller });
		},
		[key, name, input] as const,
	);

export const finish = async (page: Page, key: string): Promise<unknown> =>
	JSON.parse((await page.evaluate((key) => window.running?.get(key)?.reply, key)) ?? "null");

/** Calls a tool as an agent would and waits for its answer. */
export async function call(page: Page, name: string, input: object): Promise<unknown> {
	await start(page, "call", name, input);
	return finish(page, "call");
}
