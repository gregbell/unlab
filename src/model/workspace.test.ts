import { expect, test } from "vitest";
import { addressText } from "./selectors.ts";
import {
	address,
	emptyLab,
	hasStopped,
	IMAGES,
	isReady,
	labWith,
	linkEvent,
	machine,
	power,
	run,
	spawnEvent,
	WIDE,
} from "./testkit.ts";
import { initialState } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

test("the agent's policies and pause come back, and what the last browser made of the tools does not", () => {
	const s = run(
		labWith(1),
		{ type: "ui/policy", tool: "link_set", policy: "off" },
		{ type: "ui/tools-paused", paused: true },
	);
	expect(s.agent.webmcp).toEqual(emptyLab().agent.webmcp);
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(state.agent.policies.link_set).toBe("off");
	expect(state.agent.paused).toBe(true);
	expect(state.agent.webmcp).toEqual({ kind: "absent" });
});

test("each NIC comes back on its own port, cut or unplugged as it was", () => {
	let s = labWith(1);
	s = run(s, spawnEvent(s, 1, { net: ["switch0", "none", "switch0"] }), isReady("node2"));
	s = run(s, linkEvent(s, false, { machine: "node2", nic: 2 }));
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(machine(state, "node2")).toMatchObject({
		spec: { gateway: true, nics: [{ net: "switch0" }, { net: "none" }, { net: "switch0" }] },
		life: {
			phase: "booting",
			plugs: [{ kind: "port", port: 2, link: "up" }, { kind: "none" }, { kind: "port", port: 3, link: "cut" }],
		},
	});
	expect(machine(state, "node1").spec.nics).toEqual([{ net: "switch0", address: address("10.88.0.11/24") }]);
});

test("a machine that is off, or was stopping to be, comes back off with its cables; one that was rebooting boots", () => {
	let s = labWith(3);
	s = run(s, linkEvent(s, false, "node1"), power("off", "node1"), hasStopped("node1"));
	s = run(s, power("off", "node2"), power("reboot", "node3"));
	const { state, effects } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(state.rail.map((name) => machine(state, name).life)).toMatchObject([
		{ phase: "off", plugs: [{ kind: "port", port: 1, link: "cut" }] },
		{ phase: "off", plugs: [{ kind: "port", port: 2, link: "up" }] },
		{ phase: "booting", plugs: [{ kind: "port", port: 3, link: "up" }] },
	]);
	expect(effects.flatMap((e) => (e.type === "vm/boot" ? [e.machine] : []))).toEqual(["node3"]);
	expect(effects.flatMap((e) => (e.type === "port/attach" ? [e.port] : []))).toEqual([1, 2, 3]);
});

test("a machine comes back with the addresses and the gateway it was given", () => {
	let s = emptyLab();
	s = run(s, spawnEvent(s, 1, { net: ["switch0", "switch0"], addr: [null, "10.2.0.1/16"], gateway: false }));
	s = run(s, spawnEvent(s, 1, { net: "none", addr: ["192.168.7.9/30"], gateway: true }));
	const { state, effects } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	for (const name of s.rail) expect(machine(state, name).spec).toMatchObject(machine(s, name).spec);
	expect(effects.flatMap((e) => (e.type === "vm/boot" ? [e.config.spec] : []))).toMatchObject(
		s.rail.map((name) => machine(s, name).spec),
	);
});

/** As main wrote it before a machine could have more than one NIC. */
const VERSION_1 = {
	version: 1,
	nextN: 4,
	nodes: [
		{ n: 1, hue: 1, image: "alpine", memMiB: 256, diskGiB: "4", cpus: 2, net: "switch0", port: 1, cut: false },
		{ n: 2, hue: 2, image: "debian", memMiB: 512, diskGiB: "8", cpus: 1, net: "switch0", port: 3, cut: true },
		{ n: 3, hue: 3, image: "alpine", memMiB: 256, diskGiB: "4", cpus: 1, net: "none", port: null, cut: false },
	],
	dock: "open",
	order: ["node1", "node2", "node3"],
	parked: [],
	focus: "node1",
	policies: {},
	paused: false,
};

test("a lab saved before machines had several NICs restores with one each, on the ports they had", () => {
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(VERSION_1));
	expect(state.rail.map((name) => [name, machine(state, name).spec.nics, machine(state, name).life])).toMatchObject([
		["node1", [{ net: "switch0" }], { phase: "booting", plugs: [{ kind: "port", port: 1, link: "up" }] }],
		["node2", [{ net: "switch0" }], { phase: "booting", plugs: [{ kind: "port", port: 3, link: "cut" }] }],
		["node3", [{ net: "none" }], { phase: "booting", plugs: [{ kind: "none" }] }],
	]);
	expect(machine(state, "node2").spec).toMatchObject({
		image: "debian",
		memMiB: 512,
		disks: { root: "8", extra: [] },
		cpus: 1,
	});
	expect(state.rail.map((name) => [addressText(machine(state, name)), machine(state, name).spec.gateway])).toEqual([
		["10.88.0.11", true],
		["10.88.0.12", true],
		["10.88.0.13", false],
	]);
	expect(JSON.parse(saveWorkspace(state))).toMatchObject({ version: 6 });
});

test("a lab saved before machines chose addresses restores with the ones they had", () => {
	const nics = [
		{ net: "switch0", port: 4, cut: false },
		{ net: "none", port: null, cut: false },
	];
	const saved = { ...VERSION_1, version: 2, nodes: [{ ...VERSION_1.nodes[1], nics }] };
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved));
	expect(machine(state, "node2").spec).toMatchObject({
		gateway: true,
		nics: [
			{ net: "switch0", address: address("10.88.0.12/24") },
			{ net: "none", address: null },
		],
	});
});

test("a machine comes back with its name, and the pane layout with it", () => {
	let s = labWith(1);
	s = run(s, spawnEvent(s, 1, { name: "web-1" }));
	const web = s.rail[1];
	s = run(s, isReady(web), { type: "ui/park", machine: "node1" }, { type: "ui/maximise", machine: web });
	const { state, effects } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(state.rail).toEqual(["node1", "web-1"]);
	expect(machine(state, web)).toMatchObject({ n: 2, mac: "52:54:00:88:00:0c", sessions: ["web-1:console"] });
	expect(state.keyboard).toEqual({ kind: "pane", machine: "web-1" });
	expect(state.panes.maximised).toMatchObject({ machine: "web-1", before: { node1: "user" } });
	expect(effects.flatMap((e) => (e.type === "vm/boot" ? [e.config.identity.name] : []))).toEqual(state.rail);
	expect(spawnEvent(state, 1)).toMatchObject({ plan: { machines: [{ identity: { name: "node3" } }] } });
});

test("a lab saved before machines had names restores each as node and its number", () => {
	const nics = [{ net: "switch0", port: 4, cut: false, address: "10.1.0.9/24" }];
	const saved = { ...VERSION_1, version: 3, nodes: [{ ...VERSION_1.nodes[1], gateway: false, nics }] };
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved));
	expect(state.rail).toEqual(["node2"]);
	expect(machine(state, "node2").spec).toMatchObject({ gateway: false, nics: [{ address: address("10.1.0.9/24") }] });
});

test("a machine comes back with its disks", () => {
	let s = emptyLab();
	s = run(s, spawnEvent(s, 1, { extra: [1, 64] }));
	const { effects } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(effects.flatMap((e) => (e.type === "vm/boot" ? [e.config.spec.disks] : []))).toEqual([
		{ root: "4", extra: [1, 64] },
	]);
});

const VERSION_4 = {
	...VERSION_1,
	version: 4,
	nodes: [
		{
			...{ n: 1, name: "web", hue: 1, image: "alpine", memMiB: 256, diskGiB: "16", cpus: 2, gateway: true },
			nics: [{ net: "switch0", port: 1, cut: false, address: null }],
		},
	],
};

test("a lab saved before machines had extra disks restores with the root disk it had", () => {
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(VERSION_4));
	expect(machine(state, state.rail[0])).toMatchObject({ name: "web", spec: { disks: { root: "16", extra: [] } } });
	expect(JSON.parse(saveWorkspace(state))).toMatchObject({
		version: 6,
		nodes: [{ disks: { root: "16", extra: [] } }],
	});
});

test.each([
	undefined,
	{ root: "4" },
	{ root: "5", extra: [] },
	{ root: "4", extra: [0] },
	{ root: "4", extra: [65] },
	{ root: "4", extra: ["1"] },
	{ root: "4", extra: [1, 1, 1, 1, 1] },
])("a saved machine with the disks %j is refused", (disks) => {
	const saved = { ...VERSION_4, version: 5, nodes: [{ ...VERSION_4.nodes[0], disks }] };
	expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved))).toThrow("could not be read");
});

test.each([["node2"], ["Web"], ["node01"], [""], [7], [undefined], ["twin", "twin"]])(
	"a saved machine called %j is refused",
	(...names) => {
		const nodes = names.map((name, i) => ({ ...VERSION_1.nodes[i === 0 ? 0 : 2], name, gateway: false, nics: [] }));
		const nics = [{ net: "none", port: null, cut: false, address: null }];
		const saved = { ...VERSION_1, version: 4, nodes: nodes.map((node) => ({ ...node, nics })) };
		expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved))).toThrow("could not be read");
	},
);

test.each(["10.1.0.1", "10.1.0.0/24", "10.1.0.1/33", "", 7, undefined])(
	"a saved machine with the address %j is refused",
	(bad) => {
		const nics = [{ net: "switch0", port: 4, cut: false, address: bad }];
		const saved = { ...VERSION_1, version: 4, nodes: [{ ...VERSION_1.nodes[0], name: "node1", gateway: true, nics }] };
		expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved))).toThrow("could not be read");
	},
);

test.each([
	["no NICs", []],
	["more NICs than a machine can have", Array.from({ length: 5 }, () => ({ net: "none", port: null, cut: false }))],
	[
		"two NICs on one port",
		[
			{ net: "switch0", port: 4, cut: false },
			{ net: "switch0", port: 4, cut: false },
		],
	],
	["a port the switch does not have", [{ net: "switch0", port: 9, cut: false }]],
	["a NIC on a network there is not", [{ net: "switch1", port: null, cut: false }]],
])("a saved machine with %s is refused", (_why, nics) => {
	const saved = { ...VERSION_1, version: 2, nodes: [{ ...VERSION_1.nodes[0], nics }] };
	expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved))).toThrow("could not be read");
});

test("the open panels come back, and none maximised", () => {
	const s = run(
		labWith(1),
		{ type: "ui/panel-parked", panel: "capture" },
		{ type: "ui/panel-maximised", panel: "switch0" },
	);
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(state.panels).toEqual({ open: ["switch0"], maximised: null });
});

test.each([
	["open", ["capture", "switch0"]],
	["collapsed", []],
])("a lab saved with its one dock %s restores with the same panels", (dock, open) => {
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify({ ...VERSION_1, dock }));
	expect(state.panels.open).toEqual(open);
});
