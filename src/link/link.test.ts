import { beforeEach, describe, expect, test, vi } from "vitest";
import { createRegistry, isLineError, parseLine, VERBS } from "../commands/index.ts";
import { createStore, initialState } from "../model/index.ts";
import type { FromCli, FromLab } from "../streams/index.ts";
import { FORGOTTEN, type LinkDeps, type LinkMemory, type LinkSocket, linkAsked, startLink } from "./link.ts";

/** The real store and every verb; the runtime stand-in answers vm/stop so removals finish. */
function storeLab() {
	const store = createStore(
		initialState([{ name: "alpine", label: "alpine 3.24" }], { width: 1300, height: 500 }),
		(effect) => {
			if (effect.type !== "vm/stop") return;
			const { machine, attempt } = effect;
			store.dispatchRuntime({ type: "vm/stopped", machine, attempt, clean: true, at: 0 });
		},
	);
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: (event) => store.dispatchCommand(event),
			until: store.until,
			now: () => store.state.now,
			exec: { inject: () => Promise.reject(new Error("This test has no exec port.")) },
			files: { write: () => Promise.reject(new Error("This test has no file port.")) },
		},
		VERBS,
	);
	const run = async (text: string) => {
		const line = parseLine(registry, text, store.state);
		if (isLineError(line) || line.danger) throw new Error(`${text} should parse and be safe`);
		await line.run({ source: "bar", signal: new AbortController().signal });
	};
	return {
		store,
		registry,
		run,
		/** Spawns `count` alpine machines and brings them all to ready. */
		async lab(count: number) {
			await run(`spawn ${count} alpine`);
			for (const machine of store.state.rail) {
				store.dispatchRuntime({ type: "vm/ready", machine, attempt: 1, bootMs: 3582 });
			}
		},
	};
}

class FakeSocket implements LinkSocket {
	readonly said: FromLab[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { readonly data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(readonly url: string) {}
	send(text: string) {
		this.said.push(JSON.parse(text));
	}
	close() {
		this.closed = true;
		this.onclose?.();
	}
	hears(message: FromCli) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	/** The CLI takes the lab. */
	takes() {
		this.onopen?.();
		this.hears({ type: "hello", protocol: 1, token: "secret" });
	}
	last<T extends FromLab["type"]>(type: T) {
		return this.said.findLast((m): m is Extract<FromLab, { type: T }> => m.type === type);
	}
}

function rig(memory: LinkMemory = FORGOTTEN) {
	const lab = storeLab();
	const sockets: FakeSocket[] = [];
	const ticks = new Set<() => void>();
	const targets: unknown[] = [];
	const state = { memory, permission: "granted" as PermissionState | null };
	const deps: LinkDeps = {
		store: lab.store,
		registry: lab.registry,
		dial(url) {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		memory: {
			read: () => state.memory,
			write: (next) => {
				state.memory = next;
			},
		},
		everySecond(fn) {
			ticks.add(fn);
			return () => ticks.delete(fn);
		},
		permission: async () => state.permission,
		machines: (target) => targets.push(target),
	};
	const link = startLink(deps);
	const second = async () => {
		for (const tick of ticks) tick();
		await vi.waitFor(() => {});
		await Promise.resolve();
	};
	const linked = async () => {
		await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
		const socket = sockets[sockets.length - 1];
		socket.takes();
		return socket;
	};
	return { lab, link, sockets, ticks, targets, state, second, linked, cli: () => lab.store.state.cli };
}

test("a lab that was never asked to link dials nothing and keeps no clock", async () => {
	const { sockets, ticks, cli, second } = rig();
	await second();
	expect(sockets).toEqual([]);
	expect(ticks.size).toBe(0);
	expect(cli()).toEqual({ kind: "off" });
});

test("one that has linked before dials by itself, again each second until the CLI is there", async () => {
	const { sockets, second, cli, targets, linked } = rig({ on: true, port: 47122 });
	await vi.waitFor(() => expect(sockets).toHaveLength(1));
	expect(sockets[0].url).toBe("ws://127.0.0.1:47122/lab");
	expect(cli()).toEqual({ kind: "waiting" });
	sockets[0].onclose?.();
	await second();
	expect(sockets).toHaveLength(2);
	const socket = await linked();
	expect(socket.said[0]).toEqual({ type: "hello", protocol: 1 });
	expect(cli()).toEqual({ kind: "linked" });
	expect(targets).toEqual([{ url: "ws://127.0.0.1:47122", token: "secret" }]);
	expect(socket.last("machines")).toEqual({ type: "machines", machines: [] });

	// It does not dial over a link it has.
	await second();
	expect(sockets).toHaveLength(2);
	socket.onclose?.();
	expect(cli()).toEqual({ kind: "waiting" });
	expect(targets.at(-1)).toBeNull();
});

test("turned off, it hangs up, stops trying and is remembered as off", async () => {
	const { link, sockets, ticks, cli, state, linked, targets } = rig();
	link.set(true);
	const socket = await linked();
	expect(state.memory).toEqual({ on: true, port: 47122 });
	link.set(false);
	expect(socket.closed).toBe(true);
	expect(ticks.size).toBe(0);
	expect(cli()).toEqual({ kind: "off" });
	expect(targets.at(-1)).toBeNull();
	expect(state.memory).toEqual({ on: false, port: 47122 });
	expect(sockets).toHaveLength(1);
});

test("a CLI elsewhere is dialled there, instead of the one before", async () => {
	const { link, sockets, linked } = rig({ on: true, port: 47122 });
	const first = await linked();
	link.set(true, 5000);
	expect(first.closed).toBe(true);
	await vi.waitFor(() => expect(sockets.at(-1)?.url).toBe("ws://127.0.0.1:5000/lab"));
});

test("without the browser's permission it says so and dials nothing, until it is given", async () => {
	const { link, sockets, state, second, cli } = rig();
	state.permission = "denied";
	link.set(true);
	await vi.waitFor(() => expect(cli()).toEqual({ kind: "blocked" }));
	expect(sockets).toEqual([]);
	state.permission = "granted";
	await second();
	expect(sockets).toHaveLength(1);
});

test("a CLI that does not take the lab is said, and tried again without flicker", async () => {
	const { link, sockets, second, cli } = rig();
	link.set(true);
	await vi.waitFor(() => expect(sockets).toHaveLength(1));
	sockets[0].onopen?.();
	sockets[0].hears({ type: "refused", message: "This CLI is older than the lab." });
	sockets[0].onclose?.();
	expect(cli()).toEqual({ kind: "refused", message: "This CLI is older than the lab." });
	await second();
	expect(sockets).toHaveLength(2);
	expect(cli().kind).toBe("refused");
});

test("machines are told as they come and change", async () => {
	const { link, lab, linked } = rig();
	link.set(true);
	const socket = await linked();
	await lab.lab(1);
	expect(socket.last("machines")?.machines).toEqual([{ n: 1, name: "node1", image: "alpine", state: "ready" }]);
	const before = socket.said.length;
	await lab.run("sh node1");
	expect(socket.said).toHaveLength(before);
});

describe("a line from the CLI", () => {
	let r: ReturnType<typeof rig>;
	let socket: FakeSocket;
	beforeEach(async () => {
		r = rig();
		r.link.set(true);
		socket = await r.linked();
		await r.lab.lab(2);
	});

	const result = async (id: number) => {
		await vi.waitFor(() => expect(socket.last("result")?.id).toBe(id));
		return socket.last("result")?.result;
	};

	test("runs through the bar's parser, answers as the agent's tool does, and is logged as the CLI's", async () => {
		socket.hears({ type: "run", id: 1, line: "ls" });
		expect(await result(1)).toMatchObject({
			ok: true,
			text: "2 machines · 2 ready",
			blocks: [
				{ machine: "node1", status: "ready", output: null },
				{ machine: "node2", status: "ready", output: null },
			],
			reply: { result: "2 machines · 2 ready", data: [{ name: "node1" }, { name: "node2" }] },
		});
		expect(r.lab.store.state.log.at(-1)).toMatchObject({ line: "ls", source: "cli", outcome: "ok" });
	});

	test("that cannot run answers with the lab's sentence and its fix", async () => {
		socket.hears({ type: "run", id: 1, line: "spwn 1 alpine" });
		expect(await result(1)).toMatchObject({
			ok: false,
			fix: "spawn 1 alpine",
			message: expect.stringContaining("Nothing was changed."),
		});
	});

	test("that asks first asks in the terminal, whatever the agent panel says, and runs on a yes", async () => {
		r.lab.store.dispatchUi({ type: "ui/policy", tool: "machines_remove", policy: "off" });
		socket.hears({ type: "run", id: 1, line: "rm node2" });
		await vi.waitFor(() => expect(socket.last("ask")).toMatchObject({ id: 1, asking: { question: "Remove node2?" } }));
		expect(r.lab.store.state.machines.node2?.life.phase).toBe("ready");
		socket.hears({ type: "answer", id: 1, yes: true });
		await vi.waitFor(() => expect(r.lab.store.state.machines.node2).toBeUndefined());
		expect(await result(1)).toMatchObject({ ok: true, text: "removed node2" });
	});

	test("that asks first does nothing on a no", async () => {
		socket.hears({ type: "run", id: 1, line: "rm node2" });
		await vi.waitFor(() => expect(socket.last("ask")).toBeDefined());
		socket.hears({ type: "answer", id: 1, yes: false });
		expect(await result(1)).toEqual({ ok: false, message: "You did not say yes. Nothing was changed.", fix: null });
		expect(r.lab.store.state.machines.node2?.life.phase).toBe("ready");
	});

	test("that is asked about when the CLI quits does nothing", async () => {
		socket.hears({ type: "run", id: 1, line: "rm node2" });
		await vi.waitFor(() => expect(socket.last("ask")).toBeDefined());
		socket.onclose?.();
		await Promise.resolve();
		expect(r.lab.store.state.machines.node2?.life.phase).toBe("ready");
	});

	test("that was asked by a CLI that quit is not answered to the next", async () => {
		socket.hears({ type: "run", id: 1, line: "rm node2" });
		await vi.waitFor(() => expect(socket.last("ask")).toBeDefined());
		socket.onclose?.();
		await r.second();
		const next = r.sockets[r.sockets.length - 1];
		expect(next).not.toBe(socket);
		next.takes();
		await r.second();
		expect(next.last("result")).toBeUndefined();
	});

	test("is completed by the lab's own completer", () => {
		socket.hears({ type: "complete", id: 7, line: "spawn 1 al", caret: 10 });
		expect(socket.last("completion")).toMatchObject({ id: 7, start: 8, end: 10, suggestions: [{ insert: "alpine" }] });
	});
});

test.each([
	["#cli", { port: 47122 }],
	["#cli=5000", { port: 5000 }],
	["#cli=0", null],
	["#cli=70000", null],
	["#client", null],
	["", null],
])("%s asks for %j", (hash, asked) => {
	expect(linkAsked(hash)).toEqual(asked);
});
