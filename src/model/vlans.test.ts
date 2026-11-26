import { describe, expect, test } from "vitest";
import { port0 } from "../../test/support/ports.ts";
import { isCablePlanError, planCable } from "./cables.ts";
import {
	effectsOf,
	hasFailed,
	hasStopped,
	IMAGES,
	isReady,
	labWith,
	plugEvent,
	remove,
	run,
	switchNamed,
	WIDE,
	withSwitches,
} from "./testkit.ts";
import {
	type CommandEvent,
	DEFAULT_PORT_VLAN,
	type LabState,
	type PortRef,
	type PortVlan,
	type VlanId,
} from "./types.ts";
import { initialState } from "./update.ts";
import { parseVlanId, vlanOf, vlanText } from "./vlans.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

const lan = switchNamed("lan");
const access = (vlan: number): PortVlan => ({ mode: "access", vlan: vlan as VlanId });
const trunk = (allowed: readonly number[] | "all", native = 1): PortVlan => ({
	mode: "trunk",
	allowed: allowed === "all" ? "all" : (allowed as VlanId[]),
	native: native as VlanId,
});
const vlan = (port: PortRef, setting: PortVlan): CommandEvent => ({ type: "cmd/vlan", port, vlan: setting });
const reset = (port: PortRef) => ({ type: "port/vlan", port, vlan: DEFAULT_PORT_VLAN });

/** node1 and node2 ready on ports 1 and 2 of switch0, and a cable from its port 8 to port 1 of lan. */
function lab(): LabState {
	const ready = run(withSwitches(labWith(2), lan), isReady("node1"), isReady("node2"));
	const plan = planCable(ready, { switch: "switch0", port: 8 }, { switch: lan, port: 1 });
	if (isCablePlanError(plan)) throw new Error(plan.kind);
	return run(ready, { type: "cmd/cable", plan, cause: "bar" });
}

describe("a VLAN ID", () => {
	test("is a whole number from 1 to 4094", () => {
		expect(["1", "10", "4094"].map(parseVlanId)).toEqual([1, 10, 4094]);
		expect(["0", "4095", "-1", "1.5", "ten", "", "010000"].map(parseVlanId)).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
	});

	test("is written as a person reads it", () => {
		expect(vlanText(access(10))).toBe("vlan 10");
		expect(vlanText(trunk("all"))).toBe("trunk of all VLANs, native 1");
		expect(vlanText(trunk([10, 20, 30], 10))).toBe("trunk of 10, 20 and 30, native 10");
	});
});

describe("a port's VLAN", () => {
	test("is 1 for a new port, and is set on a port that a NIC or a cable is in, which the switch is told", () => {
		const s = lab();
		expect(vlanOf(s, port0(1))).toEqual(DEFAULT_PORT_VLAN);
		expect(effectsOf(s, vlan(port0(1), access(10)))).toEqual([{ type: "port/vlan", port: port0(1), vlan: access(10) }]);
		const set = run(s, vlan(port0(1), access(10)), vlan(port0(8), trunk([10, 20])));
		expect(vlanOf(set, port0(1))).toEqual(access(10));
		expect(vlanOf(set, port0(8))).toEqual(trunk([10, 20]));
		expect(vlanOf(set, { switch: lan, port: 1 })).toEqual(DEFAULT_PORT_VLAN);
	});

	test("is not set on a port that nothing is in, and setting it as it is changes nothing", () => {
		const s = lab();
		expect(run(s, vlan(port0(5), access(10)))).toBe(s);
		const set = run(s, vlan(port0(1), access(10)));
		expect(run(set, vlan(port0(1), access(10)))).toBe(set);
	});

	test("set back to VLAN 1 leaves the port as a new one is", () => {
		const set = run(lab(), vlan(port0(1), access(10)));
		const back = run(set, vlan(port0(1), access(1)));
		expect(back.portVlans).toEqual([]);
		expect(effectsOf(set, vlan(port0(1), access(1)))).toEqual([reset(port0(1))]);
	});

	test("stays while its cable is cut, and while its machine is off", () => {
		const set = run(lab(), vlan(port0(1), access(10)), vlan(port0(8), access(20)));
		const cut = run(set, { type: "cmd/cable-link", changes: [{ port: port0(8), up: false }], cause: "bar" });
		expect(vlanOf(cut, port0(8))).toEqual(access(20));
		const off = run(set, { type: "cmd/power", machines: ["node1"], next: "off" }, hasStopped("node1"));
		expect(off.machines.node1?.life.phase).toBe("off");
		expect(vlanOf(off, port0(1))).toEqual(access(10));
	});

	test("is 1 again once nothing is in the port, so whatever is put in next starts there", () => {
		const set = run(
			lab(),
			vlan(port0(1), access(10)),
			vlan(port0(8), access(20)),
			vlan({ switch: lan, port: 1 }, trunk("all")),
		);
		const ways: [string, readonly CommandEvent[] | ((s: LabState) => LabState), readonly PortRef[]][] = [
			["unplug", (s) => run(s, plugEvent(s, { machine: "node1", nic: 0 }, null)), [port0(1)]],
			["a move", (s) => run(s, plugEvent(s, { machine: "node1", nic: 0 }, { switch: "switch0", port: 5 })), [port0(1)]],
			["uncable", [{ type: "cmd/uncable", port: port0(8), cause: "bar" }], [port0(8), { switch: lan, port: 1 }]],
			["rm", (s) => run(s, remove("node1"), hasStopped("node1")), [port0(1)]],
			["a failure", (s) => run(s, hasFailed("node1")), [port0(1)]],
		];
		for (const [way, change, freed] of ways) {
			const before = set;
			const after = typeof change === "function" ? change(before) : run(before, ...change);
			for (const port of freed) expect(vlanOf(after, port), way).toEqual(DEFAULT_PORT_VLAN);
			expect(after.portVlans.length, way).toBe(3 - freed.length);
		}
		const moved = run(set, plugEvent(set, { machine: "node1", nic: 0 }, { switch: "switch0", port: 5 }));
		expect(vlanOf(moved, port0(5))).toEqual(DEFAULT_PORT_VLAN);
	});

	test("that is freed is reset on the switch, after the cable has come out", () => {
		const set = run(lab(), vlan(port0(1), access(10)));
		const effects = effectsOf(set, plugEvent(set, { machine: "node1", nic: 0 }, null));
		const types = effects.map((e) => e.type);
		expect(effects.at(-1)).toEqual(reset(port0(1)));
		expect(types.indexOf("port/detach")).toBeLessThan(types.lastIndexOf("port/vlan"));
	});

	test("goes with a switch that is removed, which the fabric needs not be told", () => {
		const set = run(lab(), vlan({ switch: lan, port: 1 }, trunk("all")), vlan(port0(8), trunk("all")));
		const gone = run(set, { type: "cmd/switch-remove", switch: lan, cause: "bar" });
		expect(gone.portVlans).toEqual([]);
		const effects = effectsOf(set, { type: "cmd/switch-remove", switch: lan, cause: "bar" });
		expect(effects.filter((e) => e.type === "port/vlan")).toEqual([reset(port0(8))]);
	});
});

describe("a saved lab", () => {
	const reloaded = (s: LabState) => restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));

	test("has each port's VLAN as it was, and tells the switches once its cables are in, before its machines boot", () => {
		const set = run(lab(), vlan(port0(1), access(10)), vlan(port0(8), trunk([10, 20], 20)));
		const { state, effects } = reloaded(set);
		expect(state.portVlans).toEqual(set.portVlans);
		const types = effects.map((e) => e.type);
		const vlans = effects.filter((e) => e.type === "port/vlan");
		expect(vlans).toEqual([
			{ type: "port/vlan", port: port0(1), vlan: access(10) },
			{ type: "port/vlan", port: port0(8), vlan: trunk([10, 20], 20) },
		]);
		expect(types.lastIndexOf("cable/attach")).toBeLessThan(types.indexOf("port/vlan"));
		expect(types.lastIndexOf("port/vlan")).toBeLessThan(types.indexOf("vm/boot"));
	});

	test("is refused whole when a port in it has a VLAN that is none", () => {
		const raw = JSON.parse(saveWorkspace(run(lab(), vlan(port0(1), access(10)))));
		for (const bad of [
			{ vlan: 0 },
			{ vlan: 4095 },
			{ trunk: { allowed: [1, 5000], native: 1 } },
			{ trunk: { allowed: "some", native: 1 } },
		]) {
			const saved = JSON.stringify({ ...raw, vlans: [{ port: port0(1), ...bad }] });
			expect(() => restoreWorkspace(initialState(IMAGES, WIDE), saved), JSON.stringify(bad)).toThrow();
		}
	});

	test("leaves out the VLAN of a port that a machine which failed held, as it holds none", () => {
		const raw = JSON.parse(saveWorkspace(run(lab(), vlan(port0(1), access(10)), hasFailed("node1"))));
		expect(raw.vlans).toEqual([]);
		const saved = JSON.stringify({ ...raw, vlans: [{ port: port0(1), vlan: 10 }] });
		expect(restoreWorkspace(initialState(IMAGES, WIDE), saved).state.portVlans).toEqual([]);
	});
});
