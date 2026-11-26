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
	readonly id?: Id | null;
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

/** The client cancelled the request, which is then not answered. */
class Cancelled extends Error {}

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

export class McpServer {
	readonly #deps: McpDeps;
	readonly #calls = new Map<Id, AbortController>();
	#initialized = false;

	constructor(deps: McpDeps) {
		this.#deps = deps;
	}

	readonly #methods: Readonly<Record<string, (params: Incoming["params"], id: Id) => object | Promise<object>>> = {
		initialize: (params) => {
			const asked = params?.protocolVersion;
			return {
				protocolVersion: VERSIONS.find((version) => version === asked) ?? VERSIONS[0],
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "unlab", version: this.#deps.version },
				instructions: INSTRUCTIONS,
			};
		},
		ping: () => ({}),
		"tools/list": () => ({ tools: this.#deps.tools() }),
		"tools/call": (params, id) => this.#call(params, id),
	};

	readonly #notifications: Readonly<Record<string, (params: Incoming["params"]) => void>> = {
		"notifications/initialized": () => {
			this.#initialized = true;
		},
		"notifications/cancelled": (params) => {
			const id = params?.requestId;
			if (typeof id === "string" || typeof id === "number") this.#calls.get(id)?.abort(new Error("Cancelled."));
		},
	};

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
		if (typeof method !== "string") return;
		if (id === undefined || id === null) {
			this.#notifications[method]?.(params);
			return;
		}
		const handler = Object.hasOwn(this.#methods, method) ? this.#methods[method] : undefined;
		if (!handler) {
			this.#deps.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `There is no method ${method}.` } });
			return;
		}
		Promise.resolve()
			.then(() => handler(params, id))
			.then(
				(result) => this.#deps.send({ jsonrpc: "2.0", id, result }),
				(error: unknown) => {
					if (error instanceof Cancelled) return;
					const code = error instanceof Refusal ? error.code : -32603;
					const text = error instanceof Error ? error.message : String(error);
					this.#deps.send({ jsonrpc: "2.0", id, error: { code, message: text } });
				},
			);
	}

	/** The lab's tools changed. */
	changed(): void {
		if (this.#initialized) this.#deps.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	}

	/** Gives up every call that runs. */
	close(): void {
		for (const call of this.#calls.values()) call.abort(new Error("The MCP server closed."));
	}

	async #call(params: Incoming["params"], id: Id): Promise<object> {
		const name = params?.name;
		if (typeof name !== "string") throw new Refusal(-32602, "tools/call needs the name of a tool.");
		const abort = new AbortController();
		this.#calls.set(id, abort);
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
			return toolResult(await this.#deps.call(name, params?.arguments ?? {}, abort.signal));
		} catch (error) {
			if (abort.signal.aborted) throw new Cancelled();
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				isError: true,
			};
		} finally {
			clearInterval(ticking);
			this.#calls.delete(id);
		}
	}
}
