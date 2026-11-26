import { describe, expect, it } from "vitest";
import { parseSwitchName, type SwitchName } from "../../model/index.ts";
import { grantApproval } from "../approval.ts";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";
import { isLineError } from "../types.ts";

type Lab = ReturnType<typeof storeLab>;

const refused = (lab: Lab, line: string): string | null => {
	const parsed = lab.parse(line);
	return isLineError(parsed) ? parsed.message : (parsed.validate(lab.store.state)?.message ?? null);
};

const will = (lab: Lab, line: string): string => {
	const preview = lab.parsed(line).preview(lab.store.state);
	if (isLineError(preview)) throw new Error(preview.message);
	return preview.will;
};

const offered = (lab: Lab, line: string) =>
	completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => [s.insert, s.detail]);

const cables = (lab: Lab) =>
	lab.store.state.switchCables.map(({ ends: [a, b], link }) => `${a.switch}:${a.port}-${b.switch}:${b.port} ${link}`);

/** What the line asks before it runs, and the run that a yes to that starts. */
function yes(lab: Lab, line: string) {
	const p = lab.parsed(line);
	if (!p.danger) throw new Error(`${line} asks nothing`);
	const asked = p.confirm(lab.store.state);
	if (isLineError(asked)) throw new Error(asked.message);
	return { asked, run: () => p.run({ source: "bar", signal: lab.signal, approval: grantApproval(p.line, asked) }) };
}

const NOTHING = " Nothing was changed.";
const lan = parseSwitchName("lan") as SwitchName;

/** node1 and node2 on switch0, and lan and wan with nothing in them. */
async function wired(): Promise<Lab> {
	const lab = storeLab();
	await lab.lab(2);
	await lab.run("mkswitch lan");
	await lab.run("mkswitch wan");
	return lab;
}

describe("cable", () => {
	it("joins two switches at their lowest free ports, or at those that are named, and says what it took", async () => {
		const lab = await wired();
		expect(will(lab, "cable switch0 lan")).toBe("cable switch0 port 3 to lan port 1");
		expect(await lab.run("cable switch0 lan", "agent")).toEqual({
			kind: "visible",
			text: "cabled switch0:3 to lan:1",
			data: { from: { switch: "switch0", port: 3 }, to: { switch: "lan", port: 1 }, link: "up", loop: false },
		});
		expect(await lab.run("cable wan:8 lan:5")).toMatchObject({ text: "cabled wan:8 to lan:5" });
		expect(cables(lab)).toEqual(["switch0:3-lan:1 up", "wan:8-lan:5 up"]);
		expect(lab.effects.filter((e) => e.type === "cable/link")).toMatchObject([
			{ up: true, cause: "agent", plug: true },
			{ up: true, cause: "bar", plug: true },
		]);
	});

	it("says when a cable closes a loop, before it is put in and after: another between two switches, or one to itself", async () => {
		const lab = await wired();
		await lab.run("cable switch0 lan");
		expect(will(lab, "cable lan switch0")).toBe(
			"cable lan port 2 to switch0 port 4 · closes a loop, so a broadcast goes round until a cable of the loop is cut",
		);
		expect(will(lab, "cable wan wan")).toMatch(/^cable wan port 1 to wan port 2 · closes a loop/);
		expect(will(lab, "cable lan wan")).toBe("cable lan port 2 to wan port 1");
		await lab.run("cable lan wan");
		expect(await lab.run("cable wan switch0")).toEqual({
			kind: "visible",
			text: "cabled wan:2 to switch0:4 · closes a loop",
			data: { from: { switch: "wan", port: 2 }, to: { switch: "switch0", port: 4 }, link: "up", loop: true },
		});
	});

	it("changes nothing for a cable that is there already between the ports it names, either way round, and says so", async () => {
		const lab = await wired();
		await lab.run("cable switch0:3 lan:2");
		const near = { switch: "switch0", port: 3 };
		const far = { switch: "lan", port: 2 };
		expect(will(lab, "cable switch0:3 lan:2")).toBe("change nothing: switch0 port 3 to lan port 2 is already cabled");
		expect(await lab.run("cable switch0:3 lan:2", "agent")).toEqual({
			kind: "visible",
			text: "switch0:3 to lan:2 already cabled · up",
			data: { from: near, to: far, link: "up", loop: false },
		});
		expect(will(lab, "cable lan:2 switch0:3")).toBe("change nothing: lan port 2 to switch0 port 3 is already cabled");
		expect(await lab.run("cable lan:2 switch0:3", "agent")).toMatchObject({
			text: "lan:2 to switch0:3 already cabled · up",
			data: { from: far, to: near, link: "up", loop: false },
		});
		await lab.run("link down switch0:3");
		expect(will(lab, "cable switch0:3 lan:2")).toBe(
			"change nothing: switch0 port 3 to lan port 2 is already cabled · it is cut and stays cut",
		);
		expect(await lab.run("cable switch0:3 lan:2")).toMatchObject({ text: "switch0:3 to lan:2 already cabled · cut" });
		expect(cables(lab)).toEqual(["switch0:3-lan:2 cut"]);
		expect(lab.effects.filter((e) => e.type === "cable/attach")).toHaveLength(1);

		// One end of it and another port is a port that is taken.
		expect(refused(lab, "cable switch0:3 lan:4")).toBe(
			`switch0:3 is taken by the cable to lan:2, so use switch0:4.${NOTHING}`,
		);
		// With no port named, it is another cable.
		expect(will(lab, "cable switch0 lan")).toBe("cable switch0 port 4 to lan port 1");
	});

	it("refuses in one sentence what cannot be cabled, with the argument at fault", async () => {
		const lab = await wired();
		await lab.run("cable lan:3 wan:1");
		const at = (line: string) => {
			const parsed = lab.parse(line);
			const error = isLineError(parsed) ? parsed : parsed.validate(lab.store.state);
			return error?.token === undefined ? null : line.split(" ")[error.token];
		};
		for (const [line, sentence, fault] of [
			["cable lan dmz", "No switch is called dmz, so use switch0, lan or wan.", "dmz"],
			["cable none lan", "none is no switch, so use unplug to take the cable out.", "none"],
			["cable lan:9 wan", "lan:9 is no port, so use one from lan:1 to lan:8.", "lan:9"],
			["cable lan:4 lan:4", "Both ends are lan:4, and a cable has two, so name another port for one of them.", "lan:4"],
			["cable lan:3 switch0", "lan:3 is taken by the cable to wan:1, so use lan:1.", "lan:3"],
			["cable lan switch0:2", "switch0:2 is taken by node2, so use switch0:3.", "switch0:2"],
			["cable wan:1 lan", "wan:1 is taken by the cable to lan:3, so use wan:2.", "wan:1"],
		] as const) {
			expect(refused(lab, line), line).toBe(sentence + NOTHING);
			expect(at(line), line).toBe(fault);
		}
		for (const port of [1, 2, 4, 5, 6, 7]) await lab.run(`cable lan:${port} wan`);
		expect(refused(lab, "cable lan lan")).toBe(
			`lan has 1 free port and a cable from it to itself takes 2, so free one with unplug or uncable.${NOTHING}`,
		);
		await lab.run("cable lan wan");
		expect(refused(lab, "cable switch0 lan")).toBe(
			`lan has no free port, so use switch0, or free a port with unplug or uncable.${NOTHING}`,
		);
		expect(at("cable switch0 lan")).toBe("lan");
		expect(at("cable lan switch0")).toBe("lan");
		expect(refused(lab, "plug node1 lan:3")).toBe(
			`lan:3 is taken by the cable to wan:1 and lan has no free port, so use switch0, or free a port with unplug or uncable.${NOTHING}`,
		);
	});

	it("completes a switch for each end, and then its free ports", async () => {
		const lab = await wired();
		await lab.run("cable lan:1 wan");
		expect(offered(lab, "cable ")).toEqual([
			["switch0", "2 of 8 ports taken"],
			["lan", "1 of 8 ports taken"],
			["wan", "1 of 8 ports taken"],
		]);
		expect(offered(lab, "cable lan wan:").map(([insert]) => insert)).toEqual(
			[2, 3, 4, 5, 6, 7, 8].map((port) => `wan:${port}`),
		);
	});
});

describe("uncable", () => {
	it("removes the cable by either of its ports, and frees both", async () => {
		for (const port of ["lan:3", "wan:1"]) {
			const lab = await wired();
			await lab.run("cable lan:3 wan:1");
			const [near, far] = port === "lan:3" ? ["lan port 3", "wan port 1"] : ["wan port 1", "lan port 3"];
			expect(will(lab, `uncable ${port}`)).toBe(`remove the cable from ${near} to ${far}`);
			expect(await lab.run(`uncable ${port}`)).toMatchObject({
				kind: "visible",
				text: `removed the cable from ${port} to ${port === "lan:3" ? "wan:1" : "lan:3"}`,
			});
			expect(cables(lab)).toEqual([]);
			expect(will(lab, "cable lan:3 wan:1")).toBe("cable lan port 3 to wan port 1");
		}
	});

	it("says what it cannot remove, and what it could", async () => {
		const lab = await wired();
		expect(refused(lab, "uncable lan:3")).toBe(`lan:3 has no cable, and nothing is plugged into lan.${NOTHING}`);
		await lab.run("cable lan:3 wan:1");
		await lab.run("cable lan:5 switch0");
		expect(refused(lab, "uncable lan:4")).toBe(`lan:4 has no cable, so use lan:3 or lan:5.${NOTHING}`);
		expect(refused(lab, "uncable lan")).toBe(
			`lan is a switch, so name a port with a cable in it: lan:3 or lan:5.${NOTHING}`,
		);
		expect(refused(lab, "uncable switch0:1")).toBe(
			`switch0:1 holds the cable of node1, so use unplug node1.${NOTHING}`,
		);
		expect(refused(lab, "uncable dmz:1")).toBe(`No switch is called dmz, so use switch0, lan or wan.${NOTHING}`);
		expect(refused(lab, "uncable lan:0")).toBe(`lan:0 is no port, so use one from lan:1 to lan:8.${NOTHING}`);
		expect(refused(lab, "uncable node1")).toBe(`No switch is called node1, so use switch0, lan or wan.${NOTHING}`);
	});

	it("completes every port that a cable between switches is in, with where it goes", async () => {
		const lab = await wired();
		await lab.run("cable lan:3 wan:1");
		await lab.run("link down wan:1");
		await lab.run("cable switch0 switch0");
		expect(offered(lab, "uncable ")).toEqual([
			["switch0:3", "cable to switch0:4 · up"],
			["switch0:4", "cable to switch0:3 · up"],
			["lan:3", "cable to wan:1 · down"],
			["wan:1", "cable to lan:3 · down"],
		]);
	});
});

describe("link, for a cable between switches", () => {
	it("cuts and reconnects it by either of its ports, and returns it with where it goes", async () => {
		const lab = await wired();
		await lab.run("cable lan:3 wan:1");
		expect(will(lab, "link down wan:1")).toBe("cut the cable from wan port 1 to lan port 3");
		expect(await lab.run("link down wan:1", "agent")).toEqual({
			kind: "visible",
			text: "wan:1 cut",
			data: [{ switch: "wan", port: 1, to: { switch: "lan", port: 3 }, link: "cut" }],
		});
		expect(cables(lab)).toEqual(["lan:3-wan:1 cut"]);
		expect(will(lab, "link down lan:3")).toBe("change nothing: the cable from lan port 3 to wan port 1 is already cut");
		expect(await lab.run("link down lan:3")).toMatchObject({ text: "lan:3 cut" });
		expect(will(lab, "link up lan:3")).toBe("reconnect the cable from lan port 3 to wan port 1");
		expect(await lab.run("link up lan:3")).toMatchObject({
			text: "lan:3 up",
			data: [{ switch: "lan", port: 3, to: { switch: "wan", port: 1 }, link: "up" }],
		});
		expect(lab.effects.filter((e) => e.type === "cable/link").map((e) => [e.up, e.cause])).toEqual([
			[true, "bar"],
			[false, "agent"],
			[true, "bar"],
		]);
	});

	it("says when the cable that it reconnects closes a loop", async () => {
		const lab = await wired();
		await lab.run("cable lan wan");
		await lab.run("cable lan wan");
		await lab.run("link down lan:2");
		expect(will(lab, "link up lan:2")).toBe(
			"reconnect the cable from lan port 2 to wan port 2 · closes a loop, so a broadcast goes round until a cable of the loop is cut",
		);
		await lab.run("link down lan:1");
		expect(will(lab, "link up lan:2")).toBe("reconnect the cable from lan port 2 to wan port 2");
	});

	it("takes cables between switches beside machines' cables, in one line, and each once", async () => {
		const lab = await wired();
		await lab.run("cable lan:3 wan:1");
		expect(will(lab, "link down node1,lan:3,wan:1")).toBe(
			"cut the cable to node1 on switch0 port 1 · cut the cable from lan port 3 to wan port 1",
		);
		expect(await lab.run("link down node1,lan:3,wan:1")).toMatchObject({
			text: "node1 cut, lan:3 cut",
			data: [
				{ machine: "node1", nic: "eth0", switch: "switch0", port: 1, link: "cut" },
				{ switch: "lan", port: 3, to: { switch: "wan", port: 1 }, link: "cut" },
			],
		});
		// A port names the cable in it, whoever's it is.
		expect(await lab.run("link up switch0:1")).toMatchObject({ text: "node1 up" });
	});

	it("says what a port cannot name, and still means every machine by all", async () => {
		const lab = await wired();
		await lab.run("cable lan:3 wan:1");
		expect(refused(lab, "link down lan:4")).toBe(`lan:4 has no cable, so use lan:3.${NOTHING}`);
		expect(refused(lab, "link down lan")).toBe(`lan is a switch, so name a port with a cable in it: lan:3.${NOTHING}`);
		expect(refused(lab, "link down switch0:9")).toBe(
			`switch0:9 is no port, so use one from switch0:1 to switch0:8.${NOTHING}`,
		);
		expect(will(lab, "link down all")).toBe("cut the cables to node1 and node2 on switch0 ports 1 and 2");
		expect(offered(lab, "link down ").map(([insert]) => insert)).toEqual(["node1", "node2", "lan:3", "wan:1", "all"]);
	});
});

describe("rmswitch, for a switch with cables to others", () => {
	it("lists them in what it asks, removes them, and returns them", async () => {
		const lab = await wired();
		await lab.run("spawn 1 alpine --net lan");
		lab.ready("node3");
		await lab.run("cable lan wan:5");
		await lab.run("cable switch0 lan");
		expect(will(lab, "rmswitch lan")).toBe(
			"remove lan · unplugs node3 · removes the cables to wan port 5 and switch0 port 3",
		);
		const { asked, run } = yes(lab, "rmswitch lan");
		expect(asked).toMatchObject({
			question: "Remove lan?",
			detail:
				"This unplugs node3 from port 1. The machines run on, and link up plugs a NIC that is unplugged into switch0. This removes the cables from port 2 to wan port 5 and from port 3 to switch0 port 3. Its MAC table and counters are gone. There is no undo.",
		});
		expect(await run()).toEqual({
			kind: "visible",
			text: "removed lan · node3 unplugged · cables to wan port 5 and switch0 port 3 removed",
			data: {
				removed: "lan",
				unplugged: [{ machine: "node3", nic: "eth0" }],
				cables: [
					{ port: 2, to: { switch: "wan", port: 5 } },
					{ port: 3, to: { switch: "switch0", port: 3 } },
				],
			},
		});
		expect(cables(lab)).toEqual([]);
		expect(lab.store.state.switches).not.toContain(lan);
	});

	it("asks of one cable, and of none but cables, in the words for that", async () => {
		const lab = await wired();
		await lab.run("cable lan wan");
		expect(will(lab, "rmswitch lan")).toBe("remove lan · removes the cable to wan port 1");
		expect(yes(lab, "rmswitch lan").asked).toMatchObject({
			detail:
				"This removes the cable from port 1 to wan port 1. Its MAC table and counters are gone. There is no undo.",
		});
	});
});

describe("topology, with cables between switches", () => {
	it("lists such a cable at both its ports, each with the other as where it goes, and its link", async () => {
		const lab = await wired();
		await lab.run("cable lan:3 wan:1");
		await lab.run("link down lan:3");
		await lab.run("cable switch0 lan");
		const result = await lab.run("topology");
		expect(result).toMatchObject({
			kind: "report",
			header: "3 switches · 6 of 24 ports taken",
			rows: [
				{
					term: "switch0",
					text: "port 1 · node1 · up\nport 2 · node2 · up\nport 3 · lan:1 · up\nports 4, 5, 6, 7 and 8 · free",
				},
				{ term: "lan", text: "port 1 · switch0:3 · up\nport 3 · wan:1 · cut\nports 2, 4, 5, 6, 7 and 8 · free" },
				{ term: "wan", text: "port 1 · lan:3 · cut\nports 2, 3, 4, 5, 6, 7 and 8 · free" },
			],
		});
		const data =
			result.kind === "report" ? (result.data as { switches: { ports: unknown[]; storm?: unknown }[] }) : null;
		expect(data?.switches[1].ports[2]).toEqual({
			port: 3,
			cable: {
				to: { kind: "port", switch: "wan", port: 1 },
				link: "cut",
				conditions: {},
				carried: { delivered: 0, dropped: { loss: 0, rate: 0, mtu: 0 } },
			},
			vlan: { mode: "access", vlan: 1 },
		});
		expect(data?.switches.map((sw) => "storm" in sw)).toEqual([false, false, false]);
	});

	it("marks a switch that storms, with its rate and what it has dropped", async () => {
		const lab = await wired();
		lab.store.dispatchRuntime({ type: "switch/storm", switch: lan, storm: { since: 0, rate: 1980, dropped: 42 } });
		lab.store.dispatchRuntime({ type: "switch/storm", switch: "switch0", storm: { since: 0, rate: 7, dropped: 0 } });
		const result = await lab.run("topology");
		expect(result).toMatchObject({
			header: "3 switches · 2 of 24 ports taken · switch0 and lan storming",
			data: { switches: [{ storm: { rate: 7, dropped: 0 } }, { storm: { rate: 1980, dropped: 42 } }, {}] },
		});
		const rows = result.kind === "report" ? result.rows : [];
		expect(rows?.[1].text.split("\n")[0]).toBe("storming · 1980 looped frames a second · 42 dropped");
		expect(rows?.[2].text).toBe("ports 1, 2, 3, 4, 5, 6, 7 and 8 · free");
	});
});
