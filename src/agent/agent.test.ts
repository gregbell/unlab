import { describe, expect, it, vi } from "vitest";
import { arpReply, arpRequest, mac, ping, routedPing } from "../../test/support/frames.ts";
import { createCaptureLog } from "../capture/index.ts";
import { createRegistry, type FilePort, type GuestFile, isLineError, parseLine, VERBS } from "../commands/index.ts";
import {
	type AgentCall,
	createStore,
	initialState,
	isPlanError,
	type MachineName,
	planSpawn,
	type SessionId,
	selectRecent,
	type ToolName,
} from "../model/index.ts";
import { detectModelContext, type ModelContextLike, startAgent, type WebMcpTool } from "./index.ts";

/** The real store and every verb; the runtime stand-in answers vm/stop so removals finish. */
function storeLab(files: FilePort = { write: () => Promise.reject(new Error("This test has no file port.")) }) {
	let held = false;
	const store = createStore(
		initialState([{ name: "alpine", label: "alpine 3.24" }], { width: 1300, height: 500 }),
		(effect) => {
			if (effect.type === "vm/stop" && !held) {
				store.dispatchRuntime({
					type: "vm/stopped",
					machine: effect.machine,
					attempt: effect.attempt,
					clean: true,
					at: 0,
				});
			}
		},
	);
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: (event) => store.dispatchCommand(event),
			until: store.until,
			now: () => store.state.now,
			exec: { inject: () => Promise.reject(new Error("This test has no exec port.")) },
			files,
		},
		VERBS,
	);
	const signal = new AbortController().signal;
	return {
		store,
		registry,
		/** From now on, a worker that is told to stop has not. */
		hold() {
			held = true;
		},
		/** Spawns `count` alpine machines and brings them all to ready. */
		async lab(count: number) {
			const line = parseLine(registry, `spawn ${count} alpine`, store.state);
			if (isLineError(line) || line.danger) throw new Error("spawn should parse and be safe");
			await line.run({ source: "bar", signal });
			for (const machine of store.state.rail) {
				store.dispatchRuntime({ type: "vm/ready", machine, attempt: 1, bootMs: 3582 });
			}
		},
	};
}

/** A browser's modelContext that keeps what is registered. */
function fakeModelContext() {
	const tools = new Map<string, WebMcpTool>();
	return {
		tools,
		registerTool(tool: WebMcpTool, { signal }: { signal: AbortSignal }) {
			tools.set(tool.name, tool);
			signal.addEventListener("abort", () => {
				if (tools.get(tool.name) === tool) tools.delete(tool.name);
			});
		},
	};
}

const ALL_TOOLS: readonly ToolName[] = [
	"lab_help",
	"machines_list",
	"topology_read",
	"machines_spawn",
	"machines_boot",
	"machines_reboot",
	"machines_poweroff",
	"machines_remove",
	"switch_add",
	"switch_remove",
	"switch_cable",
	"switch_uncable",
	"checkpoint_save",
	"checkpoint_restore",
	"checkpoint_remove",
	"shell_exec",
	"shell_read",
	"file_write",
	"link_set",
	"cable_plug",
	"cable_unplug",
	"capture_read",
];

/** An agent over an empty lab, in a browser whose modelContext the test brings. */
function start(modelContext: ModelContextLike | null) {
	const { store, registry } = storeLab();
	const capture = createCaptureLog({ schedule: (fn) => fn(), now: () => 0 });
	const agent = startAgent({ store, registry, screens: { get: () => undefined }, capture, modelContext });
	return { agent, store };
}

async function setup(machines = 2, screens: Partial<Record<SessionId, string>> = {}, files?: FilePort) {
	const lab = storeLab(files);
	await lab.lab(machines);
	const capture = createCaptureLog({ schedule: (fn) => fn(), now: () => 0 });
	const context = fakeModelContext();
	const agent = startAgent({
		store: lab.store,
		registry: lab.registry,
		screens: {
			get: (session) => {
				const text = screens[session];
				return text === undefined ? undefined : { lastLines: (n) => text.split("\n").slice(-n).join("\n") };
			},
		},
		capture,
		modelContext: context,
	});
	const tool = (name: ToolName): WebMcpTool => {
		const found = context.tools.get(name);
		if (!found) throw new Error(`${name} is not registered`);
		return found;
	};
	const call = (name: ToolName, input: unknown, signal?: AbortSignal) => tool(name).execute(input, { signal });
	const calls = (): readonly AgentCall[] => lab.store.state.agent.calls;
	const waiting = () => calls().filter((c) => c.status === "waiting");
	const lastCall = (): AgentCall => {
		const last = calls().at(-1);
		if (!last) throw new Error("no calls yet");
		return last;
	};
	const policy = (tool: ToolName, value: "run" | "ask" | "off") =>
		lab.store.dispatchUi({ type: "ui/policy", tool, policy: value });
	const barError = (line: string) => {
		const parsed = parseLine(lab.registry, line, lab.store.state);
		if (isLineError(parsed)) return parsed.message;
		const invalid = parsed.validate(lab.store.state);
		if (!invalid) throw new Error(`${line} is fine in the bar`);
		return invalid.message;
	};
	return { lab, store: lab.store, capture, context, agent, call, calls, waiting, lastCall, policy, barError };
}

/** Lets a promise that is about to settle do so, so a test can see one that has not. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function pending(promise: Promise<unknown>) {
	let state: "pending" | "resolved" | "rejected" = "pending";
	promise.then(
		() => {
			state = "resolved";
		},
		() => {
			state = "rejected";
		},
	);
	return () => state;
}

/** A reply the agent reads as a failure, saying at least this. */
const refusal = (sentence: string) => ({ error: expect.stringContaining(sentence) });

describe("registration", () => {
	it("registers every tool in the handoff's table with its annotations", async () => {
		const { context } = await setup();
		expect([...context.tools.keys()].sort()).toEqual([...ALL_TOOLS].sort());
		expect(context.tools.get("machines_list")?.annotations).toEqual({ readOnlyHint: true });
		expect(context.tools.get("machines_remove")?.annotations).toEqual({ consequentialHint: true });
		expect(context.tools.get("shell_exec")?.annotations).toEqual({ untrustedContentHint: true });
		expect(context.tools.get("shell_read")?.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
		expect(context.tools.get("capture_read")?.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
	});

	it("titles every tool, and keeps what it says about itself within the lengths Chrome recommends", async () => {
		const { context } = await setup();
		expect([...context.tools.values()].map((tool) => tool.title).sort()).toEqual([
			"Add a switch",
			"Boot machines",
			"Cable two switches together",
			"Delete a checkpoint",
			"Explain the lab's verbs",
			"List machines",
			"Plug a NIC into a switch",
			"Plug in or cut cables",
			"Power machines off",
			"Power machines on",
			"Read a terminal",
			"Read captured frames",
			"Read the topology",
			"Reboot machines",
			"Remove a cable between switches",
			"Remove a switch",
			"Remove machines",
			"Restore a checkpoint",
			"Run a shell command",
			"Save a checkpoint",
			"Unplug a NIC",
			"Write a file",
		]);
		const long = [...context.tools.values()].flatMap(({ name, description, inputSchema }) => [
			...(name.length > 30 ? [name] : []),
			...(description.length > 500 ? [`${name} description`] : []),
			...Object.entries(inputSchema.properties ?? {}).flatMap(([field, schema]) =>
				field.length > 30 || (schema.description ?? "").length > 150 ? [`${name} ${field}`] : [],
			),
		]);
		expect(long).toEqual([]);
	});

	it("lists the tools in the handoff's order with their arguments", async () => {
		const { agent } = await setup();
		expect(agent.tools.map((t) => t.name)).toEqual(ALL_TOOLS);
		expect(agent.tools.find((t) => t.name === "shell_read")?.args).toEqual(["machine", "lines"]);
		expect(agent.tools.find((t) => t.name === "capture_read")?.args).toEqual(["filter", "limit"]);
		expect(agent.tools.find((t) => t.name === "machines_list")?.args).toEqual([]);
	});

	it("unregisters a tool set to off and keeps the others", async () => {
		const { context, policy } = await setup();
		policy("machines_list", "off");
		expect(context.tools.has("machines_list")).toBe(false);
		expect(context.tools.size).toBe(ALL_TOOLS.length - 1);
		policy("machines_list", "ask");
		expect(context.tools.has("machines_list")).toBe(true);
	});

	it("unregisters everything while tools are paused, and brings back all but those off", async () => {
		const { context, store, policy } = await setup();
		policy("link_set", "off");
		store.dispatchUi({ type: "ui/tools-paused", paused: true });
		expect(context.tools.size).toBe(0);
		store.dispatchUi({ type: "ui/tools-paused", paused: false });
		expect([...context.tools.keys()].sort()).toEqual(ALL_TOOLS.filter((t) => t !== "link_set").sort());
	});

	it("refuses a call that arrives after its tool was turned off", async () => {
		const { context, policy, lastCall } = await setup();
		const list = context.tools.get("machines_list");
		policy("machines_list", "off");
		await expect(list?.execute({}, {})).resolves.toEqual(refusal("machines_list is off in the agent panel."));
		expect(lastCall()).toMatchObject({ status: "failed", tool: "machines_list" });
	});

	it("says in the store what the browser made of the tools", async () => {
		const { store } = await setup();
		expect(store.state.agent.webmcp).toEqual({ kind: "registered" });
	});

	it("does nothing without WebMCP, and says so", () => {
		const { agent, store } = start(null);
		store.dispatchUi({ type: "ui/tools-paused", paused: true });
		expect(store.state.agent.webmcp).toEqual({ kind: "absent" });
		expect(agent.tools).toHaveLength(ALL_TOOLS.length);
	});

	it.each([
		[
			"throws",
			() => {
				throw new Error("Tools are not allowed in this frame.");
			},
		],
		["rejects", () => Promise.reject(new Error("Tools are not allowed in this frame."))],
	])(
		"says the browser refused the tools when registerTool %s, and does not try again on every change",
		async (_, refuse) => {
			const registerTool = vi.fn(refuse);
			const { store } = start({ registerTool });
			const refused = { kind: "refused", message: "Tools are not allowed in this frame." };
			await expect.poll(() => store.state.agent.webmcp).toEqual(refused);
			store.dispatchUi({ type: "ui/tools-paused", paused: true });
			await turn();
			expect(store.state.agent.webmcp).toEqual(refused);
			expect(registerTool).toHaveBeenCalledTimes(ALL_TOOLS.length);
		},
	);

	it("takes the refusal back once the browser accepts the tools, or the refused tool is off", async () => {
		const context = fakeModelContext();
		let refuse = true;
		const { store } = start({
			registerTool(tool, options) {
				if (refuse && tool.name === "link_set") throw new Error("No link_set here.");
				context.registerTool(tool, options);
			},
		});
		expect(store.state.agent.webmcp).toEqual({ kind: "refused", message: "No link_set here." });
		store.dispatchUi({ type: "ui/policy", tool: "link_set", policy: "off" });
		expect(store.state.agent.webmcp).toEqual({ kind: "registered" });
		store.dispatchUi({ type: "ui/policy", tool: "link_set", policy: "ask" });
		expect(store.state.agent.webmcp).toEqual({ kind: "refused", message: "No link_set here." });
		refuse = false;
		store.dispatchUi({ type: "ui/tools-paused", paused: true });
		store.dispatchUi({ type: "ui/tools-paused", paused: false });
		expect(store.state.agent.webmcp).toEqual({ kind: "registered" });
	});

	it("does not take its own unregistering for a refusal", async () => {
		const { store } = start({
			registerTool: (_tool, { signal }) =>
				new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
		});
		store.dispatchUi({ type: "ui/tools-paused", paused: true });
		await turn();
		expect(store.state.agent.webmcp).toEqual({ kind: "registered" });
	});

	it("stops registering once disposed", async () => {
		const { context, agent, policy } = await setup();
		agent.dispose();
		expect(context.tools.size).toBe(0);
		policy("machines_list", "ask");
		expect(context.tools.size).toBe(0);
	});
});

describe("detectModelContext", () => {
	const ctx = { registerTool: () => undefined };
	const probe: WebMcpTool = {
		name: "probe",
		title: "Probe",
		description: "",
		inputSchema: {},
		annotations: {},
		execute: async () => null,
	};
	const options = { signal: new AbortController().signal };
	it("prefers document.modelContext", () => {
		const other = { registerTool: () => "navigator" };
		const found = detectModelContext({ modelContext: ctx }, { modelContext: other });
		expect(found?.registerTool(probe, options)).toBeUndefined();
	});
	it("falls back to navigator.modelContext from earlier drafts", () => {
		const other = { registerTool: () => "navigator" };
		expect(detectModelContext({}, { modelContext: other })?.registerTool(probe, options)).toBe("navigator");
	});
	it("finds the calling half where the browser has it", async () => {
		const full = {
			...ctx,
			tools: ["a"],
			getTools() {
				return this.tools;
			},
			executeTool: () => "ran",
		};
		const found = detectModelContext({ modelContext: full }, {});
		expect(found?.getTools?.()).toEqual(["a"]);
		expect(found?.executeTool?.("a", {})).toBe("ran");
		expect(detectModelContext({ modelContext: ctx }, {})?.getTools).toBeUndefined();
	});
	it("is null when neither has a registerTool", () => {
		expect(detectModelContext({}, {})).toBeNull();
		expect(detectModelContext({ modelContext: {} }, { modelContext: 3 })).toBeNull();
	});
});

describe("a tool set to run", () => {
	it("runs at once, logs the bar line as the agent's, and settles with a short result", async () => {
		const { call, lastCall, store } = await setup();
		const reply = await call("machines_list", {});
		expect(reply).toMatchObject({ result: "2 machines · 2 ready", data: [{ name: "node1" }, { name: "node2" }] });
		expect(lastCall()).toMatchObject({
			tool: "machines_list",
			line: "ls",
			status: "done",
			result: "2 machines · 2 ready",
			via: "webmcp",
		});
		expect(selectRecent(store.state)[0]).toMatchObject({ line: "ls", source: "agent", outcome: "ok" });
		expect(store.state.agent.firstCallAt).not.toBeNull();
	});

	it("cuts a cable in bar grammar", async () => {
		const { call, lastCall, store } = await setup();
		await call("link_set", { link: "down", machines: "node2" });
		expect(lastCall()).toMatchObject({ line: "link down node2", status: "done", result: "node2 cut" });
		expect(store.state.log.at(-1)).toMatchObject({ line: "link down node2", source: "agent" });
	});

	it("runs a dangerous verb without asking when the person set it to run", async () => {
		const { call, policy, store, waiting } = await setup();
		policy("machines_remove", "run");
		await expect(call("machines_remove", { names: "node2" })).resolves.toMatchObject({ data: { removed: ["node2"] } });
		expect(waiting()).toEqual([]);
		expect(store.state.machines.node2).toBeUndefined();
	});
});

describe("trying a call", () => {
	function callable() {
		const context = fakeModelContext();
		return {
			...context,
			getTools: async () => [...context.tools.values()].map(({ name }) => ({ name })),
			executeTool: async (tool: unknown, input: object) => {
				const name = Reflect.get(Object(tool), "name");
				return JSON.stringify(await context.tools.get(name)?.execute(input, {}));
			},
		};
	}

	it("goes through the browser, so it is logged as an agent's call", async () => {
		const { agent, store } = start(callable());
		await agent.tryCall?.();
		expect(store.state.agent.calls).toMatchObject([{ tool: "machines_list", line: "ls", status: "done" }]);
	});

	it("says so when the browser does not list the tool", async () => {
		const { agent, store } = start(callable());
		store.dispatchUi({ type: "ui/policy", tool: "machines_list", policy: "off" });
		await expect(agent.tryCall?.()).rejects.toThrow("The browser does not list machines_list.");
	});

	it("is not offered where a page cannot call tools", () => {
		expect(start(fakeModelContext()).agent.tryCall).toBeNull();
		expect(start(null).agent.tryCall).toBeNull();
	});
});

describe("bad input", () => {
	it("returns the verb's own sentence, as the bar says it", async () => {
		const { call, barError, lastCall, store } = await setup();
		const expected = barError("rm node9");
		await expect(call("machines_remove", { names: "node9" })).resolves.toEqual(refusal(expected));
		expect(lastCall()).toMatchObject({ line: "rm node9", status: "failed", result: expected });
		expect(store.state.machines.node1).toBeDefined();
	});

	it("checks fields itself rather than trusting the browser's schema check", async () => {
		const { call, waiting } = await setup();
		await expect(call("machines_remove", { names: "node2", force: true })).resolves.toEqual(
			refusal("no field called force"),
		);
		await expect(call("machines_spawn", { count: "lots", image: "alpine" })).resolves.toEqual(
			refusal("Nothing was changed."),
		);
		await expect(call("shell_exec", { targets: "node1", command: "a\nb" })).resolves.toEqual(refusal("one line"));
		await expect(call("machines_list", "ls")).resolves.toEqual(refusal("object of fields"));
		expect(waiting()).toEqual([]);
	});

	it("refuses an argument that would sneak in an option", async () => {
		const { call, store } = await setup();
		await expect(call("machines_remove", { names: "--all" })).resolves.toEqual({ error: expect.any(String) });
		expect(store.state.rail).toEqual(["node1", "node2"]);
	});
});

describe("a tool set to ask", () => {
	it("waits with the command's own preview and action, and runs once allowed", async () => {
		const { call, waiting, agent, store } = await setup();
		const removing = call("machines_remove", { names: "node2" });
		const state = pending(removing);
		await turn();
		expect(state()).toBe("pending");
		const [block] = waiting();
		expect(block).toMatchObject({ tool: "machines_remove", line: "rm node2", actionLabel: "Remove node2" });
		expect(block?.preview).toContain("There is no undo.");
		expect(store.state.machines.node2).toBeDefined();

		agent.answer(block?.id ?? -1, true);
		await expect(removing).resolves.toMatchObject({ result: "removed node2", data: { removed: ["node2"] } });
		expect(store.state.machines.node2).toBeUndefined();
		expect(store.state.agent.calls.find((c) => c.id === block?.id)).toMatchObject({
			status: "done",
			result: "removed node2",
		});
		expect(store.state.log.at(-1)).toMatchObject({ line: "rm node2", source: "agent", outcome: "ok" });
	});

	it("answers that the user denied it after Deny and changes nothing", async () => {
		const { call, waiting, agent, store } = await setup();
		const removing = call("machines_remove", { names: "node2" });
		await turn();
		const id = waiting()[0]?.id ?? -1;
		agent.answer(id, false);
		await expect(removing).resolves.toEqual({ error: "Denied by the user." });
		expect(store.state.machines.node2).toBeDefined();
		expect(store.state.agent.calls.find((c) => c.id === id)).toMatchObject({
			status: "denied",
			result: "Denied by the user.",
		});
		expect(store.state.log.some((entry) => entry.line === "rm node2")).toBe(false);
	});

	it("takes the block away when the agent aborts, and rejects with the agent's reason", async () => {
		const { call, waiting, agent, store } = await setup();
		const controller = new AbortController();
		const removing = call("machines_remove", { names: "node2" }, controller.signal);
		await turn();
		const id = waiting()[0]?.id ?? -1;
		controller.abort(new Error("the agent gave up"));
		await expect(removing).rejects.toThrow("the agent gave up");
		expect(waiting()).toEqual([]);
		expect(store.state.agent.calls.find((c) => c.id === id)?.status).toBe("aborted");
		agent.answer(id, true);
		await turn();
		expect(store.state.machines.node2).toBeDefined();
	});

	it("waits however long the person takes", async () => {
		const { call, waiting, agent, store } = await setup();
		const removing = call("machines_remove", { names: "node2" });
		const state = pending(removing);
		await turn();
		store.dispatchRuntime({ type: "tick", now: 10 * 60 * 60_000 });
		await turn();
		expect(state()).toBe("pending");
		expect(waiting()).toHaveLength(1);
		agent.answer(waiting()[0]?.id ?? -1, true);
		await expect(removing).resolves.toMatchObject({ data: { removed: ["node2"] } });
	});

	it("stacks waiting calls oldest first and answers each on its own", async () => {
		const { call, waiting, agent, store } = await setup(3);
		const first = call("machines_remove", { names: "node3" });
		const second = call("machines_remove", { names: "node2" });
		await turn();
		expect(waiting().map((c) => c.line)).toEqual(["rm node3", "rm node2"]);
		agent.answer(waiting()[1]?.id ?? -1, false);
		await expect(second).resolves.toEqual({ error: "Denied by the user." });
		expect(waiting().map((c) => c.line)).toEqual(["rm node3"]);
		agent.answer(waiting()[0]?.id ?? -1, true);
		await first;
		expect(store.state.rail).toEqual(["node1", "node2"]);
	});

	it("names a safe verb's button for what it does", async () => {
		const { call, waiting, agent } = await setup();
		const spawning = call("machines_spawn", { count: 1, image: "alpine" });
		await turn();
		expect(waiting()[0]).toMatchObject({ line: "spawn 1 alpine", actionLabel: "Boot node3" });
		expect(waiting()[0]?.preview).toMatch(/^Will boot node3 · alpine 3\.24/);
		agent.answer(waiting()[0]?.id ?? -1, true);
		await expect(spawning).resolves.toMatchObject({ data: { names: ["node3"] } });
	});

	it("fails the call in its own words when the lab changed while it waited", async () => {
		const { call, waiting, agent, lab, lastCall } = await setup();
		const removing = call("machines_remove", { names: "node2" });
		await turn();
		const id = waiting()[0]?.id ?? -1;
		const gone: MachineName = "node2";
		lab.store.dispatchCommand({ type: "cmd/remove", machines: [gone], cause: "bar" });
		expect(lab.store.state.machines[gone]).toBeUndefined();
		agent.answer(id, true);
		await expect(removing).resolves.toEqual(refusal("No machine is called node2, so use node1."));
		expect(lastCall()).toMatchObject({ id, status: "failed" });
	});
});

describe("a machine that changes while a call waits", () => {
	it.each([
		["machines_poweroff", { names: "node2" }, "poweroff wants a ready machine here, and node2 is being removed."],
		[
			"link_set",
			{ link: "down", machines: "node2" },
			"link wants a ready or off machine here, and node2 is being removed.",
		],
		[
			"file_write",
			{ machine: "node2", path: "/a", text: "" },
			"write wants a ready machine here, and node2 is being removed.",
		],
		[
			"checkpoint_save",
			{ machine: "node2", checkpoint: "a" },
			"checkpoint wants a ready or off machine here, and node2 is being removed.",
		],
	] as const)("is named with its state by %s", async (tool, input, sentence) => {
		const { agent, call, lab, policy, waiting } = await setup();
		policy(tool, "ask");
		const reply = call(tool, input);
		const [asked] = waiting();
		lab.hold();
		lab.store.dispatchCommand({ type: "cmd/remove", machines: ["node2"], cause: "bar" });
		agent.answer(asked.id, true);
		await expect(reply).resolves.toEqual({ error: `${sentence} Nothing was changed.` });
	});
});

describe("file_write", () => {
	const text = "one\n  two\n\nnode1 four\n";
	const input = { machine: "node1", path: "/etc/motd", text };
	const writing = async () => {
		const written: GuestFile[] = [];
		const t = await setup(
			1,
			{},
			{
				async write(_, file) {
					written.push(file);
					return { kind: "written", path: file.path, owner: "root:root", mode: "644" };
				},
			},
		);
		return { ...t, written };
	};

	it("runs at once, and the panel and the log leave a text of several lines out", async () => {
		const { call, lastCall, store, written } = await writing();
		expect(await call("file_write", input)).toEqual({
			result: "wrote /etc/motd on node1 · 4 lines, 22 bytes · root:root 644",
			data: { machine: "node1", path: "/etc/motd", bytes: 22, owner: "root:root", mode: "644" },
		});
		expect(written).toEqual([{ path: "/etc/motd", text, owner: null, mode: null }]);
		expect(lastCall()).toMatchObject({
			line: "write node1 /etc/motd",
			status: "done",
			result: "wrote /etc/motd on node1 · 4 lines, 22 bytes · root:root 644",
		});
		expect(store.state.log.at(-1)).toMatchObject({ line: "write node1 /etc/motd", source: "agent" });
		await call("file_write", { ...input, machine: "node9" });
		expect(lastCall()).toMatchObject({ line: "write node9 /etc/motd", status: "failed" });
	});

	it("shows the text to the person who is asked, and how much more there is of a long one", async () => {
		const { agent, call, policy, waiting, written } = await writing();
		policy("file_write", "ask");
		const reply = call("file_write", { ...input, mode: "600" });
		expect(waiting()).toMatchObject([
			{
				line: "write node1 /etc/motd --mode 600",
				preview: `Will write /etc/motd on node1 · 4 lines, 22 bytes · mode 600.\n${text}`,
				actionLabel: "Write /etc/motd on node1",
			},
		]);
		expect(written).toEqual([]);
		agent.answer(waiting()[0].id, true);
		await reply;
		expect(written).toMatchObject([{ text }]);
		void call("file_write", { ...input, text: "x".repeat(10_005) });
		expect(waiting()[0].preview).toMatch(/\.\nx{10000}…\n\(5 more characters are not shown\)$/);
		void call("file_write", { ...input, text: "short" });
		expect(waiting()[1]).toMatchObject({
			line: "write node1 /etc/motd -- short",
			preview: "Will write /etc/motd on node1 · 1 line, 5 bytes.",
		});
	});
});

describe("shell_read", () => {
	it("returns the last lines of a machine's active session", async () => {
		const { call, lastCall } = await setup(2, { "node2:console": "one\ntwo\nthree" });
		await expect(call("shell_read", { machine: "node2", lines: 2 })).resolves.toEqual({
			session: "node2:console",
			text: "two\nthree",
		});
		expect(lastCall()).toMatchObject({
			line: "shell_read(node2, 2)",
			status: "done",
			result: "2 lines from node2:console",
		});
	});

	it("says which machines exist when it is asked for one that does not", async () => {
		const { call } = await setup();
		await expect(call("shell_read", { machine: "node9" })).resolves.toEqual(
			refusal("No machine is called node9, so use node1 or node2."),
		);
		await expect(call("shell_read", { machine: "node1", lines: 0 })).resolves.toEqual(
			refusal("whole number from 1 to 500"),
		);
		await expect(call("shell_read", { machine: "node1:sh4" })).resolves.toEqual(
			refusal("node1 has no session called sh4"),
		);
	});

	it("does not log a line, because nothing ran", async () => {
		const { call, store } = await setup();
		const before = store.state.log.length;
		await call("shell_read", { machine: "node1" });
		expect(store.state.log.length).toBe(before);
	});
});

describe("capture_read", () => {
	it("returns the newest matching frames as decoded rows, oldest first", async () => {
		const { call, capture, lastCall } = await setup();
		capture.appendFrame({ switch: "switch0", from: 1, to: 0b10, flood: "group", frame: arpRequest(1, 2) });
		capture.appendFrame({ switch: "switch0", from: 2, to: 0b01, flood: null, frame: arpReply(2, 1) });
		capture.appendFrame({ switch: "switch0", from: 1, to: 0b10, flood: null, frame: ping(1, 2) });
		const reply = await call("capture_read", { filter: "arp", limit: 1 });
		expect(reply).toMatchObject({
			rows: [{ kind: "frame", proto: "ARP", from: { name: "node2" }, to: { name: "node1" } }],
		});
		expect(lastCall()).toMatchObject({ line: 'capture_read("arp", 1)', result: "1 frame" });
		await expect(call("capture_read", {})).resolves.toMatchObject({ rows: { length: 3 } });
	});

	it("says which NIC of a machine with several, and filters by it", async () => {
		const { call, capture, store } = await setup();
		const plan = planSpawn(store.state, 1, {
			image: "alpine",
			memMiB: 256,
			disks: { root: "4", extra: [] },
			gateway: true,
			nics: [
				{ net: "switch0", address: "default" },
				{ net: "switch0", address: null },
			],
		});
		if (isPlanError(plan)) throw new Error("cannot spawn");
		store.dispatchCommand({ type: "cmd/spawn", plan, at: 0 });
		capture.appendFrame({
			switch: "switch0",
			from: 1,
			to: 0b100,
			flood: null,
			frame: routedPing(mac(1), mac(3), 1, 2),
		});
		capture.appendFrame({
			switch: "switch0",
			from: 4,
			to: 0b10,
			flood: null,
			frame: routedPing(mac(3, 1), mac(2), 1, 2),
		});
		await expect(call("capture_read", {})).resolves.toMatchObject({
			rows: [
				{ from: { kind: "machine", name: "node1" }, to: { name: "node3", nic: "eth0" } },
				{ from: { name: "node3", nic: "eth1" }, to: { kind: "machine", name: "node2" } },
			],
		});
		await expect(call("capture_read", { filter: "node3:eth1" })).resolves.toMatchObject({
			rows: [{ from: { name: "node3", nic: "eth1" } }],
		});
	});

	it("refuses a filter the capture panel would refuse", async () => {
		const { call } = await setup();
		await expect(call("capture_read", { filter: "arp or" })).resolves.toEqual(
			refusal("Capture needs a term on each side of or, such as arp or icmp."),
		);
	});
});

describe("an agent outside the browser", () => {
	it("is offered exactly the tools an agent in the browser would get, also where the browser has no WebMCP", async () => {
		const { agent, store } = start(null);
		const offered = () => agent.offered().map((tool) => tool.name);
		expect(offered()).toEqual(ALL_TOOLS);
		expect(agent.offered().find((tool) => tool.name === "shell_read")).toMatchObject({
			title: expect.any(String),
			description: expect.any(String),
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true, untrustedContentHint: true },
		});
		expect(agent.offered()[0]).not.toHaveProperty("execute");
		store.dispatchUi({ type: "ui/policy", tool: "shell_exec", policy: "off" });
		expect(offered()).toEqual(ALL_TOOLS.filter((name) => name !== "shell_exec"));
		store.dispatchUi({ type: "ui/tools-paused", paused: true });
		expect(offered()).toEqual([]);
	});

	it("calls a tool by name through the panel's policies, as WebMCP does", async () => {
		const { agent, waiting, store } = await setup();
		await expect(agent.call("machines_list", {}, new AbortController().signal)).resolves.toMatchObject({
			data: [expect.objectContaining({ name: "node1" }), expect.objectContaining({ name: "node2" })],
		});
		const removing = agent.call("machines_remove", { names: "node2" }, new AbortController().signal);
		await turn();
		agent.answer(waiting()[0]?.id ?? -1, false);
		await expect(removing).resolves.toEqual({ error: "Denied by the user." });
		expect(store.state.machines.node2).toBeDefined();
		expect(store.state.agent.calls.map((c) => c.via)).toEqual(["cli", "cli"]);
	});

	it("withdraws a waiting call when the agent gives up", async () => {
		const { agent, waiting, store } = await setup();
		const controller = new AbortController();
		const removing = agent.call("machines_remove", { names: "node2" }, controller.signal);
		await turn();
		controller.abort(new Error("Stopped from the CLI."));
		await expect(removing).rejects.toThrow("Stopped from the CLI.");
		expect(waiting()).toEqual([]);
		expect(store.state.agent.calls.at(-1)?.status).toBe("aborted");
	});

	it("answers a name that is no tool in a sentence", async () => {
		const { agent } = start(null);
		await expect(agent.call("machines_explode", {}, new AbortController().signal)).resolves.toEqual({
			error: "There is no tool called machines_explode.",
		});
	});
});
