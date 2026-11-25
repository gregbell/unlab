import { describe, expect, test } from "vitest";
import { port0 } from "../../test/support/ports.ts";
import { planBoot, planLink, planPlug, planRestore, portsOf } from "./machines.ts";
import { planSwitch, portLabel } from "./switches.ts";
import {
	bootEvent,
	checkpoint,
	effectsOf,
	emptyLab,
	hasFailed,
	hasStopped,
	IMAGES,
	isReady,
	isSaved,
	labWith,
	linkEvent,
	machine,
	plugEvent,
	power,
	remove,
	run,
	spawnEvent,
	switchNamed,
	WIDE,
	withSwitches,
} from "./testkit.ts";
import type {
	CommandEvent,
	LabState,
	MachineName,
	NicNo,
	NicRef,
	Place,
	PortNo,
	PortRef,
	SwitchName,
} from "./types.ts";
import { initialState, update } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

const lan = switchNamed("lan");
const wan = switchNamed("wan");

function added(state: LabState, ...names: readonly (SwitchName | null)[]): LabState {
	return names.reduce((s, chosen) => {
		const plan = planSwitch(s, chosen);
		if ("kind" in plan) throw new Error(`cannot add ${chosen}: ${plan.kind}`);
		return run(s, { type: "cmd/switch-add", plan });
	}, state);
}

const removed = (name: SwitchName): CommandEvent => ({ type: "cmd/switch-remove", switch: name, cause: "bar" });
const reloaded = (s: LabState): LabState => restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s)).state;

describe("adding a switch", () => {
	test("gives it the chosen name, or the lowest free switch<n> that no machine has", () => {
		const s = run(labWith(1), spawnEvent(labWith(1), 1, { name: "switch2" }));
		expect(added(s, lan, null, null, switchNamed("switch5"), null).switches).toEqual([
			"switch0",
			"lan",
			"switch1",
			"switch3",
			"switch5",
			"switch4",
		]);
		const gap = run(added(emptyLab(), null, null), removed(switchNamed("switch1")));
		expect(planSwitch(gap, null)).toEqual({ name: "switch1" });
	});

	test("refuses a name that a machine or a switch has, whatever state the machine is in, until it is gone", () => {
		let s = added(emptyLab(), lan);
		s = run(s, spawnEvent(s, 1, { name: "web" }));
		const web = switchNamed("web");
		const taken = { kind: "name-taken", name: "web", by: "machine" };
		expect(planSwitch(s, lan)).toEqual({ kind: "name-taken", name: "lan", by: "switch" });
		expect(planSwitch(s, switchNamed("switch0"))).toEqual({ kind: "name-taken", name: "switch0", by: "switch" });
		expect(planSwitch(s, web)).toEqual(taken);
		s = run(s, remove(s.rail[0]));
		expect(planSwitch(s, web)).toEqual(taken);
		s = run(s, hasStopped(s.rail[0]));
		expect(planSwitch(s, web)).toEqual({ name: "web" });
	});

	test("stops at eight, and a ninth that was planned before is ignored", () => {
		const seven = added(emptyLab(), ...Array<null>(6).fill(null));
		expect(seven.switches).toHaveLength(7);
		const plans = [lan, wan].map((name) => planSwitch(seven, name));
		const eight = run(seven, { type: "cmd/switch-add", plan: { name: lan } });
		expect(planSwitch(eight, null)).toEqual({ kind: "no-switch-room" });
		expect(planSwitch(eight, wan)).toEqual({ kind: "no-switch-room" });
		expect(plans).toEqual([{ name: "lan" }, { name: "wan" }]);
		expect(update(eight, { type: "cmd/switch-add", plan: { name: wan } })).toEqual({ state: eight, effects: [] });
	});

	test("twice is once", () => {
		const s = added(emptyLab(), lan);
		const again = update(s, { type: "cmd/switch-add", plan: { name: lan } });
		expect(again.state).toBe(s);
		expect(again.effects).toEqual([]);
	});
});

/** A link change because a cable was put in or taken out. */
const replugged = { cause: "bar", plug: true } as const;

describe("removing a switch", () => {
	/** node1 on switch0, node2 on lan and switch0, node3 on lan. All ready. */
	const wired = (): LabState => {
		let s = added(labWith(1), lan);
		s = run(s, spawnEvent(s, 1, { net: [lan, "switch0"] }));
		s = run(s, spawnEvent(s, 1, { net: lan }));
		return run(s, isReady("node2"), isReady("node3"));
	};

	test("unplugs the NICs in it, link down first, and leaves every machine as it runs", () => {
		const s = wired();
		const after = run(s, removed(lan));
		expect(after.switches).toEqual(["switch0"]);
		expect(effectsOf(s, removed(lan))).toEqual([
			{ type: "link/set", port: { switch: "lan", port: 1 }, machine: "node2", nic: 0, up: false, ...replugged },
			{ type: "port/detach", port: { switch: "lan", port: 1 } },
			{ type: "link/set", port: { switch: "lan", port: 2 }, machine: "node3", nic: 0, up: false, ...replugged },
			{ type: "port/detach", port: { switch: "lan", port: 2 } },
			{ type: "switch/remove", switch: "lan" },
			{ type: "announce", text: "lan removed" },
		]);
		expect(machine(after, "node2")).toMatchObject({
			life: { phase: "ready", plugs: [{ kind: "none" }, { kind: "port", port: port0(2), link: "up" }] },
			spec: { nics: [{ net: "none" }, { net: "switch0" }] },
		});
		expect(machine(after, "node3").life).toMatchObject({ phase: "ready", plugs: [{ kind: "none" }] });
		expect(after.machines.node1).toBe(s.machines.node1);
		for (const name of s.rail) expect(machine(after, name).sessions).toBe(machine(s, name).sessions);
	});

	test("says of a link that was not up why: a cut one, one of a machine that boots, and one that is off", () => {
		let s = wired();
		s = run(s, linkEvent(s, false, { machine: "node2", nic: 0 }), power("off", "node3"), hasStopped("node3"));
		s = run(s, spawnEvent(s, 1, { net: lan }));
		const effects = effectsOf(s, removed(lan));
		expect(effects.filter(({ type }) => type === "link/set")).toEqual([]);
		expect(effects.filter(({ type }) => type === "capture/dead-cable")).toMatchObject([
			{ port: { port: 1 }, machine: "node2", nic: 0, cause: "bar", dead: { way: "out", cut: true, machine: null } },
			{ port: { port: 2 }, machine: "node3", nic: 0, cause: "bar", dead: { way: "out", cut: false, machine: "off" } },
			{
				port: { port: 3 },
				machine: "node4",
				nic: 0,
				cause: "bar",
				dead: { way: "out", cut: false, machine: "booting" },
			},
		]);
		expect(effects.filter(({ type }) => type === "port/detach")).toHaveLength(3);
		s = run(s, removed(lan));
		expect(effectsOf(s, isReady("node4")).filter(({ type }) => type === "link/set")).toEqual([]);
		expect(machine(run(s, isReady("node4")), "node4").life).toMatchObject({
			phase: "ready",
			plugs: [{ kind: "none" }],
		});
	});

	test("takes the port from a machine that is going, which then has none to free", () => {
		const s = run(wired(), remove("node3"), removed(lan));
		expect(machine(s, "node3").life).toMatchObject({ phase: "removing", ports: [null] });
		expect(effectsOf(s, hasStopped("node3")).filter(({ type }) => type === "port/detach")).toEqual([]);
	});

	test("leaves a failed machine to boot unplugged", () => {
		const s = run(wired(), hasFailed("node3"), removed(lan));
		expect(machine(s, "node3").spec.nics).toMatchObject([{ net: "none" }]);
	});

	test("twice is once, and the default switch and one that is not there stay out of it", () => {
		const s = wired();
		const after = run(s, removed(lan));
		for (const [state, name] of [
			[after, lan],
			[s, switchNamed("switch0")],
			[s, wan],
		] as const) {
			const step = update(state, removed(name));
			expect(step.state).toBe(state);
			expect(step.effects).toEqual([]);
		}
	});

	test("lets link up plug the NIC into the default switch, as it does any that is unplugged", () => {
		const s = run(wired(), removed(lan));
		expect(effectsOf(s, linkEvent(s, true, "node3"))).toEqual([
			{ type: "port/attach", port: port0(3), machine: "node3", nic: 0 },
			{ type: "link/set", port: port0(3), machine: "node3", nic: 0, up: true, cause: "bar" },
			{ type: "announce", text: "node3 link up" },
		]);
	});

	test("leaves a NIC that link up plugged in again to boot there, after a failure and a reload", () => {
		const back = run(wired(), removed(lan));
		const s = run(back, linkEvent(back, true, "node3"));
		expect(machine(s, "node3").spec.nics).toMatchObject([{ net: "switch0" }]);
		const booted = (state: LabState) => run(state, bootEvent(state, "node3")).machines.node3?.life;
		const failed = run(s, hasFailed("node3"));
		expect(booted(failed)).toMatchObject({ plugs: [{ port: port0(3), link: "up" }] });
		expect(booted(reloaded(failed))).toMatchObject({ plugs: [{ port: port0(3), link: "up" }] });
	});

	test("comes back empty under the same name", () => {
		const s = added(run(wired(), removed(lan)), lan);
		expect(s.switches).toEqual(["switch0", "lan"]);
		expect(run(s, spawnEvent(s, 1, { net: lan })).machines.node4?.life).toMatchObject({
			plugs: [{ port: { switch: "lan", port: 1 } }],
		});
	});

	test("comes back from a reload unplugged", () => {
		const s = reloaded(run(wired(), removed(lan)));
		expect(s.switches).toEqual(["switch0"]);
		expect(machine(s, "node2")).toMatchObject({
			spec: { nics: [{ net: "none" }, { net: "switch0" }] },
			life: { plugs: [{ kind: "none" }, { port: port0(2), link: "up" }] },
		});
	});
});

describe("moving a cable", () => {
	/** node1 and node2 on switch0, the router node3 on switch0 and on none. All ready, with lan empty. */
	const wired = (): LabState => {
		let s = added(labWith(2), lan);
		s = run(s, spawnEvent(s, 1, { net: ["switch0", "none"] }));
		return run(s, isReady("node3"));
	};
	const eth = (machine: MachineName, nic: NicNo = 0): NicRef => ({ machine, nic });
	const on = (name: SwitchName, port: PortNo): PortRef => ({ switch: name, port });
	const anywhere = (name: SwitchName): Place => ({ switch: name, port: null });

	test("takes it out of its port, link down first, and puts it in the other with its link up", () => {
		const s = wired();
		const moved = plugEvent(s, eth("node1"), anywhere(lan));
		expect(effectsOf(s, moved)).toEqual([
			{ type: "link/set", port: port0(1), machine: "node1", nic: 0, up: false, ...replugged },
			{ type: "port/detach", port: port0(1) },
			{ type: "port/attach", port: on(lan, 1), machine: "node1", nic: 0 },
			{ type: "link/set", port: on(lan, 1), machine: "node1", nic: 0, up: true, ...replugged },
			{ type: "announce", text: "node1 plugged into lan port 1" },
		]);
		const after = run(s, moved);
		expect(machine(after, "node1").life).toEqual({
			...machine(s, "node1").life,
			plugs: [{ kind: "port", port: on(lan, 1), link: "up" }],
		});
		expect(machine(after, "node1").sessions).toBe(machine(s, "node1").sessions);
		expect([after.machines.node2, after.machines.node3]).toEqual([s.machines.node2, s.machines.node3]);
	});

	test("takes the lowest free port, or the one that is named, on its own switch too", () => {
		let s = wired();
		s = run(s, plugEvent(s, eth("node1"), on(lan, 3)), plugEvent(s, eth("node2"), anywhere(lan)));
		expect(planPlug(s, eth("node3", 1), anywhere(lan))).toEqual({ ...eth("node3", 1), to: on(lan, 2) });
		expect(planPlug(s, eth("node3", 1), anywhere("switch0"))).toEqual({ ...eth("node3", 1), to: port0(1) });
		s = run(s, plugEvent(s, eth("node1"), on(lan, 8)));
		expect(portsOf(machine(s, "node1").life)).toEqual([on(lan, 8)]);
	});

	test("changes nothing when it is there already, whichever free port is lower", () => {
		const s = run(wired(), remove("node1"), hasStopped("node1"));
		for (const to of [anywhere("switch0"), port0(2)]) {
			const step = update(s, plugEvent(s, eth("node2"), to));
			expect(step.state).toBe(s);
			expect(step.effects).toEqual([]);
		}
		const none = update(s, plugEvent(s, eth("node3", 1), null));
		expect(none).toEqual({ state: s, effects: [] });
	});

	test("moves a cut cable as it is, and says that it went from one port to the other", () => {
		let s = wired();
		s = run(s, linkEvent(s, false, "node1"));
		const cut = { machine: "node1", nic: 0, cause: "bar" };
		const dead = { cut: true, machine: null };
		expect(effectsOf(s, plugEvent(s, eth("node1"), on(lan, 4)))).toEqual([
			{ type: "capture/dead-cable", port: port0(1), ...cut, dead: { way: "out", ...dead } },
			{ type: "port/detach", port: port0(1) },
			{ type: "port/attach", port: on(lan, 4), machine: "node1", nic: 0 },
			{ type: "capture/dead-cable", port: on(lan, 4), ...cut, dead: { way: "in", ...dead } },
			{ type: "announce", text: "node1 plugged into lan port 4" },
		]);
		s = run(s, plugEvent(s, eth("node1"), on(lan, 4)));
		expect(machine(s, "node1").life).toMatchObject({ plugs: [{ port: on(lan, 4), link: "cut" }] });
		expect(planLink(s, ["node1"], true)).toMatchObject([{ port: on(lan, 4), newPort: false }]);
	});

	test("puts a new cable in a NIC that had none, and takes one out", () => {
		let s = wired();
		s = run(s, plugEvent(s, eth("node3", 1), anywhere(lan)));
		expect(machine(s, "node3")).toMatchObject({
			life: { plugs: [{ port: port0(3) }, { port: on(lan, 1), link: "up" }] },
			spec: { nics: [{ net: "switch0" }, { net: "lan" }] },
		});
		const out = plugEvent(s, eth("node3"), null);
		expect(effectsOf(s, out)).toEqual([
			{ type: "link/set", port: port0(3), machine: "node3", nic: 0, up: false, ...replugged },
			{ type: "port/detach", port: port0(3) },
			{ type: "announce", text: "node3:eth0 unplugged" },
		]);
		s = run(s, out);
		expect(machine(s, "node3")).toMatchObject({
			life: { plugs: [{ kind: "none" }, { port: on(lan, 1) }] },
			spec: { nics: [{ net: "none" }, { net: "lan" }] },
		});
	});

	test("refuses a port that is taken, whatever its machine is doing, and a switch with none free", () => {
		let s = wired();
		const taken = (by: NicRef, port: PortRef) => ({ kind: "port-taken", port, by });
		expect(planPlug(s, eth("node1"), port0(3))).toEqual(taken(eth("node3"), port0(3)));
		expect(planPlug(s, eth("node3", 1), port0(3))).toEqual(taken(eth("node3"), port0(3)));
		s = run(s, remove("node2"));
		expect(planPlug(s, eth("node1"), port0(2))).toEqual(taken(eth("node2"), port0(2)));
		s = run(s, spawnEvent(s, 2, { net: [lan, lan, lan, lan] }));
		expect(planPlug(s, eth("node1"), anywhere(lan))).toEqual({ kind: "no-ports", switch: "lan", free: 0, wanted: 1 });
		expect(planPlug(s, eth("node1"), on(wan, 1))).toMatchObject({ kind: "no-ports", switch: "wan" });
		const stale = update(s, { type: "cmd/plug", plan: { ...eth("node1"), to: on(lan, 1) }, cause: "bar" });
		expect(stale).toEqual({ state: s, effects: [] });
	});

	test("is not for a NIC that is not there", () => {
		const s = wired();
		for (const nic of [eth("node1", 1), eth("node9")]) {
			const event: CommandEvent = { type: "cmd/plug", plan: { ...nic, to: on(lan, 1) }, cause: "bar" };
			expect(update(s, event)).toEqual({ state: s, effects: [] });
		}
	});

	test("of a machine that is off changes the port that its boot finds it in", () => {
		let s = run(wired(), power("off", "node1"), hasStopped("node1"));
		const effects = effectsOf(s, plugEvent(s, eth("node1"), on(lan, 2)));
		expect(effects.filter(({ type }) => type === "link/set")).toEqual([]);
		expect(effects.filter(({ type }) => type === "capture/dead-cable")).toMatchObject([
			{ port: port0(1), dead: { way: "out", cut: false, machine: "off" } },
			{ port: on(lan, 2), dead: { way: "in", cut: false, machine: "off" } },
		]);
		const out = effectsOf(s, plugEvent(s, eth("node1"), null));
		expect(out.filter(({ type }) => type === "capture/dead-cable")).toMatchObject([
			{ port: port0(1), dead: { way: "out", machine: "off" } },
		]);
		s = run(s, plugEvent(s, eth("node1"), on(lan, 2)));
		s = run(s, bootEvent(s, "node1"));
		expect(effectsOf(s, isReady("node1", 2)).filter(({ type }) => type === "link/set")).toMatchObject([
			{ port: on(lan, 2), up: true },
		]);
	});

	test("is where a failed machine boots, what a restore keeps, and what a reload brings back", () => {
		let s = wired();
		s = run(s, plugEvent(s, eth("node1"), on(lan, 4)), plugEvent(s, eth("node2"), null));
		expect(portsOf(machine(reloaded(s), "node1").life)).toEqual([on(lan, 4)]);
		expect(portsOf(machine(reloaded(s), "node2").life)).toEqual([]);
		const failed = run(s, hasFailed("node1"), hasFailed("node2"));
		for (const state of [failed, reloaded(failed)]) {
			expect(planBoot(state, ["node1", "node2"])).toEqual([
				{ machine: "node1", ports: [on(lan, 1)] },
				{ machine: "node2", ports: [null] },
			]);
		}
		s = run(s, checkpoint("node1", "before"), isSaved("node1", 1));
		expect(planRestore(s, "node1", 1)).toMatchObject({ ports: [on(lan, 4)] });
		expect(planRestore(run(s, hasFailed("node1")), "node1", 1)).toMatchObject({ ports: [on(lan, 1)] });
	});
});

describe("the switch on the page", () => {
	test("is the one that was chosen, through a reload, until it is removed", () => {
		let s = added(labWith(1), lan, wan);
		expect(s.shownSwitch).toBe("switch0");
		s = run(s, { type: "ui/switch-shown", switch: wan });
		expect(s.shownSwitch).toBe("wan");
		expect(reloaded(s).shownSwitch).toBe("wan");
		expect(run(s, removed(lan)).shownSwitch).toBe("wan");
		expect(run(s, removed(wan)).shownSwitch).toBe("switch0");
		expect(run(s, removed(wan), { type: "ui/switch-shown", switch: wan }).shownSwitch).toBe("switch0");
	});
});

describe("a port's label", () => {
	test("has the switch when there are several, and for one that is gone", () => {
		const port = { switch: lan, port: 3 } as const;
		const both = added(emptyLab(), lan);
		expect([portLabel(emptyLab(), port0(3)), portLabel(both, port0(3)), portLabel(both, port)]).toEqual([
			"port 3",
			"switch0 port 3",
			"lan port 3",
		]);
		const gone = run(both, removed(lan));
		expect([portLabel(gone, port0(3)), portLabel(gone, port)]).toEqual(["port 3", "lan port 3"]);
	});
});

describe("a reload", () => {
	test("brings back every switch by name and in order, with nothing plugged in or not", () => {
		const s = added(labWith(1), wan, null, lan);
		expect(reloaded(s).switches).toEqual(["switch0", "wan", "switch1", "lan"]);
		expect(reloaded(added(emptyLab(), lan)).switches).toEqual(["switch0", "lan"]);
	});

	test("opens a lab whose plugged NIC was saved with no network on the switch that it is in, for its later boots", () => {
		const saved = JSON.parse(saveWorkspace(labWith(1)));
		saved.nodes[0].nics[0].net = "none";
		const s = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved)).state;
		const failed = run(s, hasFailed("node1"));
		expect(run(failed, bootEvent(failed, "node1")).machines.node1?.life).toMatchObject({ plugs: [{ port: port0(1) }] });
	});

	test("refuses a ninth switch, and one with a name that no one could have chosen", () => {
		const save = (...switches: string[]) =>
			JSON.stringify({ ...JSON.parse(saveWorkspace(withSwitches(emptyLab()))), switches: ["switch0", ...switches] });
		const open = (raw: string) => restoreWorkspace(initialState(IMAGES, WIDE), raw).state.switches;
		expect(open(save("a", "b", "c", "d", "e", "f", "g"))).toHaveLength(8);
		for (const bad of [["a", "b", "c", "d", "e", "f", "g", "h"], ["none"], ["all"], ["Lan"], ["lan", "lan"]]) {
			expect(() => open(save(...bad)), bad.join()).toThrow("could not be read");
		}
	});
});
