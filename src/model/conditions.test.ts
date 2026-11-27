import { describe, expect, test } from "vitest";
import { conditions } from "../../test/support/conditions.ts";
import { port0 } from "../../test/support/ports.ts";
import { cableAt, isCablePlanError, planCable } from "./cables.ts";
import {
	conditionsAt,
	conditionsOf,
	conditionWords,
	parseCondition,
	withConditions,
	writtenConditions,
} from "./conditions.ts";
import { plugsOf } from "./machines.ts";
import {
	bootEvent,
	effectsOf,
	hasFailed,
	hasStopped,
	IMAGES,
	isReady,
	labWith,
	linkEvent,
	plugEvent,
	remove,
	run,
	switchNamed,
	WIDE,
	withSwitches,
} from "./testkit.ts";
import {
	type CommandEvent,
	type ConditionPart,
	type Conditions,
	type LabState,
	NO_CONDITIONS,
	type PortRef,
} from "./types.ts";
import { initialState } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

const lan = switchNamed("lan");
const set = (port: PortRef, to: Conditions): CommandEvent => ({
	type: "cmd/conditions",
	changes: [{ port, conditions: to }],
});
const told = (port: PortRef, to: Conditions) => ({ type: "port/conditions", port, conditions: to });
const BAD = conditions({ delay: 100, loss: 20 });
const SLOW = conditions({ rate: 1_000_000, mtu: 1400 });

/** node1 and node2 ready on ports 1 and 2 of switch0, and a cable from its port 8 to port 1 of lan. */
function lab(): LabState {
	const ready = run(withSwitches(labWith(2), lan), isReady("node1"), isReady("node2"));
	const plan = planCable(ready, { switch: "switch0", port: 8 }, { switch: lan, port: 1 });
	if (isCablePlanError(plan)) throw new Error(plan.kind);
	return run(ready, { type: "cmd/cable", plan, cause: "bar" });
}

describe("a condition", () => {
	const read = (part: ConditionPart, texts: readonly string[]) => texts.map((text) => parseCondition(part, text));

	test("is read as a person writes it: a delay in ms or s, a share in percent, a rate in bits a second, an MTU in bytes", () => {
		expect(read("delay", ["100", "100ms", "1s", "1.5s", "0", "10000ms"])).toEqual([100, 100, 1000, 1500, 0, 10_000]);
		expect(read("loss", ["20", "20%", "0.5%", "100%", "0"])).toEqual([20, 20, 0.5, 100, 0]);
		expect(read("reorder", ["25%"])).toEqual([25]);
		expect(read("rate", ["1mbit", "1Mbit/s", "500kbit", "1.5mbit", "64000bit", "1gbit", "0"])).toEqual([
			1_000_000, 1_000_000, 500_000, 1_500_000, 64_000, 1_000_000_000, 0,
		]);
		expect(read("mtu", ["1400", "68", "1500"])).toEqual([1400, 68, 1500]);
	});

	test("is not read when it is out of its range, or is no such value", () => {
		expect(read("delay", ["0.5ms", "10001", "-1", "fast", "1m", ""])).toEqual([null, null, null, null, null, null]);
		expect(read("loss", ["101", "-5%", "half", "20 %"])).toEqual([null, null, null, null]);
		expect(read("rate", ["1", "999bit", "1mb", "11gbit", "1 mbit"])).toEqual([null, null, null, null, null]);
		expect(read("mtu", ["67", "1501", "9000", "1400.5"])).toEqual([null, null, null, null]);
	});

	test("is said in words, and written as a command takes it back", () => {
		const all = conditions({ delay: 100, loss: 0.5, reorder: 25, rate: 1_500_000, mtu: 1400 });
		expect(conditionWords(all)).toEqual(["delay 100 ms", "loss 0.5%", "reorder 25%", "rate 1.5 Mbit/s", "mtu 1400"]);
		expect(writtenConditions(all)).toEqual({
			delay: "100ms",
			loss: "0.5%",
			reorder: "25%",
			rate: "1500kbit",
			mtu: "1400",
		});
		for (const [part, text] of Object.entries(writtenConditions(all))) {
			expect(parseCondition(part as ConditionPart, text), part).toBe(all[part as ConditionPart]);
		}
		expect(conditionWords(conditions({ rate: 64_000 }))).toEqual(["rate 64 kbit/s"]);
		expect([conditionWords(NO_CONDITIONS), writtenConditions(NO_CONDITIONS)]).toEqual([[], {}]);
	});
});

describe("a cable's conditions", () => {
	test("are made of parts in their ranges, without those that do nothing", () => {
		expect(conditionsOf({ delay: 0, loss: 0, reorder: 0, rate: 0, mtu: 1500 })).toEqual({});
		expect(conditionsOf({ delay: 100, mtu: 1500 })).toEqual({ delay: 100 });
		expect(conditionsOf({ loss: 101 })).toEqual({ kind: "out-of-range", part: "loss" });
		expect(conditionsOf({ delay: 1.5 })).toEqual({ kind: "out-of-range", part: "delay" });
		expect(conditionsOf({ mtu: 67 })).toEqual({ kind: "out-of-range", part: "mtu" });
		expect(conditionsOf({ rate: 999 })).toEqual({ kind: "out-of-range", part: "rate" });
	});

	test("have reordering only with a delay, which is what the reordered frames skip", () => {
		expect(conditionsOf({ reorder: 25 })).toEqual({ kind: "reorder-needs-delay" });
		expect(conditionsOf({ reorder: 25, delay: 10 })).toEqual({ reorder: 25, delay: 10 });
		expect(withConditions(conditions({ reorder: 25, delay: 10 }), { delay: 0 })).toEqual({
			kind: "reorder-needs-delay",
		});
	});

	test("take the parts that a command gives and keep the others, and a part given as nothing is taken away", () => {
		expect(withConditions(BAD, { loss: 5, mtu: 1400 })).toEqual({ delay: 100, loss: 5, mtu: 1400 });
		expect(withConditions(BAD, { delay: 0 })).toEqual({ loss: 20 });
		expect(withConditions(SLOW, { rate: 0, mtu: 1500 })).toEqual({});
	});

	test("are none for a new cable, and are set on a NIC's cable or one between switches by a port that it is in, which the switches are told", () => {
		const s = lab();
		expect([conditionsAt(s, port0(1)), conditionsAt(s, port0(8)), conditionsAt(s, port0(5))]).toEqual([{}, {}, {}]);
		expect(effectsOf(s, set(port0(1), BAD))).toEqual([told(port0(1), BAD)]);
		// One between switches is told at both its ports, whichever of them named it.
		expect(effectsOf(s, set({ switch: lan, port: 1 }, SLOW))).toEqual([
			told(port0(8), SLOW),
			told({ switch: lan, port: 1 }, SLOW),
		]);
		const both = run(s, set(port0(1), BAD), set(port0(8), SLOW));
		expect([conditionsAt(both, port0(1)), conditionsAt(both, port0(2))]).toEqual([BAD, {}]);
		expect([conditionsAt(both, port0(8)), conditionsAt(both, { switch: lan, port: 1 })]).toEqual([SLOW, SLOW]);
	});

	test("are not set on a port that nothing is in, and setting them as they are changes nothing", () => {
		const s = lab();
		expect(run(s, set(port0(5), BAD))).toBe(s);
		const bad = run(s, set(port0(1), BAD));
		expect(run(bad, set(port0(1), conditions({ loss: 20, delay: 100 })))).toBe(bad);
	});

	test("set to none leave the cable as a new one is", () => {
		const bad = run(lab(), set(port0(1), BAD), set(port0(8), SLOW));
		expect(effectsOf(bad, set(port0(1), NO_CONDITIONS))).toEqual([told(port0(1), NO_CONDITIONS)]);
		const clear = run(bad, set(port0(1), NO_CONDITIONS), set(port0(8), NO_CONDITIONS));
		expect(plugsOf(clear.machines.node1?.life as never)).toEqual([{ kind: "port", port: port0(1), link: "up" }]);
		expect(clear.switchCables).toEqual(lab().switchCables);
	});

	test("stay while the cable is cut and reconnected, and while its machine is off, reboots, or boots again", () => {
		const bad = run(lab(), set(port0(1), BAD), set(port0(8), SLOW));
		const cut = run(bad, linkEvent(bad, false, "node1"), {
			type: "cmd/cable-link",
			changes: [{ port: port0(8), up: false }],
			cause: "bar",
		});
		expect([conditionsAt(cut, port0(1)), conditionsAt(cut, port0(8))]).toEqual([BAD, SLOW]);
		expect(effectsOf(bad, linkEvent(bad, false, "node1")).some((e) => e.type === "port/conditions")).toBe(false);
		const back = run(cut, linkEvent(cut, true, "node1"), {
			type: "cmd/cable-link",
			changes: [{ port: port0(8), up: true }],
			cause: "bar",
		});
		expect([conditionsAt(back, port0(1)), conditionsAt(back, port0(8))]).toEqual([BAD, SLOW]);
		const off = run(bad, { type: "cmd/power", machines: ["node1"], next: "off" }, hasStopped("node1"));
		expect(conditionsAt(off, port0(1))).toEqual(BAD);
		const on = run(off, bootEvent(off, "node1"), isReady("node1", 2));
		expect([on.machines.node1?.life.phase, conditionsAt(on, port0(1))]).toEqual(["ready", BAD]);
	});

	test("go with a NIC's cable where it is moved, and the port it leaves is as a new one", () => {
		const bad = run(lab(), set(port0(1), BAD));
		const move = plugEvent(bad, { machine: "node1", nic: 0 }, { switch: lan, port: 4 });
		const moved = run(bad, move);
		expect([conditionsAt(moved, { switch: lan, port: 4 }), conditionsAt(moved, port0(1))]).toEqual([BAD, {}]);
		const effects = effectsOf(bad, move);
		expect(effects.filter((e) => e.type === "port/conditions")).toEqual([
			told(port0(1), NO_CONDITIONS),
			told({ switch: lan, port: 4 }, BAD),
		]);
		const types = effects.map((e) => e.type);
		expect(types.indexOf("port/detach")).toBeLessThan(types.indexOf("port/conditions"));
	});

	test("are gone with the cable: unplugged, uncabled, removed with its machine, or lost when its machine fails", () => {
		const bad = run(lab(), set(port0(1), BAD), set(port0(8), SLOW));
		const far = { switch: lan, port: 1 } as const;
		const ways: [string, (s: LabState) => LabState, readonly PortRef[]][] = [
			["unplug", (s) => run(s, plugEvent(s, { machine: "node1", nic: 0 }, null)), [port0(1)]],
			["uncable", (s) => run(s, { type: "cmd/uncable", port: port0(8), cause: "bar" }), [port0(8), far]],
			["rm", (s) => run(s, remove("node1"), hasStopped("node1")), [port0(1)]],
			["a failure", (s) => run(s, hasFailed("node1")), [port0(1)]],
		];
		for (const [way, change, freed] of ways) {
			const after = change(bad);
			for (const port of freed) expect(conditionsAt(after, port), way).toEqual({});
		}
		// What is plugged into the port next has a new cable, and the switch has been told so.
		const unplug = plugEvent(bad, { machine: "node1", nic: 0 }, null);
		expect(effectsOf(bad, unplug).at(-1)).toEqual(told(port0(1), NO_CONDITIONS));
		const again = run(bad, unplug);
		const plugged = run(again, plugEvent(again, { machine: "node1", nic: 0 }, { switch: "switch0", port: 1 }));
		expect(conditionsAt(plugged, port0(1))).toEqual({});
		const failed = run(bad, hasFailed("node1"));
		const booted = run(failed, bootEvent(failed, "node1"), isReady("node1", 2));
		expect(conditionsAt(booted, port0(1))).toEqual({});
	});

	test("go with a switch that is removed, which the fabric needs not be told", () => {
		const slow = run(lab(), set(port0(8), SLOW));
		const effects = effectsOf(slow, { type: "cmd/switch-remove", switch: lan, cause: "bar" });
		expect(effects.filter((e) => e.type === "port/conditions")).toEqual([told(port0(8), NO_CONDITIONS)]);
	});
});

describe("a saved lab", () => {
	const reloaded = (s: LabState) => restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));

	test("has each cable's conditions as they were, and tells the switches before its machines boot", () => {
		const bad = run(lab(), set(port0(1), BAD), set(port0(8), SLOW));
		const saved = JSON.parse(saveWorkspace(bad));
		expect(saved.version).toBe(12);
		expect(saved.nodes[0].nics[0].conditions).toEqual({ delay: 100, loss: 20 });
		expect(saved.nodes[1].nics[0].conditions).toEqual({});
		expect(saved.cables[0].conditions).toEqual({ rate: 1_000_000, mtu: 1400 });
		const { state, effects } = reloaded(bad);
		expect([conditionsAt(state, port0(1)), conditionsAt(state, port0(2))]).toEqual([BAD, {}]);
		expect(cableAt(state, port0(8))).toEqual(cableAt(bad, port0(8)));
		expect(effects.filter((e) => e.type === "port/conditions")).toEqual([
			told(port0(1), BAD),
			told(port0(8), SLOW),
			told({ switch: lan, port: 1 }, SLOW),
		]);
		const types = effects.map((e) => e.type);
		expect(types.lastIndexOf("port/conditions")).toBeLessThan(types.indexOf("vm/boot"));
	});

	test("is refused whole when a cable in it has conditions that none can have", () => {
		const raw = JSON.parse(saveWorkspace(run(lab(), set(port0(8), SLOW))));
		for (const bad of [{ loss: 101 }, { delay: "100ms" }, { reorder: 25 }, { speed: 1 }, { mtu: 9000 }, null, 5]) {
			const cables = [{ ...raw.cables[0], conditions: bad }];
			const text = JSON.stringify(bad);
			expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify({ ...raw, cables })), text).toThrow();
			const nodes = [{ ...raw.nodes[0], nics: [{ ...raw.nodes[0].nics[0], conditions: bad }] }, raw.nodes[1]];
			expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify({ ...raw, nodes })), text).toThrow();
		}
	});
});
