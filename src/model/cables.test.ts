import { describe, expect, test } from "vitest";
import { port0 } from "../../test/support/ports.ts";
import { cableAt, isCablePlanError, joined, planCable } from "./cables.ts";
import { heldPorts, lowestFreePorts, planPlug, planSpawn } from "./machines.ts";
import { selectAllLinks, selectLinks, selectPorts, selectStorm } from "./selectors.ts";
import {
	effectsOf,
	IMAGES,
	isReady,
	labWith,
	plugEvent,
	run,
	spawnEvent,
	spawnRequest,
	switchNamed,
	WIDE,
	withSwitches,
} from "./testkit.ts";
import type { CommandEvent, LabState, Place, PortNo, PortRef, SwitchName } from "./types.ts";
import { initialState, update } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

const lan = switchNamed("lan");
const wan = switchNamed("wan");
const dmz = switchNamed("dmz");

const at = (on: SwitchName, port: PortNo): PortRef => ({ switch: on, port });
const place = (on: SwitchName, port: PortNo | null = null): Place => ({ switch: on, port });

/** The cable that the two places would get, put in. */
function cabled(state: LabState, from: Place, to: Place): LabState {
	const plan = planCable(state, from, to);
	if (isCablePlanError(plan)) throw new Error(`no cable: ${plan.kind}`);
	return run(state, { type: "cmd/cable", plan, cause: "bar" });
}

const uncable = (port: PortRef): CommandEvent => ({ type: "cmd/uncable", port, cause: "agent" });
const link = (port: PortRef, up: boolean): CommandEvent => ({
	type: "cmd/cable-link",
	changes: [{ port, up }],
	cause: "bar",
});
const ends = (state: LabState) =>
	state.switchCables.map(({ ends: [a, b], link }) => `${a.switch}:${a.port}-${b.switch}:${b.port} ${link}`);
const reloaded = (s: LabState) => restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));

/** switch0 with node1 on port 1 and node2 on port 2, both ready, and lan and wan with nothing in them. */
function three(): LabState {
	return run(withSwitches(labWith(2), lan, wan), isReady("node1"), isReady("node2"));
}

describe("planning a cable between switches", () => {
	test("takes the lowest free port of each switch, which on switch0 is after its machines", () => {
		expect(planCable(three(), place("switch0"), place(lan))).toEqual({ ends: [port0(3), at(lan, 1)] });
	});

	test("takes the ports that are named, at either end", () => {
		expect(planCable(three(), place(lan, 8), place(wan))).toEqual({ ends: [at(lan, 8), at(wan, 1)] });
		expect(planCable(three(), place(lan), place(wan, 5))).toEqual({ ends: [at(lan, 1), at(wan, 5)] });
	});

	test("takes two ports of one switch for a cable from it to itself, and never one port twice", () => {
		expect(planCable(three(), place(lan), place(lan))).toEqual({ ends: [at(lan, 1), at(lan, 2)] });
		expect(planCable(three(), place(lan), place(lan, 1))).toEqual({ ends: [at(lan, 2), at(lan, 1)] });
		expect(planCable(three(), place(lan, 4), place(lan, 4))).toEqual({ kind: "one-port", port: at(lan, 4) });
	});

	test("names who has a port that is taken: a NIC, or the cable from another port", () => {
		expect(planCable(three(), place("switch0", 2), place(lan))).toEqual({
			kind: "port-taken",
			port: port0(2),
			by: { machine: "node2", nic: 0 },
		});
		const s = cabled(three(), place(lan, 8), place(wan, 7));
		expect(planCable(s, place("switch0"), place(wan, 7))).toEqual({
			kind: "port-taken",
			port: at(wan, 7),
			by: at(lan, 8),
		});
	});

	test("says which switch has too few free ports, and how many the cable takes of it", () => {
		let s = three();
		for (let i = 0; i < 7; i++) s = cabled(s, place(lan), place(wan));
		expect(planCable(s, place(lan), place(lan))).toEqual({ kind: "no-ports", switch: lan, free: 1, wanted: 2 });
		s = cabled(s, place(lan), place("switch0"));
		expect(planCable(s, place("switch0"), place(lan))).toEqual({ kind: "no-ports", switch: lan, free: 0, wanted: 1 });
		expect(planCable(s, place(dmz), place(wan))).toEqual({ kind: "no-ports", switch: dmz, free: 0, wanted: 1 });
	});
});

describe("a cable between switches", () => {
	test("holds a port on each, which no NIC and no other cable is then given", () => {
		const s = cabled(three(), place(lan), place(wan, 3));
		expect(ends(s)).toEqual(["lan:1-wan:3 up"]);
		expect(heldPorts(s, lan)).toEqual([{ port: 1, far: at(wan, 3), link: "up" }]);
		expect(heldPorts(s, wan)).toEqual([{ port: 3, far: at(lan, 1), link: "up" }]);
		expect(lowestFreePorts(s, lan, 2)).toEqual([2, 3]);
		const spawned = planSpawn(s, 1, spawnRequest({ net: lan }));
		expect("machines" in spawned && spawned.machines[0].ports).toEqual([at(lan, 2)]);
		expect(planPlug(s, { machine: "node1", nic: 0 }, place(wan, 3))).toEqual({
			kind: "port-taken",
			port: at(wan, 3),
			by: at(lan, 1),
		});
		expect(planCable(s, place(lan), place(wan))).toEqual({ ends: [at(lan, 2), at(wan, 1)] });
	});

	test("goes in with its link up, and says so to the runtime and the page", () => {
		const s = three();
		const plan = { ends: [at(lan, 1), at(wan, 3)] as const };
		expect(effectsOf(s, { type: "cmd/cable", plan, cause: "agent" })).toEqual([
			{ type: "cable/attach", ends: plan.ends },
			{ type: "cable/link", ends: plan.ends, up: true, cause: "agent", plug: true },
			{ type: "announce", text: "lan port 1 to wan port 3 cabled" },
		]);
	});

	test("is ignored once either of its ports is taken, or its switch is gone", () => {
		const plan = { ends: [at(lan, 1), at(wan, 3)] as const };
		const event: CommandEvent = { type: "cmd/cable", plan, cause: "bar" };
		const s = run(three(), event);
		expect(update(s, event)).toEqual({ state: s, effects: [] });
		const moved = run(three(), plugEvent(three(), { machine: "node1", nic: 0 }, place(wan, 3)));
		expect(update(moved, event).state).toBe(moved);
		const gone = run(three(), { type: "cmd/switch-remove", switch: wan, cause: "bar" });
		expect(update(gone, event).state).toBe(gone);
	});

	test("can be one of several between two switches, and can go from a switch to itself", () => {
		let s = cabled(three(), place(lan), place(wan));
		s = cabled(s, place(lan), place(wan));
		s = cabled(s, place("switch0"), place("switch0"));
		expect(ends(s)).toEqual(["lan:1-wan:1 up", "lan:2-wan:2 up", "switch0:3-switch0:4 up"]);
		expect(heldPorts(s, "switch0").map(({ port }) => port)).toEqual([1, 2, 3, 4]);
	});

	test("is cut and reconnected by either of its ports, and keeps both", () => {
		const s = cabled(three(), place(lan, 8), place(wan, 7));
		const cable = [at(lan, 8), at(wan, 7)];
		expect(effectsOf(s, link(at(wan, 7), false))).toEqual([
			{ type: "cable/link", ends: cable, up: false, cause: "bar" },
			{ type: "announce", text: "cable from lan port 8 to wan port 7 cut" },
		]);
		const cut = run(s, link(at(wan, 7), false));
		expect(ends(cut)).toEqual(["lan:8-wan:7 cut"]);
		expect(lowestFreePorts(cut, wan, 8)).not.toContain(7);
		expect(update(cut, link(at(lan, 8), false))).toEqual({ state: cut, effects: [] });
		expect(effectsOf(cut, link(at(lan, 8), true))).toEqual([
			{ type: "cable/link", ends: cable, up: true, cause: "bar" },
			{ type: "announce", text: "cable from lan port 8 to wan port 7 reconnected" },
		]);
		expect(update(s, link(at(lan, 3), false))).toEqual({ state: s, effects: [] });
	});

	test("comes out by either of its ports, link first, and frees both", () => {
		const s = cabled(cabled(three(), place(lan, 8), place(wan, 7)), place(lan), place(wan));
		const cable = [at(lan, 8), at(wan, 7)];
		expect(effectsOf(s, uncable(at(wan, 7)))).toEqual([
			{ type: "cable/link", ends: cable, up: false, cause: "agent", plug: true },
			{ type: "cable/detach", ends: cable },
			{ type: "announce", text: "cable from lan port 8 to wan port 7 removed" },
		]);
		const out = run(s, uncable(at(lan, 8)));
		expect(ends(out)).toEqual(["lan:1-wan:1 up"]);
		expect(update(out, uncable(at(lan, 8)))).toEqual({ state: out, effects: [] });
		expect(update(out, uncable(port0(1)))).toEqual({ state: out, effects: [] });

		// One that is cut changes no link as it comes out, and the capture is told so.
		const cut = run(s, link(at(lan, 8), false));
		expect(effectsOf(cut, uncable(at(lan, 8)))[0]).toEqual({
			type: "cable/link",
			ends: cable,
			up: false,
			cause: "agent",
			plug: true,
			cut: true,
		});
	});

	test("goes with either of its switches, after the NICs of that switch, and frees its port on the other", () => {
		let s = cabled(three(), place(lan, 8), place(wan, 7));
		s = cabled(s, place("switch0"), place(lan));
		s = cabled(s, place(lan), place(lan));
		s = run(s, plugEvent(s, { machine: "node2", nic: 0 }, place(lan, 5)));
		const removed: CommandEvent = { type: "cmd/switch-remove", switch: lan, cause: "bar" };
		expect(effectsOf(s, removed).map((e) => [e.type, "ends" in e ? e.ends.map((end) => end.port) : ""])).toEqual([
			["link/set", ""],
			["port/detach", ""],
			["cable/link", [8, 7]],
			["cable/detach", [8, 7]],
			["cable/link", [3, 1]],
			["cable/detach", [3, 1]],
			["cable/link", [2, 3]],
			["cable/detach", [2, 3]],
			["switch/remove", ""],
			["announce", ""],
		]);
		const after = run(s, removed);
		expect(ends(after)).toEqual([]);
		expect(lowestFreePorts(after, wan, 8)).toHaveLength(8);
		expect(lowestFreePorts(after, "switch0", 8)).toEqual([2, 3, 4, 5, 6, 7, 8]);
	});

	test("is found at either of its ports and at no other", () => {
		const s = cabled(three(), place(lan, 8), place(wan, 7));
		expect(cableAt(s, at(lan, 8))).toBe(cableAt(s, at(wan, 7)));
		expect(cableAt(s, at(lan, 7))).toBeUndefined();
	});
});

describe("a loop of cables", () => {
	test("is closed by a cable between switches that frames already get between, or from a switch to itself", () => {
		let s = three();
		expect([joined(s, lan, wan), joined(s, lan, lan)]).toEqual([false, true]);
		s = cabled(s, place(lan), place(wan));
		expect([joined(s, lan, wan), joined(s, wan, lan), joined(s, "switch0", wan)]).toEqual([true, true, false]);
		s = cabled(s, place(wan), place("switch0"));
		expect(joined(s, "switch0", lan)).toBe(true);
	});

	test("is not closed through a cable that is cut", () => {
		let s = cabled(cabled(three(), place(lan), place(wan)), place(wan), place("switch0"));
		s = run(s, link(at(wan, 1), false));
		expect([joined(s, "switch0", lan), joined(s, "switch0", wan)]).toEqual([false, true]);
	});
});

describe("a storm", () => {
	const storm = (name: SwitchName, rate: number | null, dropped = 0): Parameters<typeof update>[1] => ({
		type: "switch/storm",
		switch: name,
		storm: rate === null ? null : { since: 4000, rate, dropped },
	});

	test("is announced when its first switch begins and when its last is over, and not as its numbers move", () => {
		const s = three();
		const begun = {
			type: "announce",
			text: "A storm has begun: frames go round a loop of cables until one of them is cut",
		};
		expect(effectsOf(s, storm(lan, 0))).toEqual([begun]);
		const storming = run(s, storm(lan, 0));
		// The other switches of the loop begin within the same millisecond, and the page has one voice.
		expect(effectsOf(storming, storm(wan, 0))).toEqual([]);
		const both = run(storming, storm(wan, 0));
		expect(effectsOf(both, storm(wan, null))).toEqual([]);
		expect(effectsOf(run(both, storm(wan, null)), storm(lan, null))).toEqual([
			{ type: "announce", text: "The storm is over" },
		]);
		expect(selectStorm(lan)(storming)).toEqual({ since: 4000, rate: 0, dropped: 0 });
		expect(selectStorm(wan)(storming)).toBeNull();
		const later = update(storming, storm(lan, 1980, 77));
		expect([selectStorm(lan)(later.state), later.effects]).toEqual([{ since: 4000, rate: 1980, dropped: 77 }, []]);
		expect(update(later.state, storm(lan, 1980, 77))).toEqual({ state: later.state, effects: [] });
		const over = update(later.state, storm(lan, null));
		expect([selectStorm(lan)(over.state), over.effects]).toEqual([
			null,
			[{ type: "announce", text: "The storm is over" }],
		]);
		expect(update(over.state, storm(lan, null))).toEqual({ state: over.state, effects: [] });
	});

	test("of a switch that is not there is ignored, and goes with a switch that is removed", () => {
		const s = three();
		expect(update(s, storm(dmz, 100))).toEqual({ state: s, effects: [] });
		const gone = run(s, storm(lan, 100), { type: "cmd/switch-remove", switch: lan, cause: "bar" });
		expect(gone.storms).toEqual({});
	});
});

describe("a saved lab", () => {
	function wired(): LabState {
		let s = cabled(three(), place(lan, 8), place(wan, 7));
		s = cabled(s, place(wan), place("switch0"));
		s = cabled(s, place("switch0"), place(lan));
		return run(s, link(at(wan, 1), false), {
			type: "switch/storm",
			switch: lan,
			storm: { since: 1, rate: 2, dropped: 3 },
		});
	}

	test("has its cables between switches as they were, cut or not, and no storm", () => {
		const s = wired();
		const { state } = reloaded(s);
		expect(ends(state)).toEqual(["lan:8-wan:7 up", "wan:1-switch0:3 cut", "switch0:4-lan:1 up"]);
		expect(state.switchCables).toEqual(s.switchCables);
		expect(state.storms).toEqual({});
		expect(JSON.parse(saveWorkspace(s))).toMatchObject({
			version: 8,
			cables: [
				{ ends: [at(lan, 8), at(wan, 7)], cut: false },
				{ ends: [at(wan, 1), port0(3)], cut: true },
				{ ends: [port0(4), at(lan, 1)], cut: false },
			],
		});
	});

	test("puts its cables in before its machines boot, and raises the link of those that are whole", () => {
		const { effects } = reloaded(wired());
		expect(effects.slice(0, 5).map((e) => [e.type, "ends" in e ? e.ends[0].port : "", "up" in e ? e.up : ""])).toEqual([
			["cable/attach", 8, ""],
			["cable/link", 8, true],
			["cable/attach", 1, ""],
			["cable/attach", 4, ""],
			["cable/link", 4, true],
		]);
		expect(effects.slice(0, 5).filter((e) => e.type === "cable/link")).toEqual([
			{ type: "cable/link", ends: [at(lan, 8), at(wan, 7)], up: true, cause: "runtime", plug: true },
			{ type: "cable/link", ends: [port0(4), at(lan, 1)], up: true, cause: "runtime", plug: true },
		]);
		expect(effects.findIndex((e) => e.type === "vm/boot")).toBeGreaterThan(4);
	});

	test("with a loop of cables opens as any other", () => {
		const loop = cabled(
			cabled(cabled(three(), place(lan), place(wan)), place(wan), place("switch0")),
			place("switch0"),
			place(lan),
		);
		expect(joined(loop, lan, lan)).toBe(true);
		const { state } = reloaded(loop);
		expect(state.switchCables).toEqual(loop.switchCables);
		expect(state.rail).toEqual(["node1", "node2"]);
	});

	test("from before there were such cables has none", () => {
		const saved = JSON.parse(saveWorkspace(three()));
		const { cables: _, ...before } = { ...saved, version: 7 };
		expect(restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(before)).state.switchCables).toEqual([]);
	});

	test.each([
		["a port that a NIC is in", (c: unknown[]) => [...c, { ends: [port0(1), at(lan, 2)], cut: false }]],
		["a port that another cable is in", (c: unknown[]) => [...c, { ends: [at(lan, 8), at(wan, 2)], cut: false }]],
		["one port for both its ends", (c: unknown[]) => [...c, { ends: [at(lan, 2), at(lan, 2)], cut: false }]],
		["a switch that is not there", (c: unknown[]) => [...c, { ends: [at(dmz, 2), at(lan, 2)], cut: false }]],
		[
			"a port that no switch has",
			(c: unknown[]) => [...c, { ends: [{ switch: lan, port: 9 }, at(wan, 2)], cut: false }],
		],
		["one end", (c: unknown[]) => [...c, { ends: [at(lan, 2)], cut: false }]],
		["no word on whether it is cut", (c: unknown[]) => [...c, { ends: [at(lan, 2), at(wan, 2)] }]],
		["no list of cables", () => undefined],
	])("is refused whole when a cable in it has %s", (_, damage) => {
		const saved = JSON.parse(saveWorkspace(wired()));
		const raw = JSON.stringify({ ...saved, cables: damage(saved.cables) });
		expect(() => restoreWorkspace(initialState(IMAGES, WIDE), raw)).toThrow(/could not be read/);
	});
});

describe("the faceplate", () => {
	test("draws a cable between switches at both its ports, each with the other as where it goes", () => {
		const s = run(cabled(three(), place(lan, 8), place(wan, 7)), link(at(lan, 8), false));
		expect(selectPorts(lan)(s)[7]).toEqual({
			port: 8,
			state: "cut",
			machine: null,
			cable: { to: at(wan, 7), label: "lan:8" },
			word: "cut",
			actionLabel: "Reconnect the cable from lan port 8 to wan port 7",
		});
		const up = run(s, link(at(wan, 7), true));
		expect(selectPorts(wan)(up)[6]).toEqual({
			port: 7,
			state: "up",
			machine: null,
			cable: { to: at(lan, 8), label: "wan:7" },
			word: "up",
			actionLabel: "Cut the cable from wan port 7 to lan port 8",
		});
		expect(selectPorts(lan)(up)[0]).toEqual({ port: 1, state: "empty", machine: null, word: null, actionLabel: null });
	});

	test("counts such a cable as a link of each switch it is in, up unless it is cut", () => {
		let s = cabled(three(), place(lan, 8), place(wan, 7));
		s = cabled(s, place(lan), place(lan));
		expect(selectLinks(lan)(s)).toEqual({ up: 3, total: 3, cut: 0 });
		expect(selectLinks(wan)(s)).toEqual({ up: 1, total: 1, cut: 0 });
		expect(selectLinks("switch0")(s)).toEqual({ up: 2, total: 2, cut: 0 });
		s = run(s, link(at(wan, 7), false));
		expect(selectLinks(lan)(s)).toEqual({ up: 2, total: 3, cut: 1 });
		expect(selectAllLinks(s)).toEqual({ up: 4, total: 6, cut: 2 });
	});

	test("of a lab with one switch and no such cable is as it was", () => {
		const s = run(labWith(2), isReady("node1"), spawnEvent(labWith(2), 0));
		expect(selectPorts("switch0")(s).filter((port) => "cable" in port)).toEqual([]);
	});
});
