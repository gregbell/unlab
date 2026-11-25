import { describe, expect, test } from "vitest";
import { port0 } from "../../test/support/ports.ts";
import { planSwitch } from "./switches.ts";
import {
	effectsOf,
	emptyLab,
	hasFailed,
	hasStopped,
	IMAGES,
	isReady,
	labWith,
	linkEvent,
	machine,
	power,
	remove,
	run,
	spawnEvent,
	switchNamed,
	WIDE,
	withSwitches,
} from "./testkit.ts";
import type { CommandEvent, LabState, SwitchName } from "./types.ts";
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
			{ type: "link/set", port: { switch: "lan", port: 1 }, machine: "node2", nic: 0, up: false, cause: "bar" },
			{ type: "port/detach", port: { switch: "lan", port: 1 } },
			{ type: "link/set", port: { switch: "lan", port: 2 }, machine: "node3", nic: 0, up: false, cause: "bar" },
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

	test("says nothing of a link that was not up: a cut one, one of a machine that boots, and one that is off", () => {
		let s = wired();
		s = run(s, linkEvent(s, false, { machine: "node2", nic: 0 }), power("off", "node3"), hasStopped("node3"));
		s = run(s, spawnEvent(s, 1, { net: lan }));
		const effects = effectsOf(s, removed(lan));
		expect(effects.filter(({ type }) => type === "link/set")).toEqual([]);
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

describe("a reload", () => {
	test("brings back every switch by name and in order, with nothing plugged in or not", () => {
		const s = added(labWith(1), wan, null, lan);
		expect(reloaded(s).switches).toEqual(["switch0", "wan", "switch1", "lan"]);
		expect(reloaded(added(emptyLab(), lan)).switches).toEqual(["switch0", "lan"]);
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
