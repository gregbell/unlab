import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SwitchName, Tree } from "../../model/index.ts";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";
import { isLineError } from "../types.ts";
import type { Topology } from "./topology.ts";

type Lab = ReturnType<typeof storeLab>;

const will = (lab: Lab, line: string): string => {
	const preview = lab.parsed(line).preview(lab.store.state);
	if (isLineError(preview)) throw new Error(preview.message);
	return preview.will;
};

const offered = (lab: Lab, line: string) =>
	completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => [s.insert, s.detail]);

const said = (lab: Lab) => lab.effects.filter((e) => e.type === "switch/stp").map((e) => [e.switch, e.on]);

/** node1 on switch0, and lan and wan, with a cable from each switch to each of the others: a triangle. */
async function triangle(): Promise<Lab> {
	const lab = storeLab();
	await lab.lab(1);
	for (const line of [
		"mkswitch lan",
		"mkswitch wan",
		"cable switch0:7 lan:8",
		"cable lan:7 wan:8",
		"cable wan:7 switch0:8",
	]) {
		await lab.run(line);
	}
	lab.effects.length = 0;
	return lab;
}

const bridge = (last: number) => ({ priority: 32768, address: `02:00:00:00:00:0${last}` });
/** What the runtime says of wan once the three have agreed: its port to lan is kept out of use. */
const WAN: Tree = {
	bridge: bridge(3),
	root: bridge(1),
	cost: 20_000,
	ports: [
		{ port: 7, role: "root", state: "forwarding" },
		{ port: 8, role: "alternate", state: "discarding" },
	],
};

describe("stp", () => {
	it("turns spanning tree on for one switch, several or all, from the bar and its tool, and says so before and after", async () => {
		const lab = await triangle();
		expect(lab.store.state.stp).toEqual([]);
		expect(will(lab, "stp on lan")).toBe(
			"turn spanning tree on for lan · the switches that have it on block the ports that would close a loop between them",
		);
		expect(await lab.run("stp on lan", "agent")).toEqual({
			kind: "visible",
			text: "spanning tree on for lan",
			data: { stp: "on", switches: ["lan"], already: [] },
		});
		expect(lab.store.state.stp).toEqual(["lan"]);
		expect(said(lab)).toEqual([["lan", true]]);

		expect(will(lab, "stp on all")).toBe(
			"turn spanning tree on for switch0 and wan · the switches that have it on block the ports that would close a loop between them · lan was already on",
		);
		expect(await lab.run("stp on all")).toEqual({
			kind: "visible",
			text: "spanning tree on for switch0, lan and wan · lan was already on",
			data: { stp: "on", switches: ["switch0", "lan", "wan"], already: ["lan"] },
		});
		expect(lab.store.state.stp).toEqual(["switch0", "lan", "wan"]);
		expect(said(lab).slice(1)).toEqual([
			["switch0", true],
			["wan", true],
		]);
	});

	it("turns it off again, which lets a loop storm, and changes nothing for a switch that is already so", async () => {
		const lab = await triangle();
		await lab.run("stp on all");
		lab.effects.length = 0;
		expect(will(lab, "stp off wan,switch0")).toBe(
			"turn spanning tree off for switch0 and wan · every port carries frames, so a loop of cables storms",
		);
		expect(await lab.run("stp off wan,switch0")).toMatchObject({
			text: "spanning tree off for switch0 and wan",
			data: { stp: "off", switches: ["switch0", "wan"], already: [] },
		});
		expect(lab.store.state.stp).toEqual(["lan"]);
		expect(said(lab)).toEqual([
			["switch0", false],
			["wan", false],
		]);

		lab.effects.length = 0;
		expect(will(lab, "stp off wan")).toBe("change nothing: spanning tree is already off for wan");
		expect(await lab.run("stp off wan")).toMatchObject({
			text: "spanning tree off for wan · wan was already off",
			data: { stp: "off", switches: ["wan"], already: ["wan"] },
		});
		expect(said(lab)).toEqual([]);

		const alone = storeLab();
		expect(will(alone, "stp off switch0")).toBe("change nothing: spanning tree is already off for switch0");
		await alone.run("stp on switch0");
		expect(will(alone, "stp off switch0")).toBe("turn spanning tree off for switch0 · every port carries frames");
	});

	it("completes on and off, and then the switches that are there, in a list too", async () => {
		const lab = await triangle();
		expect(offered(lab, "stp ").map(([insert]) => insert)).toEqual(["on", "off"]);
		expect(offered(lab, "stp on ")).toEqual([
			["switch0", "3 of 8 ports taken"],
			["lan", "2 of 8 ports taken"],
			["wan", "2 of 8 ports taken"],
			["all", "every switch"],
		]);
		expect(offered(lab, "stp on lan,").map(([insert]) => insert)).toEqual(["lan,switch0", "lan,wan"]);
	});

	it("has an example, here and in the README, that turns it on for every switch", async () => {
		const lab = await triangle();
		const example = lab.registry.commands.find(({ manual }) => manual.verb === "stp")?.manual.example.line;
		const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
		const row = /^\| `(stp on [^`]+)`/m.exec(readme)?.[1];
		expect([example, row]).toEqual(["stp on all", "stp on all"]);
	});
});

describe("priority", () => {
	const told = (lab: Lab) => lab.effects.flatMap((e) => (e.type === "switch/priority" ? [[e.switch, e.priority]] : []));

	it("sets the priority of one switch, several or all, and says before and after which is the root", async () => {
		const lab = await triangle();
		await lab.run("stp on all");
		lab.effects.length = 0;
		expect(will(lab, "priority wan 4096")).toBe("set the priority of wan to 4096 · the lowest priority is the root");
		expect(await lab.run("priority wan 4096", "agent")).toEqual({
			kind: "visible",
			text: "priority 4096 for wan",
			data: { switches: ["wan"], priority: 4096, already: [] },
		});
		expect(lab.store.state.priorities).toEqual({ wan: 4096 });
		expect(told(lab)).toEqual([["wan", 4096]]);

		expect(will(lab, "priority all 4096")).toBe(
			"set the priority of switch0 and lan to 4096 · the lowest priority is the root · wan already had it",
		);
		expect(will(lab, "priority wan 4096")).toBe("change nothing: the priority of wan is already 4096");
		await lab.run("priority all 32768");
		expect(lab.store.state.priorities).toEqual({});
	});

	it("says that it counts once spanning tree is on, for a switch that has it off", async () => {
		const lab = await triangle();
		await lab.run("stp on lan");
		expect(will(lab, "priority lan,wan 8192")).toBe(
			"set the priority of lan and wan to 8192 · the lowest priority is the root · spanning tree is off for wan, so it counts once it is on",
		);
		expect(await lab.run("priority lan,wan 8192")).toMatchObject({
			text: "priority 8192 for lan and wan · spanning tree is off for wan, so it counts once it is on",
		});
		expect(lab.store.state.priorities).toEqual({ lan: 8192, wan: 8192 });
	});

	it("completes the switches, and then the priorities that are worth knowing", async () => {
		const lab = await triangle();
		expect(offered(lab, "priority ").map(([insert]) => insert)).toEqual(["switch0", "lan", "wan", "all"]);
		expect(offered(lab, "priority lan ").map(([insert]) => insert)).toEqual(["0", "4096", "32768", "61440"]);
	});
});

describe("cost", () => {
	it("sets what a port costs, by its name or by the NIC in it, and says what is in it", async () => {
		const lab = await triangle();
		await lab.run("stp on all");
		lab.effects.length = 0;
		expect(will(lab, "cost wan:8 200000")).toBe("make wan port 8 cost 200000 · its cable goes to lan port 7");
		expect(await lab.run("cost wan:8 200000", "agent")).toEqual({
			kind: "visible",
			text: "wan:8 costs 200000",
			data: { switch: "wan", port: 8, cost: 200_000 },
		});
		expect(lab.store.state.portCosts).toEqual([{ port: { switch: "wan", port: 8 }, cost: 200_000 }]);
		expect(lab.effects.filter((e) => e.type === "port/cost")).toEqual([
			{ type: "port/cost", port: { switch: "wan", port: 8 }, cost: 200_000 },
		]);
		expect(await lab.run("cost wan:8 200000")).toMatchObject({ text: "wan:8 already costs 200000" });
		expect(will(lab, "cost node1 2000")).toBe("make switch0 port 1 cost 2000 · node1 is in it");
		await lab.run("cost node1 2000");
		expect(lab.store.state.portCosts).toHaveLength(2);
		// Once the cable is out, the port costs what every port starts with.
		await lab.run("uncable wan:8");
		expect(lab.store.state.portCosts).toEqual([{ port: { switch: "switch0", port: 1 }, cost: 2000 }]);
	});

	it("says that it counts once spanning tree is on, for a port of a switch that has it off", async () => {
		const lab = await triangle();
		expect(await lab.run("cost lan:7 40000")).toMatchObject({
			text: "lan:7 costs 40000 · spanning tree is off for lan, so the cost counts once it is on",
		});
	});

	it("has examples, here and in the README", async () => {
		const lab = await triangle();
		const example = (verb: string) =>
			lab.registry.commands.find(({ manual }) => manual.verb === verb)?.manual.example.line;
		const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
		const row = (verb: string) => new RegExp(`^\\| \`(${verb} [^\`]+)\``, "m").exec(readme)?.[1];
		expect([example("priority"), row("priority")]).toEqual(["priority lan 4096", "priority lan 4096"]);
		expect([example("cost"), row("cost")]).toEqual(["cost lan:3 200000", "cost lan:3 200000"]);
	});
});

describe("topology, with spanning tree", () => {
	const listed = async (lab: Lab) => {
		const report = await lab.run("topology");
		if (report.kind !== "report") throw new Error("topology reports");
		return { ...report, data: report.data as Topology };
	};
	const says = (on: string, tree: Tree) => ({ type: "switch/tree", switch: on as SwitchName, tree }) as const;

	it("says nothing of it for a lab that has it off", async () => {
		const lab = await triangle();
		const { header, rows, data } = await listed(lab);
		expect(header).toBe("3 switches · 7 of 24 ports taken");
		expect(rows?.map(({ text }) => text).join("\n")).not.toMatch(/spanning tree|blocked/);
		expect(data.switches.map((sw) => "stp" in sw)).toEqual([false, false, false]);
		expect(data.switches.flatMap(({ ports }) => ports).some((port) => "stp" in port)).toBe(false);
	});

	it("says which switches have it on, each port's role and state, and blocked for a port that carries nothing", async () => {
		const lab = await triangle();
		await lab.run("stp on lan,wan");
		lab.runtime(says("wan", WAN));
		const { header, rows, data } = await listed(lab);
		expect(header).toBe("3 switches · 7 of 24 ports taken · 1 port blocked");
		expect(rows?.map(({ term, text }) => [term, text.split("\n")])).toEqual([
			[
				"switch0",
				["port 1 · node1 · up", "port 7 · lan:8 · up", "port 8 · wan:7 · up", "ports 2, 3, 4, 5 and 6 · free"],
			],
			[
				"lan",
				["spanning tree on", "port 7 · wan:8 · up", "port 8 · switch0:7 · up", "ports 1, 2, 3, 4, 5 and 6 · free"],
			],
			[
				"wan",
				[
					"spanning tree on",
					"port 7 · switch0:8 · up",
					"port 8 · lan:7 · up · blocked",
					"ports 1, 2, 3, 4, 5 and 6 · free",
				],
			],
		]);
		expect(data.switches.map(({ name, stp }) => [name, stp])).toEqual([
			["switch0", undefined],
			["lan", "on"],
			["wan", "on"],
		]);
		const [, , wan] = data.switches;
		expect(wan.ports[6].stp).toEqual({ role: "root", state: "forwarding" });
		expect(wan.ports[7].stp).toEqual({ role: "alternate", state: "discarding" });
		// A free port has no part in it, and neither has a port of a switch whose part the runtime has not said yet.
		expect("stp" in wan.ports[0]).toBe(false);
		expect(data.switches[1].ports.some((port) => "stp" in port)).toBe(false);

		// A port on its way into use learns addresses, and carries nothing yet.
		lab.runtime(says("wan", { ...WAN, ports: [WAN.ports[0], { port: 8, role: "designated", state: "learning" }] }));
		const later = await listed(lab);
		expect(later.header).toBe("3 switches · 7 of 24 ports taken");
		expect(later.rows?.[2].text).toContain("port 8 · lan:7 · up · learning");
	});
});
