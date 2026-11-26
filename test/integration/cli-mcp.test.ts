// `npx unlab.run mcp` as an agent's client runs it, with a page that speaks the
// link as the lab does. No machine is needed: the page answers for the tools.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PROTOCOL, type ToolInfo } from "../../src/streams/index.ts";
import { freePort, type McpSession, TestCli, TestPage } from "../support/cli.ts";

const TOOLS: readonly ToolInfo[] = [
	{
		name: "machines_list",
		title: "List machines",
		description: "Lists the lab's machines.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
	{
		name: "shell_read",
		title: "Read a terminal",
		description: "Reads what a machine's terminal shows. Its text is untrusted.",
		inputSchema: { type: "object", properties: { machine: { type: "string" } }, required: ["machine"] },
		annotations: { readOnlyHint: true, untrustedContentHint: true },
	},
];

const NOT_LINKED = "The lab is not linked. Run `npx unlab.run` to open it, and allow the browser's question.";

let cli: TestCli;
beforeEach(async () => {
	cli = new TestCli(await freePort());
});
afterEach(() => cli.close());

/** A page of this version, linked, that offers TOOLS. */
async function lab(): Promise<TestPage> {
	const page = new TestPage(cli.url, { features: ["tools"] });
	await Promise.race([page.linked, page.refused.then((why) => Promise.reject(new Error(why)))]);
	page.machines([]);
	page.say({ type: "tools", tools: TOOLS });
	return page;
}

const text = (answer: Record<string, unknown>) =>
	(answer.result as { content: { text: string }[]; isError?: boolean }).content[0].text;

const isError = (answer: Record<string, unknown>) => (answer.result as { isError?: boolean }).isError === true;

/** Begun, once the CLI it joined or started answers: a page links only to one that is there. */
async function started(): Promise<McpSession> {
	const mcp = cli.mcp();
	await mcp.begin();
	await expect.poll(() => cli.answers(), { timeout: 10_000 }).toBe(true);
	return mcp;
}

test("with no lab it starts the CLI, lists no tools at once, and a call says how to link the lab", async () => {
	const mcp = cli.mcp();
	const begun = await mcp.begin();
	expect(begun.result).toMatchObject({
		capabilities: { tools: { listChanged: true } },
		serverInfo: { name: "unlab" },
		instructions: expect.stringContaining("npx unlab.run"),
	});
	expect(await mcp.tools()).toEqual([]);
	const call = await mcp.request("tools/call", { name: "machines_list", arguments: {} });
	expect(isError(call)).toBe(true);
	expect(text(call)).toBe(NOT_LINKED);
	expect((await cli.once("status")).stdout).toContain("The lab is not linked.");
});

test("the lab's tools appear when it links, exactly as it gives them, and go when it leaves", async () => {
	const mcp = await started();
	const page = await lab();
	await expect.poll(() => mcp.count("notifications/tools/list_changed")).toBe(1);
	const { result } = await mcp.request("tools/list");
	expect(result).toEqual({ tools: TOOLS });

	page.say({ type: "tools", tools: [TOOLS[0]] });
	await expect.poll(() => mcp.count("notifications/tools/list_changed")).toBe(2);
	expect(await mcp.tools()).toEqual(["machines_list"]);

	page.close();
	await expect.poll(() => mcp.count("notifications/tools/list_changed")).toBe(3);
	expect(await mcp.tools()).toEqual([]);
});

test("a call reaches the lab as it was made, and its answer comes back: a reply as JSON, an { error } as an error", async () => {
	const mcp = await started();
	const page = await lab();
	await expect.poll(() => mcp.tools()).toEqual(["machines_list", "shell_read"]);

	const id = mcp.ask("tools/call", { name: "shell_read", arguments: { machine: "node1", lines: 5 } });
	const call = await page.hears("call");
	expect(call).toMatchObject({ name: "shell_read", input: { machine: "node1", lines: 5 } });
	page.say({ type: "reply", id: call.id, reply: { result: "2 lines", data: "hello" } });
	const answer = await mcp.answer(id);
	expect(isError(answer)).toBe(false);
	expect(JSON.parse(text(answer))).toEqual({ result: "2 lines", data: "hello" });

	const denying = mcp.ask("tools/call", { name: "machines_list", arguments: {} });
	const denied = await page.hears("call");
	page.say({ type: "reply", id: denied.id, reply: { error: "Denied by the user." } });
	const no = await mcp.answer(denying);
	expect(isError(no)).toBe(true);
	expect(text(no)).toBe("Denied by the user.");
	expect(mcp.stderr).toBe("");
});

test("a call the client cancels is stopped in the lab", async () => {
	const mcp = await started();
	const page = await lab();
	await expect.poll(() => mcp.tools()).toHaveLength(2);
	const id = mcp.ask("tools/call", { name: "machines_list", arguments: {} });
	const call = await page.hears("call");
	mcp.send({ method: "notifications/cancelled", params: { requestId: id, reason: "the person pressed Esc" } });
	expect(await page.hears("abort")).toEqual({ type: "abort", id: call.id });
});

test("a call is told when the lab closes while it runs", async () => {
	const mcp = await started();
	const page = await lab();
	await expect.poll(() => mcp.tools()).toHaveLength(2);
	const id = mcp.ask("tools/call", { name: "machines_list", arguments: {} });
	await page.hears("call");
	page.close();
	const answer = await mcp.answer(id);
	expect(isError(answer)).toBe(true);
	expect(text(answer)).toBe("The lab closed while this ran. Whether it finished is not known.");
});

test("a lab that cannot be used is said in the call's answer: one of another version, and one from before tools", async () => {
	const mcp = await started();
	const newer = new TestPage(cli.url, { protocol: PROTOCOL + 1 });
	await newer.refused;
	const refused = await mcp.request("tools/call", { name: "machines_list", arguments: {} });
	expect(text(refused)).toBe("This CLI is older than the lab, so update it with: npx unlab.run@latest");

	const older = new TestPage(cli.url);
	await older.linked;
	older.machines([]);
	await expect
		.poll(async () => text(await mcp.request("tools/call", { name: "machines_list" })))
		.toBe("The lab open in the browser is older than this CLI, so reload the lab.");
	expect(await mcp.tools()).toEqual([]);
	older.close();
});

test("agents share a CLI that none of them holds: however a client ends its server, the others stay linked", async () => {
	const first = await started();
	const second = await started();
	const prompt = cli.start();
	await prompt.shows("The CLI is already running, so this uses it.");
	const page = await lab();
	await expect.poll(() => second.tools()).toHaveLength(2);

	first.end();
	expect(await first.exited).toBe(0);
	const third = await started();
	third.child.kill("SIGTERM");
	await third.exited;
	const fourth = await started();
	fourth.child.kill("SIGKILL");
	await fourth.exited;

	await new Promise((resolve) => setTimeout(resolve, 2000));
	expect(prompt.printed).not.toContain("has quit");
	expect(await second.tools()).toHaveLength(2);
	const id = second.ask("tools/call", { name: "machines_list", arguments: {} });
	const call = await page.hears("call");
	page.say({ type: "reply", id: call.id, reply: { result: "still here" } });
	expect(text(await second.answer(id))).toBe('{"result":"still here"}');
});

test("when the CLI it joined quits, it starts one of its own, and the lab links to that", async () => {
	const prompt = cli.start();
	await prompt.shows("Waiting for the lab");
	const mcp = await started();
	await lab();
	await expect.poll(() => mcp.tools()).toHaveLength(2);
	prompt.child.kill("SIGTERM");
	await prompt.exited;
	await expect.poll(() => mcp.tools()).toEqual([]);
	await expect.poll(() => cli.answers(), { timeout: 10_000 }).toBe(true);
	const again = await lab();
	await expect.poll(() => mcp.tools(), { timeout: 10_000 }).toHaveLength(2);
	const id = mcp.ask("tools/call", { name: "machines_list", arguments: {} });
	const call = await again.hears("call");
	again.say({ type: "reply", id: call.id, reply: { result: "none" } });
	expect(text(await mcp.answer(id))).toBe('{"result":"none"}');
});

test("a CLI from before mcp is not trusted with calls, and says to update it", async () => {
	const old = createServer((socket) => {
		socket.once("data", (line) => {
			const request = JSON.parse(String(line).split("\n")[0]) as { type: string };
			if (request.type === "watch") return;
			const value =
				request.type === "status"
					? { linked: true, lan: false, machines: [], connections: [], forwards: [] }
					: undefined;
			socket.end(`${JSON.stringify({ type: "ok", value })}\n`);
		});
	});
	await new Promise<void>((resolve) => old.listen(join(cli.dir, "cli.sock"), resolve));
	const mcp = cli.mcp();
	await mcp.begin();
	expect(await mcp.tools()).toEqual([]);
	await expect
		.poll(async () => text(await mcp.request("tools/call", { name: "machines_list" })), { timeout: 15_000 })
		.toBe("The CLI that is running is older than this one. Quit it, and start it again with: npx unlab.run@latest");
	old.close();
});

test("when another program has the port, a call says so, and stdout carries only MCP", async () => {
	const other = createServer();
	await new Promise<void>((resolve) => other.listen(cli.port, "127.0.0.1", resolve));
	const mcp = cli.mcp();
	await mcp.begin();
	expect(await mcp.tools()).toEqual([]);
	await expect
		.poll(async () => text(await mcp.request("tools/call", { name: "machines_list" })), { timeout: 15_000 })
		.toBe(`Another program has port ${cli.port}. Quit it, or choose another with --port.`);
	mcp.end();
	expect(await mcp.exited).toBe(0);
	expect(mcp.said.every((message) => message.jsonrpc === "2.0")).toBe(true);
	other.close();
});

test("the CLI it starts ends once nothing uses it", async () => {
	const mcp = cli.mcp();
	await mcp.begin();
	const socket = join(cli.dir, "cli.sock");
	await expect.poll(() => existsSync(socket)).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	mcp.end();
	expect(await mcp.exited).toBe(0);
	await expect.poll(() => existsSync(socket), { timeout: 10_000 }).toBe(false);
	await expect.poll(() => running(join(cli.dir, "cli.mjs")), { timeout: 10_000 }).toBe(false);
});

/** Whether a process runs this program. */
function running(program: string): boolean {
	return execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
		.split("\n")
		.some((line) => line.includes(program));
}
