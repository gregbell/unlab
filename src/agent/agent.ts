// The agent layer: registers the tool table with WebMCP and runs each call
// through the policy the person set. The store holds every call as data; the
// only thing kept here is how to resume a call that waits for a person.

import type { CaptureView } from "../capture/index.ts";
import type { Registry } from "../commands/index.ts";
import type { AgentCall, LabState, Store, ToolName } from "../model/index.ts";
import { type AgentTool, type Answer, type SessionScreens, ToolError, toolTable } from "./tools.ts";
import type { ModelContextLike, WebMcpTool } from "./webmcp.ts";

export const DENIED = "Denied by the user.";

export interface AgentDeps {
	readonly store: Pick<Store, "state" | "subscribe" | "dispatchAgent">;
	readonly registry: Registry;
	readonly screens: SessionScreens;
	readonly capture: Pick<CaptureView, "frames">;
	/** Null when the browser has no WebMCP: nothing registers, and the panel still shows the tools. */
	readonly modelContext: ModelContextLike | null;
}

/** A tool as the panel lists it: `machines_spawn(count, image, mem, net)`. */
export interface ToolRow {
	readonly name: ToolName;
	readonly args: readonly string[];
}

export interface Agent {
	/** Whether this browser has WebMCP. */
	readonly available: boolean;
	readonly tools: readonly ToolRow[];
	/** The person's answer to a waiting call. Anything else is ignored. */
	answer(call: number, allow: boolean): void;
	/** Unregisters every tool. Waiting calls stay waiting. */
	dispose(): void;
}

function sentence(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function startAgent(deps: AgentDeps): Agent {
	const { store, modelContext } = deps;
	const table = toolTable(deps.registry, deps);
	const registered = new Map<ToolName, AbortController>();
	const waiting = new Map<number, (allow: boolean) => void>();

	const nextId = (state: LabState) => state.agent.calls.reduce((max, call) => Math.max(max, call.id), 0) + 1;
	const settle = (id: number, status: AgentCall["status"], result: string | null) =>
		store.dispatchAgent({ type: "agent/settled", id, status, result });

	/** Resolves with the person's answer; rejects with the agent's reason if it gives up first. */
	const answerTo = (id: number, signal: AbortSignal | undefined) =>
		new Promise<boolean>((resolve, reject) => {
			const onAbort = () => {
				waiting.delete(id);
				reject(signal?.reason);
			};
			waiting.set(id, (allow) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(allow);
			});
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	async function call(tool: AgentTool, input: unknown, signal: AbortSignal | undefined): Promise<unknown> {
		signal?.throwIfAborted();
		const lab = store.state;
		const id = nextId(lab);
		const fields = { id, tool: tool.name, preview: null, actionLabel: null, result: null, at: lab.now };
		const prepared = tool.prepare(input, lab);
		const refused = (error: string) => {
			store.dispatchAgent({
				type: "agent/call",
				call: { ...fields, line: prepared.line, status: "failed", result: error },
			});
			return new ToolError(error);
		};
		const { policies, paused } = lab.agent;
		if (!prepared.ok) throw refused(prepared.error);
		// The browser can still deliver a call to a tool unregistered a moment ago.
		if (paused) throw refused("Tools are paused in the agent panel.");
		if (policies[tool.name] === "off") throw refused(`${tool.name} is off in the agent panel.`);

		if (policies[tool.name] === "ask") {
			const { preview, actionLabel } = prepared;
			store.dispatchAgent({
				type: "agent/call",
				call: { ...fields, line: prepared.line, status: "waiting", preview, actionLabel },
			});
			let allow: boolean;
			try {
				allow = await answerTo(id, signal);
			} catch (reason) {
				settle(id, "aborted", null);
				throw reason;
			}
			if (!allow) {
				settle(id, "denied", DENIED);
				return DENIED;
			}
			settle(id, "running", null);
		} else {
			store.dispatchAgent({ type: "agent/call", call: { ...fields, line: prepared.line, status: "running" } });
		}

		let answer: Answer;
		try {
			answer = await prepared.run(signal ?? new AbortController().signal);
		} catch (error) {
			if (signal?.aborted) {
				settle(id, "aborted", null);
				throw signal.reason;
			}
			settle(id, "failed", sentence(error));
			throw error instanceof ToolError ? error : new ToolError(sentence(error));
		}
		settle(id, "done", answer.summary);
		return answer.reply;
	}

	const webTools = new Map<ToolName, WebMcpTool>(
		table.map((tool) => [
			tool.name,
			{
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
				execute: (input, options) => call(tool, input, options?.signal),
			},
		]),
	);

	/** Registered is exactly the tools whose policy is not off, or none while paused. Idempotent. */
	function reconcile(): void {
		if (!modelContext) return;
		const { policies, paused } = store.state.agent;
		for (const [name, tool] of webTools) {
			const wanted = !paused && policies[name] !== "off";
			const controller = registered.get(name);
			if (wanted && !controller) {
				const next = new AbortController();
				registered.set(name, next);
				register(modelContext, tool, next.signal);
			} else if (!wanted && controller) {
				controller.abort();
				registered.delete(name);
			}
		}
	}

	const unsubscribe = store.subscribe(reconcile);
	reconcile();

	return {
		available: modelContext !== null,
		tools: table.map((tool) => ({ name: tool.name, args: Object.keys(tool.inputSchema.properties ?? {}) })),
		answer(id, allow) {
			const resume = waiting.get(id);
			waiting.delete(id);
			resume?.(allow);
		},
		dispose() {
			unsubscribe();
			for (const controller of registered.values()) controller.abort();
			registered.clear();
		},
	};
}

/**
 * A browser that refuses a tool says so in the console; the lab carries on.
 * The tool stays counted as registered so a refusal is not retried on every
 * store change.
 */
function register(modelContext: ModelContextLike, tool: WebMcpTool, signal: AbortSignal): void {
	const failed = (error: unknown) => console.error(`WebMCP did not register ${tool.name}`, error);
	try {
		const pending = modelContext.registerTool(tool, { signal });
		if (pending instanceof Promise) pending.catch(failed);
	} catch (error) {
		failed(error);
	}
}
