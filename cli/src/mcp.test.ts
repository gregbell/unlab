import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolInfo } from "../../src/streams/index.ts";
import { INSTRUCTIONS, McpServer, PROGRESS_MS, toolResult } from "./mcp.ts";

const LIST: ToolInfo = {
	name: "machines_list",
	title: "List machines",
	description: "Lists the machines.",
	inputSchema: { type: "object", properties: {} },
	annotations: { readOnlyHint: true },
};

function client(tools: readonly ToolInfo[] = [LIST]) {
	const sent: Record<string, unknown>[] = [];
	const calls: {
		name: string;
		input: unknown;
		signal: AbortSignal;
		settle(reply: unknown): void;
		fail(e: Error): void;
	}[] = [];
	const offered = { tools };
	const server = new McpServer({
		version: "9.9.9",
		send: (message) => sent.push(JSON.parse(JSON.stringify(message))),
		tools: () => offered.tools,
		call: (name, input, signal) =>
			new Promise((settle, fail) => {
				calls.push({ name, input, signal, settle, fail });
			}),
	});
	let ids = 0;
	const say = (message: object) => server.receive(JSON.stringify({ jsonrpc: "2.0", ...message }));
	/** A request, and the answer to it once there is one. */
	const ask = async (method: string, params?: object) => {
		const id = ++ids;
		say({ id, method, params });
		await vi.waitFor(() => expect(sent.some((m) => m.id === id)).toBe(true));
		return sent.find((m) => m.id === id);
	};
	return { server, sent, calls, offered, say, ask };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("starting", () => {
	test("says what it is, that it lists tools that change, and how the lab's tools come", async () => {
		const { ask } = client();
		expect(await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} })).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "unlab", version: "9.9.9" },
				instructions: INSTRUCTIONS,
			},
		});
		expect(INSTRUCTIONS).toContain("npx unlab.run");
	});

	test("answers a client that asks for a version it does not know with its newest", async () => {
		const { ask } = client();
		const answer = await ask("initialize", { protocolVersion: "1999-01-01" });
		expect(answer?.result).toMatchObject({ protocolVersion: "2025-11-25" });
	});

	test("answers ping, and says which method there is not", async () => {
		const { ask } = client();
		expect(await ask("ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
		expect(await ask("resources/list")).toMatchObject({ id: 2, error: { code: -32601 } });
	});

	test("answers a line that is not JSON, and ignores a blank one and notifications it does not know", () => {
		const { server, sent } = client();
		server.receive("");
		server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }));
		expect(sent).toEqual([]);
		server.receive("{nope");
		expect(sent).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
	});
});

describe("tools", () => {
	test("are listed at once exactly as the lab gives them, and none without a lab", async () => {
		const { ask, offered } = client();
		expect(await ask("tools/list")).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [LIST] } });
		offered.tools = [];
		expect((await ask("tools/list"))?.result).toEqual({ tools: [] });
	});

	test("a change is told once the client is ready for it", () => {
		const { server, sent, say } = client();
		server.changed();
		expect(sent).toEqual([]);
		say({ method: "notifications/initialized" });
		server.changed();
		expect(sent).toEqual([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }]);
	});

	test("a call passes the name and input as they are, and gives back the reply as JSON", async () => {
		const { ask, calls } = client();
		const answer = ask("tools/call", { name: "machines_list", arguments: { anything: [1, "two"] } });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toMatchObject({ name: "machines_list", input: { anything: [1, "two"] } });
		calls[0].settle({ result: "2 machines", data: [{ name: "node1" }] });
		expect((await answer)?.result).toEqual({
			content: [{ type: "text", text: '{"result":"2 machines","data":[{"name":"node1"}]}' }],
		});
	});

	test("a call with no arguments passes an empty input", async () => {
		const { ask, calls } = client();
		void ask("tools/call", { name: "machines_list" });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0].input).toEqual({});
	});

	test("the lab's { error } is an error result with its sentence, and so is a call that could not reach it", async () => {
		const { ask, calls } = client();
		const denied = ask("tools/call", { name: "machines_remove", arguments: { names: "node2" } });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		calls[0].settle({ error: "Denied by the user." });
		expect((await denied)?.result).toEqual({
			content: [{ type: "text", text: "Denied by the user." }],
			isError: true,
		});
		const unlinked = ask("tools/call", { name: "machines_list" });
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		calls[1].fail(
			new Error("The lab is not linked. Run `npx unlab.run` to open it, and allow the browser's question."),
		);
		expect((await unlinked)?.result).toEqual({
			content: [{ type: "text", text: expect.stringContaining("The lab is not linked.") }],
			isError: true,
		});
	});

	test("a reply that only has an error among other things is a reply, not an error", () => {
		expect(toolResult({ error: "x", data: 1 })).toEqual({
			content: [{ type: "text", text: '{"error":"x","data":1}' }],
		});
		expect(toolResult(undefined)).toEqual({ content: [{ type: "text", text: "null" }] });
	});

	test("a call without a name is refused as bad params", async () => {
		const { ask, calls } = client();
		expect(await ask("tools/call", { arguments: {} })).toMatchObject({ error: { code: -32602 } });
		expect(calls).toEqual([]);
	});

	test("a call the client cancels is stopped in the lab, and not answered", async () => {
		const { say, sent, calls } = client();
		say({ id: "a", method: "tools/call", params: { name: "machines_remove", arguments: {} } });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		say({ method: "notifications/cancelled", params: { requestId: "a", reason: "user" } });
		expect(calls[0].signal.aborted).toBe(true);
		calls[0].fail(new Error("Stopped from the CLI."));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sent.filter((m) => m.id === "a")).toEqual([]);
	});

	test("a call that waits says so every few seconds to a client that gave a progress token, and stops once answered", async () => {
		vi.useFakeTimers();
		const { say, sent, calls } = client();
		say({ id: 1, method: "tools/call", params: { name: "machines_spawn", _meta: { progressToken: "p" } } });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(PROGRESS_MS * 3);
		const progress = () => sent.filter((m) => m.method === "notifications/progress");
		expect(progress()).toEqual(
			[1, 2, 3].map((n) => ({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: "p", progress: n },
			})),
		);
		calls[0].settle({ result: "booted" });
		await vi.advanceTimersByTimeAsync(PROGRESS_MS * 3);
		expect(progress()).toHaveLength(3);
	});

	test("closing gives up every call that runs", async () => {
		const { server, say, calls } = client();
		say({ id: 1, method: "tools/call", params: { name: "machines_list" } });
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		server.close();
		expect(calls[0].signal.aborted).toBe(true);
	});
});

describe("what a client may send that it should not", () => {
	test("a cancel right behind its call, in the same moment, still stops it", () => {
		const { server, calls, sent } = client();
		server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "machines_list" } }));
		server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }));
		return vi.waitFor(() => {
			expect(calls).toHaveLength(1);
			expect(calls[0].signal.aborted).toBe(true);
			expect(sent).toEqual([]);
		});
	});

	test("a method named for what every object has is no method, and does not throw", async () => {
		const { server, sent, ask } = client();
		for (const method of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
			expect(() => server.receive(JSON.stringify({ jsonrpc: "2.0", method }))).not.toThrow();
		}
		expect(sent).toEqual([]);
		expect(await ask("__proto__")).toMatchObject({ error: { code: -32601 } });
	});

	test("a request with an id and no method is invalid, and a response is ignored", () => {
		const { server, sent } = client();
		server.receive(JSON.stringify({ jsonrpc: "2.0", id: 4 }));
		server.receive(JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} }));
		expect(sent).toEqual([{ jsonrpc: "2.0", id: 4, error: { code: -32600, message: "Invalid request" } }]);
	});
});
