// `npx unlab.run mcp`: an MCP server on stdio that offers the tools of the lab
// the CLI is linked to, and passes each call to it. It knows no tool itself.

import type { ToolInfo } from "../../src/streams/index.ts";

/** Newest first. A client that asks for another is answered with the newest. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const INSTRUCTIONS =
	"The tools of the unlab lab in the browser appear here once that lab is linked, which `npx unlab.run` does.";

/** How often a call that is still running says so, so that the client does not give up on it. */
export const PROGRESS_MS = 5000;

type Id = string | number;

interface Incoming {
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: Readonly<Record<string, unknown>>;
}

export interface McpDeps {
	readonly version: string;
	/** One message, which the server writes as a line of its own. */
	send(message: object): void;
	/** What the lab offers now, at once: never waits for the lab. */
	tools(): readonly ToolInfo[];
	/** Resolves with what the tool replied; rejects with a sentence. */
	call(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

class Refusal extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** What an agent reads: the tool's `{ error }` as an error, anything else as JSON. */
export function toolResult(reply: unknown): object {
	const failed =
		typeof reply === "object" &&
		reply !== null &&
		Object.keys(reply).length === 1 &&
		typeof (reply as { error?: unknown }).error === "string";
	if (failed) return { content: [{ type: "text", text: (reply as { error: string }).error }], isError: true };
	return { content: [{ type: "text", text: JSON.stringify(reply ?? null) }] };
}

type Method = (params: Incoming["params"], signal: AbortSignal) => object | Promise<object>;

export class McpServer {
	readonly #deps: McpDeps;
	/** Every request not yet answered, so that a cancel that comes right behind one still finds it. */
	readonly #requests = new Map<Id, AbortController>();
	#initialized = false;
	readonly #methods: ReadonlyMap<string, Method>;
	readonly #notifications: ReadonlyMap<string, (params: Incoming["params"]) => void>;

	constructor(deps: McpDeps) {
		this.#deps = deps;
		this.#methods = new Map<string, Method>([
			[
				"initialize",
				(params) => ({
					protocolVersion: VERSIONS.find((version) => version === params?.protocolVersion) ?? VERSIONS[0],
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "unlab", version: deps.version },
					instructions: INSTRUCTIONS,
				}),
			],
			["ping", () => ({})],
			["tools/list", () => ({ tools: deps.tools() })],
			["tools/call", (params, signal) => this.#call(params, signal)],
		]);
		this.#notifications = new Map<string, (params: Incoming["params"]) => void>([
			[
				"notifications/initialized",
				() => {
					this.#initialized = true;
				},
			],
			[
				"notifications/cancelled",
				(params) => {
					const id = params?.requestId;
					if (typeof id === "string" || typeof id === "number") this.#requests.get(id)?.abort(new Error("Cancelled."));
				},
			],
		]);
	}

	/** One line from the client. */
	receive(line: string): void {
		if (line.trim() === "") return;
		let message: Incoming;
		try {
			message = JSON.parse(line) as Incoming;
		} catch {
			this.#deps.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}
		if (typeof message !== "object" || message === null || Array.isArray(message)) {
			this.#deps.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
			return;
		}
		const { id, method, params } = message;
		const isRequest = typeof id === "string" || typeof id === "number";
		if (typeof method !== "string") {
			// A response to a request of ours, of which there are none, or a request without a method.
			if (isRequest && !("result" in message) && !("error" in message)) {
				this.#deps.send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
			}
			return;
		}
		if (!isRequest) {
			this.#notifications.get(method)?.(params);
			return;
		}
		const handler = this.#methods.get(method);
		if (!handler) {
			this.#deps.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `There is no method ${method}.` } });
			return;
		}
		const abort = new AbortController();
		this.#requests.set(id, abort);
		Promise.resolve()
			.then(() => handler(params, abort.signal))
			.then(
				(result) => {
					if (!abort.signal.aborted) this.#deps.send({ jsonrpc: "2.0", id, result });
				},
				(error: unknown) => {
					if (abort.signal.aborted) return;
					const code = error instanceof Refusal ? error.code : -32603;
					const text = error instanceof Error ? error.message : String(error);
					this.#deps.send({ jsonrpc: "2.0", id, error: { code, message: text } });
				},
			)
			.finally(() => {
				if (this.#requests.get(id) === abort) this.#requests.delete(id);
			});
	}

	/** The lab's tools changed. */
	changed(): void {
		if (this.#initialized) this.#deps.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	}

	/** Gives up every request not yet answered. */
	close(): void {
		for (const request of this.#requests.values()) request.abort(new Error("The MCP server closed."));
	}

	async #call(params: Incoming["params"], signal: AbortSignal): Promise<object> {
		const name = params?.name;
		if (typeof name !== "string") throw new Refusal(-32602, "tools/call needs the name of a tool.");
		const token = (params?._meta as { progressToken?: unknown } | undefined)?.progressToken;
		let progress = 0;
		const ticking =
			typeof token === "string" || typeof token === "number"
				? setInterval(() => {
						progress++;
						this.#deps.send({
							jsonrpc: "2.0",
							method: "notifications/progress",
							params: { progressToken: token, progress },
						});
					}, PROGRESS_MS)
				: undefined;
		try {
			return toolResult(await this.#deps.call(name, params?.arguments ?? {}, signal));
		} catch (error) {
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				isError: true,
			};
		} finally {
			clearInterval(ticking);
		}
	}
}
