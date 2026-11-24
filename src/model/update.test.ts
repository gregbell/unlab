import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { identity } from "./identity.ts";
import { isPlanError, lowestFreePorts, planBootAgain, planLink, takenPorts } from "./machines.ts";
import { capacity, keyboardHolder, reconcilePanes, visiblePanes } from "./panes.ts";
import {
	address,
	agentCall,
	bootAgainEvent,
	effectsOf,
	emptyLab,
	hasFailed,
	hasStopped,
	isReady,
	labWith,
	linkEvent,
	logged,
	machine,
	remove,
	run,
	spawnEvent,
	WIDE,
} from "./testkit.ts";
import {
	type Effect,
	type LabEvent,
	type LabState,
	LOG_LIMIT,
	MAX_MACHINES,
	type MachineName,
	type MachineSpec,
	type NicNo,
	type NicSpec,
	type PortNo,
	type SessionId,
} from "./types.ts";
import { clockHz, initialState, update } from "./update.ts";

const alpineAt = (text: string): MachineSpec => ({
	image: "alpine",
	memMiB: 256,
	gateway: true,
	nics: [{ net: "switch0", address: address(text) }],
});
const ALPINE = alpineAt("10.88.0.11/24");
const shell = (name: MachineName): LabEvent => ({ type: "cmd/shell", machine: name });
const tick = (now: number): LabEvent => ({ type: "tick", now });

describe("initialState", () => {
	test("is an empty lab on the lab view, with the handoff's default tool policies", () => {
		const s = initialState([{ name: "alpine", label: "alpine 3.24" }], { width: 900, height: 450 });
		expect(s).toMatchObject({
			now: 0,
			nextN: 1,
			machines: {},
			rail: [],
			sessions: {},
			keyboard: { kind: "none" },
			view: "lab",
			agentPanel: false,
			dock: "open",
			capture: { filter: "", paused: false, selected: null },
			log: [],
			images: [{ name: "alpine", label: "alpine 3.24" }],
		});
		expect(s.panes.grid).toEqual({ cols: 2, rows: 2 });
		expect(s.agent).toEqual({
			webmcp: { kind: "absent" },
			policies: {
				machines_list: "run",
				machines_spawn: "ask",
				machines_remove: "ask",
				shell_exec: "run",
				shell_read: "run",
				link_set: "run",
				capture_read: "run",
			},
			paused: false,
			calls: [],
			firstCallAt: null,
			lastCallAt: null,
		});
		expect(clockHz(s)).toBe(1);
	});
});

describe("spawn", () => {
	test("adds every row, console, pane and screen at once, all booting", () => {
		const s0 = emptyLab();
		const { state, effects } = update(s0, spawnEvent(s0, 2, { at: 1000 }));
		const hosts = [
			{ ip: "10.88.0.11", name: "node1" },
			{ ip: "10.88.0.12", name: "node2" },
		];

		expect(state.rail).toEqual(["node1", "node2"]);
		expect(state.nextN).toBe(3);
		expect(state.now).toBe(1000);
		expect(state.machines.node1).toEqual({
			...identity(1),
			life: { phase: "booting", attempt: 1, since: 1000, stage: "", plugs: [{ kind: "port", port: 1, link: "up" }] },
			hue: 1,
			spec: ALPINE,
			sessions: ["node1:console"],
			activeSession: "node1:console",
			nextShell: 1,
		});
		expect(state.machines.node2?.life).toMatchObject({ phase: "booting", plugs: [{ port: 2 }] });
		expect(state.sessions).toEqual({
			"node1:console": {
				id: "node1:console",
				machine: "node1",
				kind: "console",
				state: "open",
				shell: "unknown",
				agentLines: false,
			},
			"node2:console": {
				id: "node2:console",
				machine: "node2",
				kind: "console",
				state: "open",
				shell: "unknown",
				agentLines: false,
			},
		});
		expect(state.panes.order).toEqual(["node1", "node2"]);
		expect(visiblePanes(state.panes)).toEqual(["node1", "node2"]);

		expect(effects).toEqual([
			{ type: "screen/create", session: "node1:console" },
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "vm/boot", machine: "node1", attempt: 1, config: { identity: identity(1), spec: ALPINE, hosts } },
			{ type: "screen/create", session: "node2:console" },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
			{
				type: "vm/boot",
				machine: "node2",
				attempt: 1,
				config: { identity: identity(2), spec: alpineAt("10.88.0.12/24"), hosts },
			},
			{ type: "clock", hz: 10 },
		]);
	});

	test("the link does not come up until the machine is ready", () => {
		const s0 = emptyLab();
		expect(effectsOf(s0, spawnEvent(s0, 3)).filter((e) => e.type === "link/set")).toEqual([]);
	});

	test("--no-net attaches no port", () => {
		const s0 = emptyLab();
		const types = effectsOf(s0, spawnEvent(s0, 1, { net: "none" })).map((e) => e.type);
		expect(types).toEqual(["screen/create", "vm/boot", "clock"]);
	});

	test("a plan that is no longer the plan is ignored: a repeat, or one made before another spawn", () => {
		const s0 = emptyLab();
		const event = spawnEvent(s0, 2);
		const s1 = run(s0, event);
		expect(update(s1, event)).toEqual({ state: s1, effects: [] });
		expect(update(s1, event).state).toBe(s1);

		const early = spawnEvent(s1, 1);
		const s2 = run(s1, spawnEvent(s1, 1, { net: "none" }));
		expect(update(s2, early).state).toBe(s2);
	});

	test("the first machine of an empty lab takes the keyboard, and later spawns leave it where it is", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 3));
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node1" });
		s = run(s, { type: "cmd/focus", target: "node2", mode: "plain" });
		s = run(s, spawnEvent(s, 2));
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	test("booting closes the Add machines view", () => {
		let s = run(emptyLab(), { type: "ui/view", view: "spawn" });
		s = run(s, spawnEvent(s, 1));
		expect(s.view).toBe("lab");
	});

	test("with no room, an older pane parks for the newcomers and the focused pane stays", () => {
		let s = emptyLab({ width: 800, height: 200 });
		s = run(s, spawnEvent(s, 2));
		s = run(s, spawnEvent(s, 2));
		expect(visiblePanes(s.panes)).toEqual(["node1", "node3"]);
		expect(s.panes.parked).toEqual({ node2: "auto", node4: "auto" });
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node1" });
	});
});

describe("ready", () => {
	test("announces, brings the link up, and publishes hosts, in that order", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 2));
		const { state, effects } = update(s, isReady("node1", 1, 3582));
		expect(machine(state, "node1").life).toEqual({
			phase: "ready",
			attempt: 1,
			bootMs: 3582,
			plugs: [{ kind: "port", port: 1, link: "up" }],
		});
		expect(effects).toEqual([
			{ type: "announce", text: "node1 ready" },
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: true, cause: "runtime" },
			{
				type: "hosts/publish",
				hosts: [
					{ ip: "10.88.0.11", name: "node1" },
					{ ip: "10.88.0.12", name: "node2" },
				],
			},
		]);
	});

	test("an unplugged machine has no link to bring up", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { net: "none" }));
		expect(effectsOf(s, isReady("node1")).map((e) => e.type)).toEqual(["announce", "hosts/publish", "clock"]);
	});
});

describe("failure", () => {
	test("a boot that fails stops the kernel, withdraws the cable, and says why", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1));
		const { state, effects } = update(s, hasFailed("node1", 1, "Out of memory."));
		expect(machine(state, "node1").life).toEqual({ phase: "failed", attempt: 1, reason: "Out of memory." });
		expect(effects).toEqual([
			{ type: "vm/stop", machine: "node1", attempt: 1 },
			{ type: "port/detach", port: 1 },
			{ type: "announce", text: "node1 failed. Out of memory." },
			{ type: "clock", hz: 1 },
		]);
	});

	test("a ready machine that dies drops its link first, and its shells go with it", () => {
		let s = run(labWith(2), shell("node1"), shell("node1"));
		s = run(s, { type: "session/shell", session: "node1:console", shell: "prompt" });
		const { state, effects } = update(s, hasFailed("node1", 1, "The guest powered off."));
		expect(effects).toEqual([
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: false, cause: "runtime" },
			{ type: "vm/stop", machine: "node1", attempt: 1 },
			{ type: "port/detach", port: 1 },
			{ type: "screen/dispose", session: "node1:sh1" },
			{ type: "screen/dispose", session: "node1:sh2" },
			{ type: "announce", text: "node1 failed. The guest powered off." },
		]);
		expect(machine(state, "node1")).toMatchObject({ sessions: ["node1:console"], activeSession: "node1:console" });
		expect(Object.keys(state.sessions)).toEqual(["node1:console", "node2:console"]);
		expect(state.sessions["node1:console"]?.shell).toBe("unknown");
	});

	test("a machine with a cut cable or none has no link to drop", () => {
		let s = labWith(1);
		s = run(s, linkEvent(s, false, "node1"));
		expect(effectsOf(s, hasFailed("node1")).map((e) => e.type)).toEqual(["vm/stop", "port/detach", "announce"]);

		let unplugged = emptyLab();
		unplugged = run(unplugged, spawnEvent(unplugged, 1, { net: "none" }), isReady("node1"));
		expect(effectsOf(unplugged, hasFailed("node1")).map((e) => e.type)).toEqual(["vm/stop", "announce"]);
	});

	test("shell numbers are not reused after a failure and a boot again", () => {
		let s = run(labWith(1), shell("node1"), hasFailed("node1"));
		s = run(s, bootAgainEvent(s, "node1"), isReady("node1", 2), shell("node1"));
		expect(machine(s, "node1").sessions).toEqual(["node1:console", "node1:sh2"]);
	});
});

describe("the boot timeout", () => {
	test("no prompt within 120 s fails the machine, with the reason as a sentence", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { at: 1000 }));
		s = run(s, tick(120_999));
		expect(machine(s, "node1").life.phase).toBe("booting");
		const { state, effects } = update(s, tick(121_000));
		expect(machine(state, "node1").life).toEqual({ phase: "failed", attempt: 1, reason: "No prompt after 120 s." });
		expect(effects).toEqual([
			{ type: "vm/stop", machine: "node1", attempt: 1 },
			{ type: "port/detach", port: 1 },
			{ type: "announce", text: "node1 failed. No prompt after 120 s." },
			{ type: "clock", hz: 1 },
		]);
	});

	test("counts from the boot again, not from the first attempt", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { at: 0 }), hasFailed("node1"));
		s = run(s, tick(100_000));
		s = run(s, bootAgainEvent(s, "node1", 100_000), tick(219_999));
		expect(machine(s, "node1").life).toMatchObject({ phase: "booting", attempt: 2 });
		s = run(s, tick(220_000));
		expect(machine(s, "node1").life).toMatchObject({ phase: "failed", attempt: 2 });
	});

	test("every late machine fails on the same tick; a ready one is left alone", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 3, { at: 0 }), isReady("node2"));
		s = run(s, tick(120_000));
		expect(s.rail.map((name) => machine(s, name).life.phase)).toEqual(["failed", "ready", "failed"]);
	});
});

describe("boot again", () => {
	test("boots the next attempt on the planned port, into the console that is already there", () => {
		let s = labWith(2);
		s = run(s, hasFailed("node1"));
		const { state, effects } = update(s, bootAgainEvent(s, "node1", 5000));
		expect(machine(state, "node1").life).toEqual({
			phase: "booting",
			attempt: 2,
			since: 5000,
			stage: "",
			plugs: [{ kind: "port", port: 1, link: "up" }],
		});
		expect(effects).toEqual([
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{
				type: "vm/boot",
				machine: "node1",
				attempt: 2,
				config: {
					identity: identity(1),
					spec: ALPINE,
					hosts: [
						{ ip: "10.88.0.11", name: "node1" },
						{ ip: "10.88.0.12", name: "node2" },
					],
				},
			},
			{ type: "clock", hz: 10 },
		]);
	});
});

describe("rm", () => {
	test("the link drops before the kernel stops, with who asked for it", () => {
		const s = labWith(2);
		const event: LabEvent = { type: "cmd/remove", machines: ["node1"], cause: "agent" };
		const { state, effects } = update(s, event);
		expect(machine(state, "node1").life).toEqual({ phase: "removing", attempt: 1, ports: [1] });
		expect(effects).toEqual([
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: false, cause: "agent" },
			{ type: "vm/stop", machine: "node1", attempt: 1 },
		]);
	});

	test("when teardown ends the port frees, the screens go, and the others hear about it", () => {
		let s = run(labWith(2), shell("node1"), remove("node1"));
		const { state, effects } = update(s, hasStopped("node1"));
		expect(effects).toEqual([
			{ type: "port/detach", port: 1 },
			{ type: "screen/dispose", session: "node1:console" },
			{ type: "screen/dispose", session: "node1:sh1" },
			{ type: "disk/delete", n: 1 },
			{ type: "hosts/publish", hosts: [{ ip: "10.88.0.12", name: "node2" }] },
			{ type: "announce", text: "node1 removed" },
		]);
		expect(state.rail).toEqual(["node2"]);
		expect(Object.keys(state.machines)).toEqual(["node2"]);
		expect(Object.keys(state.sessions)).toEqual(["node2:console"]);
		expect(state.panes.order).toEqual(["node2"]);
		s = state;
		expect(update(s, hasStopped("node1")).state).toBe(s);
	});

	test("a machine whose link is not up is just stopped", () => {
		let cut = labWith(1);
		cut = run(cut, linkEvent(cut, false, "node1"));
		expect(effectsOf(cut, remove("node1")).map((e) => e.type)).toEqual(["vm/stop"]);

		let booting = emptyLab();
		booting = run(booting, spawnEvent(booting, 1));
		expect(effectsOf(booting, remove("node1"), hasStopped("node1")).map((e) => e.type)).toEqual([
			"vm/stop",
			"clock",
			"port/detach",
			"screen/dispose",
			"disk/delete",
			"hosts/publish",
			"announce",
		]);
	});

	test("a failed machine has no port to give back", () => {
		const s = run(labWith(1), hasFailed("node1"));
		expect(effectsOf(s, remove("node1"), hasStopped("node1")).map((e) => e.type)).toEqual([
			"vm/stop",
			"screen/dispose",
			"disk/delete",
			"hosts/publish",
			"announce",
		]);
	});

	test("several machines go in the order named, each once", () => {
		const s = labWith(3);
		const effects = effectsOf(s, remove("node3", "node1", "node3", "node9"));
		expect(
			effects.map((e) => (e.type === "link/set" || e.type === "vm/stop" ? `${e.type} ${e.machine}` : e.type)),
		).toEqual(["link/set node3", "vm/stop node3", "link/set node1", "vm/stop node1"]);
	});
});

describe("link", () => {
	test("a cut takes effect at once and keeps the port", () => {
		const s = labWith(2);
		const { state, effects } = update(s, linkEvent(s, false, "node2"));
		expect(machine(state, "node2").life).toMatchObject({ plugs: [{ kind: "port", port: 2, link: "cut" }] });
		expect(effects).toEqual([
			{ type: "link/set", port: 2, machine: "node2", nic: 0, up: false, cause: "bar" },
			{ type: "announce", text: "node2 link down" },
		]);
	});

	test("reconnecting brings the same port back up", () => {
		let s = labWith(2);
		s = run(s, linkEvent(s, false, "node2"));
		expect(effectsOf(s, linkEvent(s, true, "node2"))).toEqual([
			{ type: "link/set", port: 2, machine: "node2", nic: 0, up: true, cause: "bar" },
			{ type: "announce", text: "node2 link up" },
		]);
	});

	test("link up on an unplugged machine attaches the lowest free port first", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { net: "none" }), isReady("node1"));
		const { state, effects } = update(s, linkEvent(s, true, "node1"));
		expect(machine(state, "node1").life).toMatchObject({ plugs: [{ kind: "port", port: 1, link: "up" }] });
		expect(effects).toEqual([
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: true, cause: "bar" },
			{ type: "announce", text: "node1 link up" },
		]);
	});

	test("a change that no longer fits the machine is ignored", () => {
		const s = labWith(2);
		const wrongPort: LabEvent = {
			type: "cmd/link",
			changes: [{ machine: "node1", nic: 0, up: false, port: 2, newPort: false }],
			cause: "bar",
		};
		const alreadyUp: LabEvent = {
			type: "cmd/link",
			changes: [{ machine: "node1", nic: 0, up: true, port: 1, newPort: false }],
			cause: "bar",
		};
		const notUnplugged: LabEvent = {
			type: "cmd/link",
			changes: [{ machine: "node1", nic: 0, up: true, port: 3, newPort: true }],
			cause: "bar",
		};
		for (const event of [wrongPort, alreadyUp, notUnplugged])
			expect(update(s, event)).toEqual({ state: s, effects: [] });
		const cut = linkEvent(s, false, "node1");
		const after = run(s, cut);
		expect(update(after, cut).state).toBe(after);
	});

	test("a link up planned for a port that is taken, or no longer the lowest free one, is ignored", () => {
		let s = labWith(2);
		s = run(s, spawnEvent(s, 1, { net: "none" }), isReady("node3"));
		const onto = (port: 2 | 3 | 4): LabEvent => ({
			type: "cmd/link",
			changes: [{ machine: "node3", nic: 0, up: true, port, newPort: true }],
			cause: "bar",
		});
		expect(update(s, onto(2))).toEqual({ state: s, effects: [] });
		expect(update(s, onto(4))).toEqual({ state: s, effects: [] });
		expect(machine(run(s, onto(3)), "node3").life).toMatchObject({ plugs: [{ kind: "port", port: 3, link: "up" }] });
	});
});

describe("the clock", () => {
	test("runs at 10 Hz while anything boots, 1 Hz otherwise, and is only told when that changes", () => {
		let s = emptyLab();
		const clocks = (...events: LabEvent[]): Effect[] => {
			const effects = effectsOf(s, ...events).filter((e) => e.type === "clock");
			s = run(s, ...events);
			return effects;
		};
		expect(clocks(tick(500))).toEqual([]);
		expect(clocks(spawnEvent(s, 2))).toEqual([{ type: "clock", hz: 10 }]);
		expect(clocks(spawnEvent(s, 1))).toEqual([]);
		expect(clocks(isReady("node1"), hasFailed("node2"))).toEqual([]);
		expect(clocks(isReady("node3"))).toEqual([{ type: "clock", hz: 1 }]);
		expect(clocks(bootAgainEvent(s, "node2"))).toEqual([{ type: "clock", hz: 10 }]);
		expect(clocks(remove("node2"))).toEqual([{ type: "clock", hz: 1 }]);
		expect(clockHz(s)).toBe(1);
	});
});

describe("tick", () => {
	test("advances the lab clock, and never runs it backwards", () => {
		let s = run(emptyLab(), tick(250));
		expect(s.now).toBe(250);
		expect(update(s, tick(250)).state).toBe(s);
		expect(update(s, tick(100)).state).toBe(s);
		expect(update(s, tick(Number.NaN)).state).toBe(s);
		s = run(s, logged("ls", "bar", 900));
		expect(s.now).toBe(900);
	});
});

describe("sessions", () => {
	test("a shell opens as the next sh<k>, becomes the active tab, and is open once the runtime says so", () => {
		const s = labWith(1);
		const { state, effects } = update(s, shell("node1"));
		expect(machine(state, "node1")).toMatchObject({
			sessions: ["node1:console", "node1:sh1"],
			activeSession: "node1:sh1",
			nextShell: 2,
		});
		expect(state.sessions["node1:sh1"]).toEqual({
			id: "node1:sh1",
			machine: "node1",
			kind: "shell",
			state: "opening",
			shell: "unknown",
			agentLines: false,
		});
		expect(effects).toEqual([
			{ type: "screen/create", session: "node1:sh1" },
			{ type: "pty/open", session: "node1:sh1" },
		]);
		const opened = run(state, { type: "session/opened", session: "node1:sh1" });
		expect(opened.sessions["node1:sh1"]?.state).toBe("open");
	});

	test("when a shell ends its tab closes; if it was active the tab to its left takes over", () => {
		let s = run(labWith(1), shell("node1"), shell("node1"), shell("node1"));
		expect(machine(s, "node1").activeSession).toBe("node1:sh3");
		const { state, effects } = update(s, { type: "session/ended", session: "node1:sh3" });
		expect(effects).toEqual([{ type: "screen/dispose", session: "node1:sh3" }]);
		expect(machine(state, "node1")).toMatchObject({
			sessions: ["node1:console", "node1:sh1", "node1:sh2"],
			activeSession: "node1:sh2",
		});
		expect(state.sessions["node1:sh3"]).toBeUndefined();

		s = run(state, { type: "session/ended", session: "node1:sh1" });
		expect(machine(s, "node1")).toMatchObject({ sessions: ["node1:console", "node1:sh2"], activeSession: "node1:sh2" });
		s = run(s, { type: "session/ended", session: "node1:sh2" });
		expect(machine(s, "node1").activeSession).toBe("node1:console");
	});

	test("shell numbers are never reused on a machine", () => {
		const s = run(labWith(1), shell("node1"), { type: "session/ended", session: "node1:sh1" }, shell("node1"));
		expect(machine(s, "node1").sessions).toEqual(["node1:console", "node1:sh2"]);
	});

	test("selecting a tab makes it the active one", () => {
		let s = run(labWith(1), shell("node1"));
		s = run(s, { type: "ui/tab-selected", session: "node1:console" });
		expect(machine(s, "node1").activeSession).toBe("node1:console");
		expect(update(s, { type: "ui/tab-selected", session: "node1:console" }).state).toBe(s);
		expect(update(s, { type: "ui/tab-selected", session: "node1:sh7" }).state).toBe(s);
	});

	test("the shell tracker's reports are recorded, and only the agent's lines set the legend", () => {
		let s = labWith(1);
		s = run(s, { type: "session/shell", session: "node1:console", shell: "running" });
		expect(s.sessions["node1:console"]?.shell).toBe("running");
		const bar = update(s, { type: "session/marked", session: "node1:console", source: "bar" });
		expect(bar.state).toBe(s);
		s = run(s, { type: "session/marked", session: "node1:console", source: "agent" });
		expect(s.sessions["node1:console"]?.agentLines).toBe(true);
	});
});

describe("focus and the keyboard", () => {
	test("focus moves the keyboard and never moves a pane", () => {
		const s = labWith(3);
		const focused = run(s, { type: "cmd/focus", target: "node3", mode: "plain" });
		expect(focused.keyboard).toEqual({ kind: "pane", machine: "node3" });
		expect(focused.panes.order).toEqual(s.panes.order);
		expect(update(focused, { type: "cmd/focus", target: "node3", mode: "plain" }).state).toBe(focused);
	});

	test("a session target also selects its tab", () => {
		let s = run(labWith(2), shell("node2"), shell("node2"));
		s = run(s, { type: "cmd/focus", target: "node2:sh1", mode: "plain" });
		expect(machine(s, "node2").activeSession).toBe("node2:sh1");
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(update(s, { type: "cmd/focus", target: "node2:sh9", mode: "plain" }).state).toBe(s);
	});

	test("--main moves the pane to the front of the list", () => {
		const s = run(labWith(3), { type: "cmd/focus", target: "node3", mode: "main" });
		expect(s.panes.order).toEqual(["node3", "node1", "node2"]);
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node3" });
	});

	test("--max maximises, and again restores the exact previous layout", () => {
		const before = run(labWith(4), { type: "ui/park", machine: "node4" });
		const maximised = run(before, { type: "cmd/focus", target: "node2", mode: "max" });
		expect(visiblePanes(maximised.panes)).toEqual(["node2"]);
		expect(maximised.keyboard).toEqual({ kind: "pane", machine: "node2" });
		const restored = run(maximised, { type: "cmd/focus", target: "node2", mode: "max" });
		expect(visiblePanes(restored.panes)).toEqual(["node1", "node2", "node3"]);
		expect(restored.panes.parked).toEqual(before.panes.parked);
	});

	test("--max on a parked machine brings it back first, so restoring leaves it in view", () => {
		let s = run(labWith(3), { type: "ui/park", machine: "node2" });
		s = run(s, { type: "cmd/focus", target: "node2", mode: "max" });
		expect(visiblePanes(s.panes)).toEqual(["node2"]);
		s = run(s, { type: "cmd/focus", target: "node2", mode: "max" });
		expect(visiblePanes(s.panes)).toEqual(["node1", "node2", "node3"]);
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	test("the header's maximise does the same, and gives the pane the keyboard", () => {
		const s = run(labWith(3), { type: "ui/maximise", machine: "node3" });
		expect(visiblePanes(s.panes)).toEqual(["node3"]);
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node3" });
		expect(visiblePanes(run(s, { type: "ui/maximise", machine: "node3" }).panes)).toEqual(["node1", "node2", "node3"]);
	});

	test("focusing a parked machine brings it back first", () => {
		let s = run(labWith(3), { type: "ui/park", machine: "node2" });
		expect(s.panes.parked).toEqual({ node2: "user" });
		s = run(s, { type: "cmd/focus", target: "node2", mode: "plain" });
		expect(s.panes.parked).toEqual({});
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	test("clicking a parked chip brings that pane back and focuses it, parking the stalest in exchange", () => {
		let s = labWith(3, { width: 800, height: 200 });
		expect(s.panes.parked).toEqual({ node3: "auto" });
		s = run(s, { type: "cmd/focus", target: "node2", mode: "plain" }, { type: "ui/unpark", machine: "node3" });
		expect(visiblePanes(s.panes)).toEqual(["node2", "node3"]);
		expect(s.panes.parked).toEqual({ node1: "auto" });
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node3" });
	});

	test("a click into a pane is recorded as the focus", () => {
		const s = run(labWith(2), { type: "ui/pane-focused", machine: "node2" });
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(update(s, { type: "ui/pane-focused", machine: "node2" }).state).toBe(s);
		expect(update(s, { type: "ui/pane-focused", machine: "node9" }).state).toBe(s);
	});

	test("parking the pane that has the keyboard hands it to the pane focused before", () => {
		let s = labWith(3);
		s = run(
			s,
			{ type: "cmd/focus", target: "node3", mode: "plain" },
			{ type: "cmd/focus", target: "node2", mode: "plain" },
		);
		s = run(s, { type: "ui/park", machine: "node2" });
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node3" });
	});

	test("when the machine with the keyboard is gone, the keyboard moves on; with no pane left it is nowhere", () => {
		let s = labWith(2);
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node1" });
		s = run(s, remove("node1"));
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node1" });
		s = run(s, hasStopped("node1"));
		expect(s.keyboard).toEqual({ kind: "pane", machine: "node2" });
		s = run(s, remove("node2"), hasStopped("node2"));
		expect(s.keyboard).toEqual({ kind: "none" });
	});

	test("the command bar takes the keyboard and gives it back to the pane that had it", () => {
		let s = run(labWith(2), { type: "cmd/focus", target: "node2", mode: "plain" });
		s = run(s, { type: "ui/bar", open: true });
		expect(s.keyboard).toEqual({ kind: "bar", returnTo: "node2" });
		expect(update(s, { type: "ui/bar", open: true }).state).toBe(s);
		const closed = run(s, { type: "ui/bar", open: false });
		expect(closed.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(update(closed, { type: "ui/bar", open: false }).state).toBe(closed);
	});

	test("a focus run from the bar decides where the keyboard returns", () => {
		let s = run(labWith(2), { type: "ui/bar", open: true });
		s = run(s, { type: "cmd/focus", target: "node2", mode: "plain" });
		expect(s.keyboard).toEqual({ kind: "bar", returnTo: "node2" });
		expect(run(s, { type: "ui/bar", open: false }).keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	test("the bar opened in an empty lab returns to the first machine it spawns", () => {
		let s = run(emptyLab(), { type: "ui/bar", open: true });
		expect(s.keyboard).toEqual({ kind: "bar", returnTo: null });
		s = run(s, spawnEvent(s, 2));
		expect(s.keyboard).toEqual({ kind: "bar", returnTo: "node1" });
		expect(run(s, { type: "ui/bar", open: false }).keyboard).toEqual({ kind: "pane", machine: "node1" });
	});

	test("the bar returns elsewhere when its pane's machine is removed meanwhile", () => {
		let s = run(labWith(2), { type: "ui/bar", open: true });
		s = run(s, remove("node1"), hasStopped("node1"));
		expect(s.keyboard).toEqual({ kind: "bar", returnTo: "node2" });
	});

	test("a resize re-parks only when the grid changes", () => {
		const s = labWith(3);
		expect(update(s, { type: "ui/area-resized", width: WIDE.width + 50, height: WIDE.height }).state).toBe(s);
		const narrow = run(s, { type: "ui/area-resized", width: 450, height: 250 });
		expect(visiblePanes(narrow.panes)).toEqual(["node1"]);
		expect(narrow.keyboard).toEqual({ kind: "pane", machine: "node1" });
	});
});

describe("views and capture", () => {
	test("capture sets the filter and opens Wire", () => {
		const s = run(emptyLab(), { type: "cmd/capture", filter: "arp node1" });
		expect(s.capture.filter).toBe("arp node1");
		expect(s.view).toBe("wire");
		expect(update(s, { type: "cmd/capture", filter: "arp node1" }).state).toBe(s);
	});

	test("the view, the agent panel, the filter, pause and selection are recorded as set", () => {
		let s = run(
			emptyLab(),
			{ type: "ui/view", view: "wire" },
			{ type: "ui/agent-panel", open: true },
			{ type: "ui/capture-filter", filter: "port:3" },
			{ type: "ui/capture-pause", paused: true },
			{ type: "ui/frame-selected", seq: 41 },
		);
		expect(s).toMatchObject({
			view: "wire",
			agentPanel: true,
			capture: { filter: "port:3", paused: true, selected: 41 },
		});
		for (const event of [
			{ type: "ui/view", view: "wire" },
			{ type: "ui/agent-panel", open: true },
			{ type: "ui/capture-filter", filter: "port:3" },
			{ type: "ui/capture-pause", paused: true },
			{ type: "ui/frame-selected", seq: 41 },
		] satisfies LabEvent[]) {
			expect(update(s, event).state).toBe(s);
		}
		s = run(s, { type: "ui/view", view: "lab" });
		expect(s.view).toBe("lab");
	});

	test("the dock starts open, collapses and opens again, and a repeat changes nothing", () => {
		const open = emptyLab();
		expect(open.dock).toBe("open");
		expect(update(open, { type: "ui/dock", dock: "open" }).state).toBe(open);
		const collapsed = update(open, { type: "ui/dock", dock: "collapsed" });
		expect(collapsed).toEqual({ state: { ...open, dock: "collapsed" }, effects: [] });
		expect(update(collapsed.state, { type: "ui/dock", dock: "collapsed" }).state).toBe(collapsed.state);
		expect(run(collapsed.state, { type: "ui/dock", dock: "open" }).dock).toBe("open");
	});

	test("clear empties the capture and drops the selection", () => {
		const s = run(emptyLab(), { type: "ui/frame-selected", seq: 7 });
		const { state, effects } = update(s, { type: "ui/capture-clear" });
		expect(effects).toEqual([{ type: "capture/clear" }]);
		expect(state.capture.selected).toBeNull();
		expect(update(state, { type: "ui/capture-clear" })).toEqual({ state, effects: [{ type: "capture/clear" }] });
	});
});

describe("the command log", () => {
	test("every command that runs is logged with who ran it", () => {
		const s = run(emptyLab(), logged("spawn 2 alpine", "bar", 100), {
			type: "cmd/logged",
			line: "rm node2",
			source: "agent",
			at: 200,
			outcome: "failed",
		});
		expect(s.log).toEqual([
			{ id: 1, line: "spawn 2 alpine", source: "bar", at: 100, outcome: "ok" },
			{ id: 2, line: "rm node2", source: "agent", at: 200, outcome: "failed" },
		]);
		expect(s.nextLogId).toBe(3);
	});

	test("the log is bounded and keeps the newest", () => {
		let s = emptyLab();
		for (let i = 1; i <= LOG_LIMIT + 5; i++) s = run(s, logged(`line ${i}`, "bar", i));
		expect(s.log).toHaveLength(LOG_LIMIT);
		expect(s.log[0]).toMatchObject({ id: 6, line: "line 6" });
		expect(s.log[LOG_LIMIT - 1]).toMatchObject({ id: LOG_LIMIT + 5, line: `line ${LOG_LIMIT + 5}` });
	});
});

describe("agent calls", () => {
	test("a looping agent cannot grow the call list without bound, and a waiting call is never dropped", () => {
		let s = run(emptyLab(), { type: "agent/call", call: agentCall(1, 0, { status: "waiting" }) });
		for (let id = 2; id <= LOG_LIMIT + 50; id++) s = run(s, { type: "agent/call", call: agentCall(id, id) });
		expect(s.agent.calls.length).toBeLessThanOrEqual(LOG_LIMIT);
		expect(s.agent.calls[0]).toMatchObject({ id: 1, status: "waiting" });
		expect(s.agent.calls.at(-1)).toMatchObject({ id: LOG_LIMIT + 50 });
	});

	test("a call is logged oldest first, and stamps when the agent first and last called", () => {
		let s = run(emptyLab(), { type: "agent/call", call: agentCall(1, 1000) });
		expect(s.agent).toMatchObject({ firstCallAt: 1000, lastCallAt: 1000 });
		s = run(s, { type: "agent/call", call: agentCall(2, 4000, { status: "running" }) });
		expect(s.agent).toMatchObject({ firstCallAt: 1000, lastCallAt: 4000 });
		expect(s.agent.calls.map((call) => call.id)).toEqual([1, 2]);
		expect(s.now).toBe(4000);
		expect(update(s, { type: "agent/call", call: agentCall(2, 9000) }).state).toBe(s);
	});

	test("a call that waits for the user is announced", () => {
		const waiting = agentCall(8, 1000, { tool: "machines_remove", line: "rm node3", status: "waiting" });
		expect(effectsOf(emptyLab(), { type: "agent/call", call: waiting })).toEqual([
			{ type: "announce", text: "Agent call waiting for you: rm node3" },
		]);
		expect(effectsOf(emptyLab(), { type: "agent/call", call: agentCall(1, 1000, { status: "running" }) })).toEqual([]);
		expect(run(emptyLab(), { type: "agent/call", call: waiting }).agentPanel).toBe(true);
		expect(run(emptyLab(), { type: "agent/call", call: agentCall(1, 1000) }).agentPanel).toBe(false);
	});

	test("a panel closed over a waiting call opens again only for another one", () => {
		let s = run(
			emptyLab(),
			{ type: "agent/call", call: agentCall(1, 1000, { status: "waiting" }) },
			{ type: "ui/agent-panel", open: false },
			{ type: "agent/call", call: agentCall(2, 2000) },
		);
		expect(s.agentPanel).toBe(false);
		s = run(s, { type: "agent/call", call: agentCall(3, 3000, { status: "waiting" }) });
		expect(s.agentPanel).toBe(true);
	});

	test("a call settles once", () => {
		let s = run(emptyLab(), { type: "agent/call", call: agentCall(8, 1000, { status: "waiting" }) });
		s = run(s, { type: "agent/settled", id: 8, status: "running", result: null });
		expect(s.agent.calls[0].status).toBe("running");
		s = run(s, { type: "agent/settled", id: 8, status: "done", result: "removed node3" });
		expect(s.agent.calls[0]).toMatchObject({ status: "done", result: "removed node3" });
		expect(update(s, { type: "agent/settled", id: 8, status: "failed", result: "late" }).state).toBe(s);
		expect(update(s, { type: "agent/settled", id: 99, status: "done", result: null }).state).toBe(s);
	});

	test("a call never goes back to waiting", () => {
		const s = run(emptyLab(), { type: "agent/call", call: agentCall(1, 0, { status: "running" }) });
		expect(update(s, { type: "agent/settled", id: 1, status: "waiting", result: null }).state).toBe(s);
	});

	test("what the browser made of the tools is recorded, and hearing it again changes nothing", () => {
		const refused = { kind: "refused", message: "Not allowed." } as const;
		const s = run(emptyLab(), { type: "agent/webmcp", webmcp: refused });
		expect(s.agent.webmcp).toEqual(refused);
		expect(update(s, { type: "agent/webmcp", webmcp: { ...refused } }).state).toBe(s);
		const other = { kind: "refused", message: "Too many tools." } as const;
		expect(run(s, { type: "agent/webmcp", webmcp: other }).agent.webmcp).toEqual(other);
		expect(run(s, { type: "agent/webmcp", webmcp: { kind: "registered" } }).agent.webmcp).toEqual({
			kind: "registered",
		});
	});

	test("policies and the pause are the user's to set", () => {
		let s = run(
			emptyLab(),
			{ type: "ui/policy", tool: "shell_exec", policy: "off" },
			{ type: "ui/tools-paused", paused: true },
		);
		expect(s.agent.policies.shell_exec).toBe("off");
		expect(s.agent.policies.machines_list).toBe("run");
		expect(s.agent.paused).toBe(true);
		expect(update(s, { type: "ui/policy", tool: "shell_exec", policy: "off" }).state).toBe(s);
		expect(update(s, { type: "ui/tools-paused", paused: true }).state).toBe(s);
		s = run(s, { type: "ui/tools-paused", paused: false });
		expect(s.agent.paused).toBe(false);
	});
});

type Intent =
	| { readonly kind: "spawn"; readonly count: number; readonly nets: readonly NicSpec["net"][] }
	| { readonly kind: "stage" | "ready" | "failed" | "stopped"; readonly pick: number; readonly skew: number }
	| { readonly kind: "remove" | "shell" | "park" | "unpark" | "maximise" | "paneFocused"; readonly pick: number }
	| { readonly kind: "bootAgain"; readonly pick: number; readonly port: number }
	| {
			readonly kind: "link";
			readonly pick: number;
			readonly nic: 0 | 1 | 3 | null;
			readonly up: boolean;
			readonly planned: boolean;
	  }
	| { readonly kind: "sessionOpened" | "sessionEnded" | "tab"; readonly pick: number; readonly tab: number }
	| { readonly kind: "focus"; readonly pick: number; readonly mode: "plain" | "main" | "max" }
	| { readonly kind: "resize"; readonly width: number; readonly height: number }
	| { readonly kind: "bar"; readonly open: boolean }
	| { readonly kind: "tick"; readonly dt: number };

const pick = fc.nat({ max: 30 });
const skew = fc.constantFrom(0, 0, 0, 0, -1, 1);
const kinds = <K extends string>(...names: K[]) => fc.constantFrom(...names);
const intentArb: fc.Arbitrary<Intent> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			kind: kinds("spawn"),
			count: fc.integer({ min: 1, max: 3 }),
			nets: fc.array(fc.constantFrom("switch0", "none"), { minLength: 1, maxLength: 4 }),
		}),
	},
	{ weight: 8, arbitrary: fc.record({ kind: kinds("stage", "ready", "ready", "failed", "stopped"), pick, skew }) },
	{
		weight: 6,
		arbitrary: fc.record({ kind: kinds("remove", "shell", "park", "unpark", "maximise", "paneFocused"), pick }),
	},
	{ weight: 2, arbitrary: fc.record({ kind: kinds("bootAgain"), pick, port: fc.integer({ min: 0, max: 8 }) }) },
	{
		weight: 3,
		arbitrary: fc.record({
			kind: kinds("link"),
			pick,
			nic: fc.constantFrom(null, null, 0, 1, 3),
			up: fc.boolean(),
			planned: fc.boolean(),
		}),
	},
	{
		weight: 3,
		arbitrary: fc.record({ kind: kinds("sessionOpened", "sessionEnded", "tab"), pick, tab: fc.nat({ max: 4 }) }),
	},
	{ weight: 3, arbitrary: fc.record({ kind: kinds("focus"), pick, mode: fc.constantFrom("plain", "main", "max") }) },
	{
		weight: 1,
		arbitrary: fc.record({
			kind: kinds("resize"),
			width: fc.integer({ min: 0, max: 1700 }),
			height: fc.integer({ min: 0, max: 700 }),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ kind: kinds("bar"), open: fc.boolean() }) },
	{ weight: 2, arbitrary: fc.record({ kind: kinds("tick"), dt: fc.constantFrom(0, 100, 1000, 60_000, 130_000) }) },
);

/** Turns an intent into an event against the state as it stands. Some name machines that never were, or are gone. */
function eventOf(intent: Intent, s: LabState): LabEvent | null {
	const named = (n: number): MachineName => `node${1 + (n % (s.nextN + 1))}`;
	switch (intent.kind) {
		case "spawn": {
			const count = Math.min(intent.count, MAX_MACHINES - s.rail.length);
			const wanted = count * intent.nets.filter((net) => net === "switch0").length;
			if (count === 0 || lowestFreePorts(s, wanted).length < wanted) return null;
			return spawnEvent(s, count, { net: intent.nets });
		}
		case "stage":
		case "ready":
		case "failed":
		case "stopped": {
			const name = named(intent.pick);
			const attempt = (s.machines[name]?.life.attempt ?? 1) + intent.skew;
			if (intent.kind === "stage") return { type: "vm/stage", machine: name, attempt, stage: `stage ${intent.pick}` };
			if (intent.kind === "ready") return isReady(name, attempt);
			return intent.kind === "failed" ? hasFailed(name, attempt) : hasStopped(name, attempt);
		}
		case "remove":
			return remove(named(intent.pick), named(intent.pick + 1));
		case "shell":
			return shell(named(intent.pick));
		case "park":
			return { type: "ui/park", machine: named(intent.pick) };
		case "unpark":
			return { type: "ui/unpark", machine: named(intent.pick) };
		case "maximise":
			return { type: "ui/maximise", machine: named(intent.pick) };
		case "paneFocused":
			return { type: "ui/pane-focused", machine: named(intent.pick) };
		case "bootAgain": {
			const name = named(intent.pick);
			const planned = planBootAgain(s, name);
			const wanted = planned === null || isPlanError(planned) ? [] : planned.ports;
			const stale = [PORT_NUMBERS[intent.port] ?? null];
			return { type: "cmd/boot-again", machine: name, ports: intent.port === 0 ? wanted : stale, at: s.now };
		}
		case "link": {
			const name = named(intent.pick);
			const targets = intent.nic === null ? [name, named(intent.pick + 1)] : [{ machine: name, nic: intent.nic }];
			if (intent.planned) {
				const changes = planLink(s, targets, intent.up);
				return isPlanError(changes) ? null : { type: "cmd/link", changes, cause: "bar" };
			}
			return {
				type: "cmd/link",
				changes: [{ machine: name, nic: intent.nic ?? 0, up: intent.up, port: 3, newPort: intent.up }],
				cause: "button",
			};
		}
		case "sessionOpened":
		case "sessionEnded":
		case "tab": {
			const name = named(intent.pick);
			const session: SessionId = intent.tab === 0 ? `${name}:console` : `${name}:sh${intent.tab}`;
			if (intent.kind === "tab") return { type: "ui/tab-selected", session };
			return { type: intent.kind === "sessionOpened" ? "session/opened" : "session/ended", session };
		}
		case "focus":
			return { type: "cmd/focus", target: named(intent.pick), mode: intent.mode };
		case "resize":
			return { type: "ui/area-resized", width: intent.width, height: intent.height };
		case "bar":
			return { type: "ui/bar", open: intent.open };
		case "tick":
			return tick(s.now + intent.dt);
	}
}

const PORT_NUMBERS: readonly (PortNo | undefined)[] = [undefined, 1, 2, 3, 4, 5, 6, 7, 8];

/** A stand-in for the runtime: it does what the effects say and complains when they make no sense. */
class World {
	readonly ports = new Map<PortNo, { machine: MachineName; nic: NicNo; up: boolean }>();
	readonly screens = new Set<SessionId>();
	readonly kernels = new Map<MachineName, number>();
	hz: 1 | 10 = 1;

	apply(effect: Effect): void {
		switch (effect.type) {
			case "vm/boot":
				expect(this.kernels.has(effect.machine), `${effect.machine} booted while running`).toBe(false);
				expect(effect.config.identity.name).toBe(effect.machine);
				this.kernels.set(effect.machine, effect.attempt);
				return;
			case "vm/stop":
				if (this.kernels.get(effect.machine) === effect.attempt) this.kernels.delete(effect.machine);
				return;
			case "port/attach":
				expect(this.ports.has(effect.port), `port ${effect.port} attached twice`).toBe(false);
				this.ports.set(effect.port, { machine: effect.machine, nic: effect.nic, up: false });
				return;
			case "port/detach":
				expect(this.ports.get(effect.port)?.up, `port ${effect.port} detached while up or absent`).toBe(false);
				this.ports.delete(effect.port);
				return;
			case "link/set": {
				const port = this.ports.get(effect.port);
				expect([port?.machine, port?.nic], `link set on port ${effect.port}`).toEqual([effect.machine, effect.nic]);
				expect(port?.up, `port ${effect.port} link set to what it was`).toBe(!effect.up);
				this.ports.set(effect.port, { machine: effect.machine, nic: effect.nic, up: effect.up });
				return;
			}
			case "screen/create":
				expect(this.screens.has(effect.session), `${effect.session} created twice`).toBe(false);
				this.screens.add(effect.session);
				return;
			case "screen/dispose":
				expect(this.screens.delete(effect.session), `${effect.session} disposed but never created`).toBe(true);
				return;
			case "pty/open":
				expect(this.screens.has(effect.session), `${effect.session} opened before its screen`).toBe(true);
				return;
			case "clock":
				expect(effect.hz, "clock told a rate it already had").not.toBe(this.hz);
				this.hz = effect.hz;
				return;
			case "pty/close":
			case "hosts/publish":
			case "capture/clear":
			case "announce":
				return;
		}
	}
}

function checkLab(s: LabState, world: World): void {
	const machines = s.rail.map((name) => machine(s, name));
	expect(new Set(s.rail).size).toBe(s.rail.length);
	expect(Object.keys(s.machines).sort()).toEqual([...s.rail].sort());
	expect(machines.length).toBeLessThanOrEqual(MAX_MACHINES);
	expect(new Set(machines.map((m) => m.hue)).size).toBe(machines.length);
	for (const m of machines) expect(m.n).toBeLessThan(s.nextN);

	const sessionIds = machines.flatMap((m) => m.sessions);
	expect(Object.keys(s.sessions).sort()).toEqual([...sessionIds].sort());
	for (const m of machines) {
		expect(m.sessions[0]).toBe(`${m.name}:console`);
		expect(m.sessions).toContain(m.activeSession);
		for (const id of m.sessions) expect(s.sessions[id]).toMatchObject({ id, machine: m.name });
		if (m.life.phase === "booting" || m.life.phase === "failed") expect(m.sessions).toHaveLength(1);
	}

	const plugged = machines.flatMap((m) => {
		const { life } = m;
		if (life.phase === "failed") return [];
		const nics = life.phase === "removing" ? life.ports : life.plugs;
		if (nics.length > 0) expect(nics).toHaveLength(m.spec.nics.length);
		if (life.phase === "removing") {
			return life.ports.flatMap((port, nic) => (port === null ? [] : [{ machine: m.name, nic, port, up: false }]));
		}
		return life.plugs.flatMap((plug, nic) => {
			if (plug.kind === "none") return [];
			return [{ machine: m.name, nic, port: plug.port, up: life.phase === "ready" && plug.link === "up" }];
		});
	});
	expect(new Set(plugged.map((p) => p.port)).size).toBe(plugged.length);
	expect([...takenPorts(s)].sort()).toEqual(plugged.map((p) => p.port).sort());
	expect(lowestFreePorts(s, 8)).toHaveLength(8 - plugged.length);

	expect([...s.panes.order].sort()).toEqual([...s.rail].sort());
	const visible = visiblePanes(s.panes);
	expect(visible.length).toBeLessThanOrEqual(capacity(s.panes));
	expect(reconcilePanes(s.panes)).toBe(s.panes);
	const holder = keyboardHolder(s.keyboard);
	if (visible.length > 0) expect(visible).toContain(holder);
	else expect(holder).toBeNull();
	expect(s.log.length).toBeLessThanOrEqual(LOG_LIMIT);

	expect(Object.fromEntries(world.ports)).toEqual(
		Object.fromEntries(plugged.map((p) => [p.port, { machine: p.machine, nic: p.nic, up: p.up }])),
	);
	expect([...world.screens].sort()).toEqual(Object.keys(s.sessions).sort());
	const running = machines.flatMap((m) =>
		m.life.phase === "booting" || m.life.phase === "ready" ? [[m.name, m.life.attempt]] : [],
	);
	expect(Object.fromEntries(world.kernels)).toEqual(Object.fromEntries(running));
	expect(world.hz).toBe(clockHz(s));
	expect(world.hz).toBe(machines.some((m) => m.life.phase === "booting") ? 10 : 1);
}

const REPEATABLE = new Set<LabEvent["type"]>([
	"cmd/spawn",
	"cmd/remove",
	"cmd/boot-again",
	"cmd/link",
	"ui/tab-selected",
	"ui/bar",
]);
const isRepeatable = (event: LabEvent): boolean =>
	event.type.startsWith("vm/") ||
	event.type.startsWith("session/") ||
	event.type === "tick" ||
	REPEATABLE.has(event.type);

describe("any sequence of events", () => {
	test("keeps the lab, its panes, and the world its effects drive in line", () => {
		fc.assert(
			fc.property(
				fc.array(intentArb, { maxLength: 60 }),
				fc.constantFrom(WIDE, { width: 850, height: 250 }),
				(intents, area) => {
					const world = new World();
					let s = emptyLab(area);
					for (const intent of intents) {
						const event = eventOf(intent, s);
						if (!event) continue;
						const step = update(s, event);
						for (const effect of step.effects) world.apply(effect);
						expect(step.state.now).toBeGreaterThanOrEqual(s.now);
						s = step.state;
						checkLab(s, world);
					}
				},
			),
			{ numRuns: 300 },
		);
	});

	test("a runtime event or a planned command delivered twice does nothing the second time", () => {
		fc.assert(
			fc.property(fc.array(intentArb, { maxLength: 60 }), (intents) => {
				let s = emptyLab();
				for (const intent of intents) {
					const event = eventOf(intent, s);
					if (!event) continue;
					s = update(s, event).state;
					if (isRepeatable(event)) expect(update(s, event)).toEqual({ state: s, effects: [] });
					if (isRepeatable(event)) expect(update(s, event).state).toBe(s);
				}
			}),
			{ numRuns: 300 },
		);
	});
});
