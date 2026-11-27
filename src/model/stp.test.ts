import { describe, expect, test } from "vitest";
import { port0 } from "../../test/support/ports.ts";
import {
	BLOCKED,
	bridgeText,
	costOf,
	parseCost,
	parsePriority,
	priorityOf,
	rootOf,
	stpOn,
	treePortAt,
	treeRoleText,
	treeWord,
} from "./stp.ts";
import { effectsOf, IMAGES, isReady, labWith, run, switchNamed, WIDE, withSwitches } from "./testkit.ts";
import type {
	BridgePriority,
	CommandEvent,
	LabEvent,
	LabState,
	PathCost,
	PortNo,
	PortRef,
	SwitchName,
	Tree,
} from "./types.ts";
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
		expect(JSON.parse(saved)).toMatchObject({ version: 12, stp: ["switch0", "lan"] });
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

describe("steering the tree", () => {
	const priority = (value: number, ...switches: SwitchName[]): CommandEvent => ({
		type: "cmd/priority",
		switches,
		priority: value as BridgePriority,
	});
	const cost = (port: PortRef, value: number): CommandEvent => ({ type: "cmd/cost", port, cost: value as PathCost });
	const lan7 = { switch: lan, port: 7 as PortNo };

	test("reads a priority only as a step of 4096 from 0 to 61440, and a cost only as a whole number from 1 to 200,000,000", () => {
		expect(["0", "4096", "32768", "61440"].map(parsePriority)).toEqual([0, 4096, 32768, 61440]);
		expect(["4097", "65536", "-4096", "", "4096.0", "1e4", "0x1000", " 4096"].map(parsePriority)).toEqual(
			Array(8).fill(null),
		);
		expect(["1", "20000", "200000000"].map(parseCost)).toEqual([1, 20_000, 200_000_000]);
		expect(["0", "200000001", "-1", "", "2.5", "1e3", "07"].map(parseCost)).toEqual(Array(7).fill(null));
	});

	test("sets a priority for each switch that is there, whether or not it takes part, and tells the runtime of each that changed", () => {
		const off = lab();
		expect(off.switches.map((on) => priorityOf(off, on))).toEqual([32768, 32768, 32768]);
		expect(effectsOf(off, priority(4096, lan, wan))).toEqual([
			{ type: "switch/priority", switch: lan, priority: 4096 },
			{ type: "switch/priority", switch: wan, priority: 4096 },
		]);
		const set = run(off, priority(4096, lan, wan));
		expect(set.priorities).toEqual({ lan: 4096, wan: 4096 });
		expect(run(set, priority(4096, lan))).toBe(set);
		expect(effectsOf(set, priority(4096, lan, "switch0"))).toEqual([
			{ type: "switch/priority", switch: "switch0", priority: 4096 },
		]);
		// 32768 is where every switch starts, so it is kept as no setting.
		const back = run(set, priority(32768, lan));
		expect(back.priorities).toEqual({ wan: 4096 });
		expect(effectsOf(set, priority(32768, lan))).toEqual([{ type: "switch/priority", switch: lan, priority: 32768 }]);
		expect(run(off, priority(4096, switchNamed("dmz")))).toBe(off);
	});

	test("sets a cost for a port that something is in, which goes back to 20000 once nothing is", () => {
		const off = lab();
		expect(costOf(off, lan7)).toBe(20_000);
		expect(effectsOf(off, cost(lan7, 40_000))).toEqual([{ type: "port/cost", port: lan7, cost: 40_000 }]);
		const set = run(off, cost(lan7, 40_000));
		expect(set.portCosts).toEqual([{ port: lan7, cost: 40_000 }]);
		expect(costOf(set, lan7)).toBe(40_000);
		expect(costOf(set, port0(8))).toBe(20_000);
		expect(run(set, cost(lan7, 40_000))).toBe(set);
		// A free port takes none.
		expect(run(off, cost({ switch: lan, port: 3 as PortNo }, 40_000))).toBe(off);

		const freed = { type: "cmd/uncable", port: lan7, cause: "bar" } as const;
		expect(run(set, freed).portCosts).toEqual([]);
		expect(effectsOf(set, freed).filter((e) => e.type === "port/cost")).toEqual([
			{ type: "port/cost", port: lan7, cost: 20_000 },
		]);
		expect(run(set, cost(lan7, 20_000)).portCosts).toEqual([]);
	});

	test("goes with a switch that is removed, so a switch that is added under its name starts as any other", () => {
		const set = run(lab(), priority(4096, lan), cost(lan7, 40_000), cost(port0(1), 2000));
		const remove = { type: "cmd/switch-remove", switch: lan, cause: "bar" } as const;
		const gone = run(set, remove);
		expect([gone.priorities, gone.portCosts]).toEqual([{}, [{ port: port0(1), cost: 2000 }]]);
		// The runtime has no switch to tell.
		expect(effectsOf(set, remove).filter((e) => e.type === "switch/priority" || e.type === "port/cost")).toEqual([]);
		const back = run(gone, { type: "cmd/switch-add", plan: { name: lan } });
		expect(priorityOf(back, lan)).toBe(32768);
	});

	test("names the switch that a tree takes for its root, once that switch has said what it is", () => {
		const on = run(lab(), stp(true, "switch0", lan));
		const lanReading: Tree = { bridge: bridge(1), root: bridge(1), cost: 0, ports: [] };
		expect(rootOf(run(on, says("switch0")), "switch0")).toBeNull();
		const both = run(on, says("switch0"), says(lan, lanReading));
		expect([rootOf(both, "switch0"), rootOf(both, lan), rootOf(both, wan)]).toEqual([lan, lan, null]);
		expect(bridgeText(reading.bridge)).toBe("32768.02:00:00:00:00:02");
	});

	test("says what a port is in the tree in words: its role, and its state where it does not carry", () => {
		expect(
			(
				[
					["root", "forwarding"],
					["designated", "forwarding"],
					["designated", "learning"],
					["alternate", "discarding"],
					["backup", "discarding"],
				] as const
			).map(([role, state]) => treeRoleText({ role, state })),
		).toEqual([
			"root port",
			"designated port",
			"designated port · learning",
			"alternate port · blocked",
			"backup port · blocked",
		]);
		expect(treeRoleText(undefined)).toBeNull();
	});
});

describe("a saved lab's priorities and costs", () => {
	test("come back, and the runtime is told of them before any switch takes part", () => {
		const set = run(
			lab(),
			stp(true, "switch0", lan),
			{ type: "cmd/priority", switches: [lan], priority: 4096 as BridgePriority },
			{ type: "cmd/cost", port: { switch: lan, port: 7 as PortNo }, cost: 40_000 as PathCost },
		);
		const saved = saveWorkspace(set);
		expect(JSON.parse(saved)).toMatchObject({
			version: 12,
			priorities: { lan: 4096 },
			costs: [{ port: { switch: "lan", port: 7 }, cost: 40_000 }],
		});
		const { state, effects } = restoreWorkspace(initialState(IMAGES, WIDE), saved);
		expect([state.priorities, state.portCosts]).toEqual([set.priorities, set.portCosts]);
		const types = effects.map((e) => e.type);
		expect(effects.filter((e) => e.type === "switch/priority" || e.type === "port/cost")).toEqual([
			{ type: "switch/priority", switch: lan, priority: 4096 },
			{ type: "port/cost", port: { switch: lan, port: 7 }, cost: 40_000 },
		]);
		expect(types.indexOf("port/cost")).toBeLessThan(types.indexOf("switch/stp"));
	});

	test("are refused whole when a value is out of its range, or names what is not there", () => {
		const raw = JSON.parse(saveWorkspace(run(lab(), stp(true, lan))));
		const lan7 = { switch: "lan", port: 7 };
		for (const priorities of [{ dmz: 4096 }, { lan: 4097 }, { lan: "4096" }, [4096], null]) {
			const saved = JSON.stringify({ ...raw, priorities });
			expect(() => restoreWorkspace(initialState(IMAGES, WIDE), saved), JSON.stringify(priorities)).toThrow();
		}
		for (const costs of [
			[{ port: lan7, cost: 0 }],
			[{ port: lan7, cost: 200_000_001 }],
			[{ port: { switch: "dmz", port: 7 }, cost: 2 }],
			[
				{ port: lan7, cost: 2 },
				{ port: lan7, cost: 3 },
			],
			{},
		]) {
			const saved = JSON.stringify({ ...raw, costs });
			expect(() => restoreWorkspace(initialState(IMAGES, WIDE), saved), JSON.stringify(costs)).toThrow();
		}
	});

	test("of a version before there were any start every switch and port where it starts", () => {
		const raw = JSON.parse(saveWorkspace(run(lab(), stp(true, lan))));
		const { priorities: _p, costs: _c, ...older } = raw;
		const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify({ ...older, version: 11 }));
		expect([state.priorities, state.portCosts, state.stp]).toEqual([{}, [], ["lan"]]);
	});
});
