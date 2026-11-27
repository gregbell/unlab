import { describe, expect, test } from "vitest";
import { port0 } from "../../test/support/ports.ts";
import { BLOCKED, stpOn, treePortAt, treeWord } from "./stp.ts";
import { effectsOf, IMAGES, isReady, labWith, run, switchNamed, WIDE, withSwitches } from "./testkit.ts";
import type { CommandEvent, LabEvent, LabState, SwitchName, Tree } from "./types.ts";
import { initialState } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

const lan = switchNamed("lan");
const wan = switchNamed("wan");
const stp = (on: boolean, ...switches: SwitchName[]): CommandEvent => ({ type: "cmd/stp", switches, on });
const told = (on: SwitchName, on_ = true) => ({ type: "switch/stp", switch: on, on: on_ });

/** node1 ready on port 1 of switch0, with lan and wan beside it and a cable from switch0 port 8 to lan port 7. */
function lab(): LabState {
	const ends = [port0(8), { switch: lan, port: 7 }] as const;
	return run(withSwitches(labWith(1), lan, wan), isReady("node1"), { type: "cmd/cable", plan: { ends }, cause: "bar" });
}

const bridge = (last: number) => ({ priority: 32768, address: `02:00:00:00:00:0${last}` });
/** switch0 as the second of two bridges would have it: its machine's port in use, and its cable's port kept out of it. */
const reading: Tree = {
	bridge: bridge(2),
	root: bridge(1),
	cost: 20_000,
	ports: [
		{ port: 1, role: "designated", state: "forwarding" },
		{ port: 8, role: "alternate", state: "discarding" },
	],
};
const says = (on: SwitchName, tree: Tree = reading): LabEvent => ({ type: "switch/tree", switch: on, tree });

describe("spanning tree", () => {
	test("is off on a new switch, and is turned on and off for each switch by itself, which the runtime is told", () => {
		const off = lab();
		expect([off.stp, off.trees]).toEqual([[], {}]);
		expect(off.switches.map((on) => stpOn(off, on))).toEqual([false, false, false]);

		expect(effectsOf(off, stp(true, wan, "switch0"))).toEqual([told("switch0"), told(wan)]);
		const on = run(off, stp(true, wan, "switch0"));
		// In the order of the lab's switches, however they were named.
		expect(on.stp).toEqual(["switch0", "wan"]);
		expect(on.switches.map((name) => stpOn(on, name))).toEqual([true, false, true]);

		expect(effectsOf(on, stp(false, "switch0"))).toEqual([told("switch0", false)]);
		expect(run(on, stp(false, "switch0")).stp).toEqual(["wan"]);
	});

	test("changes nothing for a switch that is already so, or that is not there", () => {
		const on = run(lab(), stp(true, lan));
		for (const event of [stp(true, lan), stp(false, wan), stp(true, switchNamed("dmz"))]) {
			expect(run(on, event)).toBe(on);
			expect(effectsOf(on, event)).toEqual([]);
		}
	});

	test("goes with a switch that is removed, so a switch that is added under its name takes no part", () => {
		const on = run(lab(), stp(true, lan, wan), says(lan));
		const gone = run(on, { type: "cmd/switch-remove", switch: lan, cause: "bar" });
		expect([gone.stp, gone.trees]).toEqual([["wan"], {}]);
		// The switch is gone from the runtime with its tree, so nothing more is said of it.
		const effects = effectsOf(on, { type: "cmd/switch-remove", switch: lan, cause: "bar" });
		expect(effects.filter((e) => e.type === "switch/stp")).toEqual([]);

		const back = run(gone, { type: "cmd/switch-add", plan: { name: lan } });
		expect([back.stp, stpOn(back, lan)]).toEqual([["wan"], false]);
		expect(effectsOf(back, stp(true, lan))).toEqual([told(lan)]);
	});
});

describe("a switch's part in the tree", () => {
	test("is what the runtime last said of a switch that takes part, and is gone when the switch stops", () => {
		const on = run(lab(), stp(true, "switch0"));
		expect(on.trees).toEqual({});
		const read = run(on, says("switch0"));
		expect(read.trees).toEqual({ switch0: reading });
		expect(treePortAt(read, port0(8))).toEqual({ port: 8, role: "alternate", state: "discarding" });
		expect([treePortAt(read, port0(2)), treePortAt(read, { switch: lan, port: 7 })]).toEqual([undefined, undefined]);

		// The same again is no change, so nothing that shows it is drawn again.
		expect(run(read, says("switch0", structuredClone(reading)))).toBe(read);
		const forwarding = { ...reading, ports: [reading.ports[0], { ...reading.ports[1], state: "forwarding" as const }] };
		expect(run(read, says("switch0", forwarding)).trees.switch0?.ports[1].state).toBe("forwarding");

		expect(run(read, stp(false, "switch0")).trees).toEqual({});
	});

	test("is not kept of a switch that takes none, or that is not there", () => {
		const off = lab();
		expect(run(off, says("switch0"))).toBe(off);
		expect(run(off, says(switchNamed("dmz")))).toBe(off);
		// A reading that was on its way when the switch stopped.
		const stopped = run(off, stp(true, lan), stp(false, lan));
		expect(run(stopped, says(lan))).toBe(stopped);
	});

	test("has a word for a port that carries nothing, and for one on its way into use", () => {
		expect(BLOCKED).toBe("blocked");
		expect((["discarding", "learning", "forwarding"] as const).map((state) => treeWord({ state }))).toEqual([
			"blocked",
			"learning",
			null,
		]);
		expect(treeWord(undefined)).toBeNull();
	});
});

describe("a saved lab", () => {
	test("has the switches that take part, and tells the runtime before their cables are in", () => {
		const on = run(lab(), stp(true, "switch0", lan), says("switch0"));
		const saved = saveWorkspace(on);
		expect(JSON.parse(saved)).toMatchObject({ version: 11, stp: ["switch0", "lan"] });
		const { state, effects } = restoreWorkspace(initialState(IMAGES, WIDE), saved);
		expect(state.stp).toEqual(["switch0", "lan"]);
		// What each is in the tree is worked out again.
		expect(state.trees).toEqual({});
		const types = effects.map((e) => e.type);
		expect(effects.filter((e) => e.type === "switch/stp")).toEqual([told("switch0"), told(lan)]);
		expect(types.lastIndexOf("switch/stp")).toBeLessThan(types.indexOf("cable/attach"));
		expect(types.lastIndexOf("switch/stp")).toBeLessThan(types.indexOf("vm/boot"));
	});

	test("is refused whole when it names a switch that is not there, or one twice", () => {
		const raw = JSON.parse(saveWorkspace(run(lab(), stp(true, lan))));
		for (const bad of [["dmz"], ["lan", "lan"], "lan", [7], undefined]) {
			const saved = JSON.stringify({ ...raw, stp: bad });
			expect(() => restoreWorkspace(initialState(IMAGES, WIDE), saved), JSON.stringify(bad)).toThrow();
		}
	});
});
