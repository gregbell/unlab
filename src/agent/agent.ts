// The agent layer: registers the tool table with WebMCP and runs each call
// through the policy the person set. The store holds every call as data; the
// only thing kept here is how to resume a call that waits for a person.

import type { CaptureView } from "../capture/index.ts";
import type { Registry } from "../commands/index.ts";
import type { AgentCall, LabState, Store, ToolName, WebMcp } from "../model/index.ts";
import { type AgentTool, type Answer, type SessionScreens, toolTable } from "./tools.ts";
import type { ModelContextLike, WebMcpTool } from "./webmcp.ts";

export const DENIED = "Denied by the user.";

/** Takes no input and changes nothing. */
const TRIED: ToolName = "machines_list";

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

/** A tool as an agent outside the browser is offered it, through the CLI. */
export type OfferedTool = Omit<AgentTool, "prepare">;

export interface Agent {
	readonly tools: readonly ToolRow[];
	/** The tools an agent may call now: none while paused, and none that are off. */
	offered(): readonly OfferedTool[];
	/** Runs a call as WebMCP would. Resolves with what the agent reads; rejects only when `signal` aborts. */
	call(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
	/** The person's answer to a waiting call. Anything else is ignored. */
	answer(call: number, allow: boolean): void;
	/**
	 * Calls machines_list through the browser, as an agent would. Rejects when
	 * the browser does not get the call to the tool. Null in a browser where a
	 * page cannot call tools.
	 */
	readonly tryCall: (() => Promise<void>) | null;
	/** Unregisters every tool. Waiting calls stay waiting. */
	dispose(): void;
}

/**
 * What the agent reads when a call fails or is refused. A value and not a
 * rejection, because the browser replaces a rejection's message with its own.
 */
interface Failure {
	readonly error: string;
}

function sentence(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function startAgent(deps: AgentDeps): Agent {
	const { store, modelContext } = deps;
	const table = toolTable(deps.registry, deps);
	const registered = new Map<ToolName, AbortController>();
	/** What the browser said about each tool it would not take. */
	const refusals = new Map<ToolName, string>();
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
		const refused = (error: string): Failure => {
			store.dispatchAgent({
				type: "agent/call",
				call: { ...fields, line: prepared.line, status: "failed", result: error },
			});
			return { error };
		};
		const { policies, paused } = lab.agent;
		if (!prepared.ok) return refused(prepared.error);
		// The browser can still deliver a call to a tool unregistered a moment ago.
		if (paused) return refused("Tools are paused in the agent panel.");
		if (policies[tool.name] === "off") return refused(`${tool.name} is off in the agent panel.`);

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
				return { error: DENIED } satisfies Failure;
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
			return { error: sentence(error) } satisfies Failure;
		}
		settle(id, "done", answer.summary);
		return answer.reply;
	}

	const isOffered = (name: ToolName) => !store.state.agent.paused && store.state.agent.policies[name] !== "off";

	const webTools = new Map<ToolName, WebMcpTool>(
		table.map((tool) => [
			tool.name,
			{
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
				execute: (input, options) => call(tool, input, options?.signal),
			},
		]),
	);

	function report(): void {
		const { policies } = store.state.agent;
		const refusal = [...refusals].find(([name]) => policies[name] !== "off");
		const webmcp: WebMcp = refusal ? { kind: "refused", message: refusal[1] } : { kind: "registered" };
		store.dispatchAgent({ type: "agent/webmcp", webmcp });
	}

	/**
	 * A browser that refuses a tool says so in the store and the console; the
	 * lab carries on. The tool stays counted as registered so a refusal is not
	 * retried on every store change, only when the tool is next wanted.
	 */
	function register(context: ModelContextLike, tool: WebMcpTool, name: ToolName, signal: AbortSignal): void {
		const took = () => {
			if (signal.aborted) return;
			refusals.delete(name);
			report();
		};
		const refused = (error: unknown) => {
			if (signal.aborted) return;
			console.error(`WebMCP did not register ${name}`, error);
			refusals.set(name, sentence(error));
			report();
		};
		try {
			const pending = context.registerTool(tool, { signal });
			if (pending instanceof Promise) pending.then(took, refused);
			else took();
		} catch (error) {
			refused(error);
		}
	}

	/** Registered is exactly the tools whose policy is not off, or none while paused. Idempotent. */
	function reconcile(): void {
		if (!modelContext) return;
		report();
		for (const [name, tool] of webTools) {
			const wanted = isOffered(name);
			const controller = registered.get(name);
			if (wanted && !controller) {
				const next = new AbortController();
				registered.set(name, next);
				register(modelContext, tool, name, next.signal);
			} else if (!wanted && controller) {
				controller.abort();
				registered.delete(name);
			}
		}
	}

	function tryCall(): Agent["tryCall"] {
		const { getTools, executeTool } = modelContext ?? {};
		if (!getTools || !executeTool) return null;
		return async () => {
			const listed = await getTools();
			const tool: unknown = Array.isArray(listed) ? listed.find((t) => t?.name === TRIED) : undefined;
			if (tool === undefined) throw new Error(`The browser does not list ${TRIED}.`);
			await executeTool(tool, {});
		};
	}

	const unsubscribe = store.subscribe(reconcile);
	reconcile();

	return {
		tools: table.map((tool) => ({ name: tool.name, args: Object.keys(tool.inputSchema.properties ?? {}) })),
		offered: () =>
			table
				.filter((tool) => isOffered(tool.name))
				.map(({ name, title, description, inputSchema, annotations }) => ({
					name,
					title,
					description,
					inputSchema,
					annotations,
				})),
		call(name, input, signal) {
			const tool = table.find((one) => one.name === name);
			if (!tool) return Promise.resolve({ error: `There is no tool called ${name}.` } satisfies Failure);
			return call(tool, input, signal);
		},
		answer(id, allow) {
			const resume = waiting.get(id);
			waiting.delete(id);
			resume?.(allow);
		},
		tryCall: tryCall(),
		dispose() {
			unsubscribe();
			for (const controller of registered.values()) controller.abort();
			registered.clear();
		},
	};
}
