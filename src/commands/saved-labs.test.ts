import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	createStore,
	heldPorts,
	initialState,
	machineList,
	portsOf,
	restoreWorkspace,
	saveWorkspace,
	selectNames,
} from "../model/index.ts";
import { compileFilter, type NameBook, nodeMac } from "../net/index.ts";
import { createRegistry, isLineError, parseLine, VERBS } from "./index.ts";
import { IMAGES, NO_EXEC, NO_FILES } from "./testing/lab.ts";
import type { ListedMachine } from "./verbs/index.ts";

/** A lab as the code that wrote that version saved it. `.audit/phase2/save-labs.mjs` makes them. */
const savedBy = (version: number): string =>
	readFileSync(new URL(`../../test/fixtures/saved-labs/version-${version}.json`, import.meta.url), "utf8");

async function open(saved: string) {
	const restored = restoreWorkspace(initialState(IMAGES, { width: 1300, height: 500 }), saved);
	const store = createStore(restored.state, () => {});
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: (event) => store.dispatchCommand(event),
			until: store.until,
			now: () => 0,
			carried: () => undefined,
			exec: NO_EXEC,
			files: NO_FILES,
		},
		VERBS,
	);
	const booted = restored.effects.flatMap((e) => (e.type === "vm/boot" ? [e.machine] : []));
	for (const machine of booted) store.dispatchRuntime({ type: "vm/ready", machine, attempt: 1, bootMs: 10 });
	const ls = parseLine(registry, "ls", store.state);
	if (isLineError(ls) || ls.danger) throw new Error("ls should parse and be safe");
	const result = await ls.run({ source: "bar", signal: new AbortController().signal });
	if (result.kind !== "report") throw new Error("ls reports");
	return {
		state: store.state,
		booted,
		/** `eth0 10.88.0.11/24 up on port 1` for each NIC of each machine. */
		cables: (result.data as ListedMachine[]).map(({ name, nics }) => [
			name,
			...nics.map((nic) => {
				const address = nic.address === null ? "no address" : `${nic.address}/${nic.prefix}`;
				return `${nic.name} ${address} ${nic.port === null ? nic.link : `${nic.link} on port ${nic.port}`}`;
			}),
		]),
	};
}

const FIRST = [
	["node1", "eth0 10.88.0.11/24 up on port 1"],
	["node3", "eth0 10.88.0.13/24 up on port 3"],
];
const OFF = [FIRST[0], ["node3", "eth0 10.88.0.13/24 off on port 3"]];
const cut = (name: string) => [name, "eth0 10.88.0.14/24 cut on port 2"];
const router = (eth0: string, eth2: string) => [
	"node5",
	`eth0 ${eth0} up on port 4`,
	"eth1 no address unplugged",
	`eth2 ${eth2} cut on port 5`,
];
const ROUTER = router("10.1.0.1/24", "10.2.0.1/24");
const LOOSE = ["node6", "eth0 10.88.0.16/24 unplugged"];

describe("a lab saved by an earlier version", () => {
	test.each([
		[1, [...FIRST, cut("node4"), ["node5", "eth0 10.88.0.15/24 unplugged"]]],
		[2, [...FIRST, cut("node4"), router("10.88.0.15/24", "no address"), LOOSE]],
		[3, [...FIRST, cut("node4"), ROUTER, LOOSE]],
		[4, [...FIRST, cut("switch1"), ROUTER, LOOSE]],
		[5, [...OFF, cut("switch1"), ROUTER, LOOSE]],
		[6, [...OFF, cut("switch1"), ROUTER, LOOSE]],
	])(
		"version %i opens as one switch0, with its machines, ports, cuts and names as they were",
		async (version, cables) => {
			const { state, booted, cables: opened } = await open(savedBy(version));
			expect(opened).toEqual(cables);
			expect(state.switches).toEqual(["switch0"]);
			expect(new Set(machineList(state).flatMap(({ life }) => portsOf(life).map((port) => port.switch)))).toEqual(
				new Set(["switch0"]),
			);
			expect(booted).toEqual(state.rail.filter((name) => version < 5 || name !== "node3"));
			expect(state.panes.parked).toEqual({ node3: "user" });
			expect(state.agent.policies.link_set).toBe("ask");

			const again = await open(saveWorkspace(state));
			expect(again.cables).toEqual(cables);
			expect(again.booted).toEqual(booted);
		},
	);
});

describe("a lab saved before there were cables between switches", () => {
	test("version 7 opens with its switches and what was plugged into each, and has no such cable", async () => {
		const { state, cables, booted } = await open(savedBy(7));
		expect(state.switches).toEqual(["switch0", "lan", "wan"]);
		expect(state.shownSwitch).toBe("lan");
		expect(state.switchCables).toEqual([]);
		expect(cables).toEqual([
			["node1", "eth0 10.88.0.11/24 up on port 3"],
			OFF[1],
			cut("switch1"),
			["node5", "eth0 10.1.0.1/24 up on port 4", "eth1 no address up on port 1", "eth2 10.2.0.1/24 cut on port 5"],
			LOOSE,
		]);
		const on = (name: string) => machineList(state).find((machine) => machine.name === name)?.life;
		expect(portsOf(on("node1") as never)).toEqual([{ switch: "lan", port: 3 }]);
		expect(portsOf(on("node5") as never).map((port) => port.switch)).toEqual(["switch0", "wan", "switch0"]);

		const saved = JSON.parse(saveWorkspace(state));
		expect(saved).toMatchObject({ version: 11, switches: ["switch0", "lan", "wan"], cables: [], vlans: [], stp: [] });
		const again = await open(JSON.stringify(saved));
		expect([again.cables, again.booted]).toEqual([cables, booted]);
	});
});

describe("a lab saved before vlan was a word in the capture filter", () => {
	const named = (was: string) => savedBy(8).replaceAll(`"${was}"`, '"vlan"');

	test("version 8 opens with a switch called vlan, which a filter names by that word alone", async () => {
		const { state } = await open(named("wan"));
		expect(state.switches).toEqual(["switch0", "lan", "vlan"]);
		const names = selectNames(state);
		expect(compiled("vlan", names)).toEqual({ kind: "place", switch: "vlan", port: null });
		expect(compiled("vlan:8", names)).toEqual({ kind: "place", switch: "vlan", port: 8 });
		expect(compiled("vlan 10", names)).toEqual({ kind: "everywhere" });
		const again = await open(saveWorkspace(state));
		expect(again.state.switches).toEqual(state.switches);
	});

	test("version 8 opens with a machine called vlan, which a filter names by that word alone", async () => {
		const { state, cables } = await open(named("switch1"));
		expect(cables[2]).toEqual(cut("vlan"));
		const names = selectNames(state);
		const of = (source: string, n: number) => {
			const r = compileFilter(source, names);
			if (!r.ok) throw new Error(r.error.message);
			const bytes = new Uint8Array(42);
			bytes.set(nodeMac(n), 6);
			return r.filter.matchesFrame({ switch: "switch0", from: 2, to: 0, bytes, names });
		};
		expect([of("vlan", 4), of("vlan", 1), of("vlan vlan 1", 4), of("vlan vlan 10", 4)]).toEqual([
			true,
			false,
			true,
			false,
		]);
	});
});

/** The filter's scope, or why it does not compile. */
function compiled(source: string, names: NameBook) {
	const r = compileFilter(source, names);
	return r.ok ? r.filter.scope : r.error.message;
}

describe("a lab saved before ports had VLANs", () => {
	test("version 8 opens with its cables between switches, cut or not, and every port in VLAN 1", async () => {
		const { state, booted } = await open(savedBy(8));
		expect(state.switchCables).toEqual([
			{
				ends: [
					{ switch: "switch0", port: 8 },
					{ switch: "lan", port: 7 },
				],
				link: "up",
			},
			{
				ends: [
					{ switch: "lan", port: 8 },
					{ switch: "wan", port: 8 },
				],
				link: "cut",
			},
		]);
		expect(state.portVlans).toEqual([]);
		const saved = JSON.parse(saveWorkspace(state));
		expect(saved).toMatchObject({ version: 11, vlans: [] });
		const again = await open(JSON.stringify(saved));
		expect([again.state.switchCables, again.booted]).toEqual([state.switchCables, booted]);
	});
});

describe("a lab saved before cables had conditions", () => {
	test("version 9 opens with its VLANs and trunks as they were, and no cable has conditions", async () => {
		const { state, booted } = await open(savedBy(9));
		expect(state.portVlans).toEqual([
			{ port: { switch: "lan", port: 3 }, vlan: { mode: "access", vlan: 10 } },
			{ port: { switch: "switch0", port: 8 }, vlan: { mode: "trunk", allowed: [10, 20], native: 1 } },
			{ port: { switch: "lan", port: 7 }, vlan: { mode: "trunk", allowed: [10, 20], native: 1 } },
		]);
		const held = state.switches.flatMap((on) => heldPorts(state, on));
		expect(held).toHaveLength(10);
		expect(held.map(({ conditions }) => conditions)).toEqual(held.map(() => ({})));
		const saved = JSON.parse(saveWorkspace(state));
		expect(saved.version).toBe(11);
		expect(saved.cables.map((cable: { conditions: unknown }) => cable.conditions)).toEqual([{}, {}]);
		const nics = saved.nodes.flatMap((node: { nics: { conditions: unknown }[] }) => node.nics);
		expect(nics.map((nic: { conditions: unknown }) => nic.conditions)).toEqual(nics.map(() => ({})));
		const again = await open(JSON.stringify(saved));
		expect([again.state.switchCables, again.state.portVlans, again.booted]).toEqual([
			state.switchCables,
			state.portVlans,
			booted,
		]);
	});
});

describe("a lab saved before switches could take part in a spanning tree", () => {
	test("version 10 opens with its cables' conditions as they were, and no switch takes part", async () => {
		const { state, booted } = await open(savedBy(10));
		expect(state.stp).toEqual([]);
		expect(state.switchCables[0]).toMatchObject({ link: "up", conditions: { delay: 100, loss: 20 } });
		const impaired = state.switches.flatMap((on) =>
			heldPorts(state, on).flatMap((held) => (Object.keys(held.conditions).length > 0 ? [`${on}:${held.port}`] : [])),
		);
		expect(impaired).toEqual(["switch0:8", "lan:3", "lan:7"]);
		expect(state.portVlans).toHaveLength(3);
		const saved = JSON.parse(saveWorkspace(state));
		expect(saved).toMatchObject({ version: 11, stp: [] });
		const again = await open(JSON.stringify(saved));
		expect([again.state.switchCables, again.state.stp, again.booted]).toEqual([state.switchCables, [], booted]);
	});
});
