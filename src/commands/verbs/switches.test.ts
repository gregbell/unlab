import { describe, expect, it } from "vitest";
import type { MachineName } from "../../model/index.ts";
import { grantApproval } from "../approval.ts";
import { completeLine, type Topology } from "../index.ts";
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

/** Says yes to a dangerous line, as a person does. */
async function yes(lab: Lab, line: string) {
	const p = lab.parsed(line);
	if (!p.danger) throw new Error(`${line} asks nothing`);
	const asked = p.confirm(lab.store.state);
	if (isLineError(asked)) throw new Error(asked.message);
	const run = () => p.run({ source: "bar", signal: lab.signal, approval: grantApproval(p.line, asked) });
	return { asked, run };
}

const readyAll = (lab: Lab) => lab.ready(...(lab.store.state.rail as readonly MachineName[]));

/** node1 on switch0, node2 on lan and switch0, node3 on lan and off. */
async function wired(): Promise<Lab> {
	const lab = storeLab();
	await lab.run("mkswitch lan");
	await lab.run("spawn 1 alpine");
	await lab.run("spawn 1 alpine --nics 2 --net lan,switch0");
	await lab.run("spawn 1 alpine --net lan");
	readyAll(lab);
	await lab.run("poweroff node3");
	return lab;
}

describe("mkswitch", () => {
	it("adds one by the name it is given, or by the next free one", async () => {
		const lab = storeLab();
		expect(will(lab, "mkswitch")).toBe("add switch1 · a switch of 8 ports, nothing plugged in");
		expect(await lab.run("mkswitch lan")).toEqual({ kind: "visible", text: "added lan", data: { name: "lan" } });
		expect(await lab.run("mkswitch")).toMatchObject({ data: { name: "switch1" } });
		expect(await lab.run("mkswitch")).toMatchObject({ data: { name: "switch2" } });
		expect(lab.store.state.switches).toEqual(["switch0", "lan", "switch1", "switch2"]);
	});

	it.each([
		["mkswitch lan", "A switch is already called lan, so give another name."],
		["mkswitch switch0", "A switch is already called switch0, so give another name."],
		["mkswitch web", "A machine is already called web, so give another name."],
		["spawn 1 alpine --name lan", "A switch is already called lan, so give another name with --name."],
		["mkswitch Wan", "mkswitch wants lowercase letters, so use wan."],
		[
			"mkswitch w_n",
			"mkswitch wants lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen, such as lan, not w_n.",
		],
		["mkswitch none", "none already means something in the lab, so use another name, such as none-1."],
		["mkswitch icmp", "icmp already means something in the lab, so use another name, such as icmp-1."],
		["mkswitch node4", "The lab gives out node4 itself, so use another name, such as lan."],
	])("%s is refused: %s", async (line, sentence) => {
		const lab = storeLab();
		await lab.run("mkswitch lan");
		await lab.run("spawn 1 alpine --name web");
		expect(refused(lab, line)).toBe(`${sentence} Nothing was changed.`);
	});

	it("refuses a ninth with the limit, named or not", async () => {
		const lab = storeLab();
		for (let n = 1; n <= 7; n++) await lab.run("mkswitch");
		for (const line of ["mkswitch", "mkswitch lan"]) {
			expect(refused(lab, line)).toBe(
				"The lab has all 8 switches that it can, so remove one with rmswitch first. Nothing was changed.",
			);
		}
	});
});

describe("--net", () => {
	it("takes any switch there is, or none, for each NIC, and completes and refuses with their names", async () => {
		const lab = storeLab();
		await lab.run("mkswitch lan");
		expect(will(lab, "spawn 1 alpine --nics 3 --net lan,none,switch0")).toContain(
			"plugged into lan on port 1 and switch0 on port 1 · eth1 unplugged",
		);
		const line = "spawn 1 alpine --nics 2 --net lan,";
		expect(completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.insert)).toEqual([
			"lan,switch0",
			"lan,lan",
			"lan,none",
		]);
		expect(refused(lab, "spawn 1 alpine --net wan")).toBe(
			"spawn wants switch0, lan or none after --net, not wan. Nothing was changed.",
		);
		expect(lab.parse("spawn 1 alpine --net lam")).toMatchObject({ fix: "spawn 1 alpine --net lan" });
	});

	it("is refused when the switch it was read with has gone", async () => {
		const lab = storeLab();
		await lab.run("mkswitch lan");
		const line = lab.parsed("spawn 1 alpine --net lan");
		await (await yes(lab, "rmswitch lan")).run();
		expect(line.validate(lab.store.state)?.message).toBe(
			"spawn wants switch0 or none after --net, not lan. Nothing was changed.",
		);
		if (line.danger) throw new Error("spawn is safe");
		expect(await line.run({ source: "bar", signal: lab.signal })).toMatchObject({ kind: "failed" });
		expect(lab.store.state.rail).toEqual([]);
	});

	it("names the switch that is full, and what would do", async () => {
		const lab = storeLab();
		await lab.run("mkswitch lan");
		await lab.run("spawn 2 alpine --nics 4 --net lan");
		expect(refused(lab, "spawn 1 alpine --net lan")).toBe(
			"lan has 0 free ports and this takes 1, so choose another switch with --net, or add --no-net to boot unplugged. Nothing was changed.",
		);
	});
});

describe("rmswitch", () => {
	it("asks with what is plugged in, and leaves it unplugged", async () => {
		const lab = await wired();
		expect(will(lab, "rmswitch lan")).toBe("remove lan · unplugs node2:eth0 and node3");
		const { asked, run } = await yes(lab, "rmswitch lan");
		expect(asked).toEqual({
			question: "Remove lan?",
			detail:
				"This unplugs node2:eth0 from port 1 and node3 from port 2. The machines run on, and link up plugs a NIC that is unplugged into switch0. Its MAC table and counters are gone. There is no undo.",
			actionLabel: "Remove lan",
			switch: "lan",
			machines: [
				{ n: 2, name: "node2" },
				{ n: 3, name: "node3" },
			],
		});
		expect(lab.store.state.switches).toEqual(["switch0", "lan"]);
		expect(await run()).toEqual({
			kind: "visible",
			text: "removed lan · node2:eth0 and node3 unplugged",
			data: {
				removed: "lan",
				unplugged: [
					{ machine: "node2", nic: "eth0" },
					{ machine: "node3", nic: "eth0" },
				],
				cables: [],
			},
		});
		expect(lab.store.state.switches).toEqual(["switch0"]);
	});

	it("says that nothing is plugged into an empty one", async () => {
		const lab = storeLab();
		await lab.run("mkswitch lan");
		expect(will(lab, "rmswitch lan")).toBe("remove lan · nothing is plugged in");
		expect((await yes(lab, "rmswitch lan")).asked.detail).toBe(
			"Nothing is plugged into it. Its MAC table and counters are gone. There is no undo.",
		);
	});

	it("does not take a yes to what has changed since", async () => {
		const lab = await wired();
		const { run } = await yes(lab, "rmswitch lan");
		await lab.run("spawn 1 alpine --net lan");
		expect(await run()).toEqual({
			kind: "failed",
			error: { message: "What this does to lan has changed since it was asked, so ask again. Nothing was changed." },
		});
		expect(lab.store.state.switches).toEqual(["switch0", "lan"]);
	});

	it("refuses switch0 and a switch that is not there, naming those that would do", async () => {
		const lab = storeLab();
		expect(refused(lab, "rmswitch switch0")).toBe(
			"switch0 cannot be removed, and the lab has no other switch. Nothing was changed.",
		);
		expect(refused(lab, "rmswitch lan")).toBe(
			"No switch is called lan, and switch0, the only one, cannot be removed. Nothing was changed.",
		);
		await lab.run("mkswitch lan");
		expect(refused(lab, "rmswitch switch0")).toBe("switch0 cannot be removed, so use lan. Nothing was changed.");
		expect(refused(lab, "rmswitch wan")).toBe("No switch is called wan, so use lan. Nothing was changed.");
		expect(lab.parse("rmswitch wan")).toMatchObject({ token: 1, fix: "rmswitch lan" });
		const line = "rmswitch ";
		expect(completeLine(lab.registry, line, line.length, lab.store.state).suggestions).toEqual([
			{ insert: "lan", label: "lan", detail: "0 of 8 ports taken" },
		]);
	});
});

describe("topology", () => {
	it("lists every switch and port, what is in it and its link, and what is in none", async () => {
		const lab = await wired();
		await lab.run("spawn 1 alpine --no-net");
		await lab.run("link down node2:eth1");
		const nic = (machine: string, no: string, state: string) => ({ kind: "nic", machine, nic: no, state });
		const free = (...ports: number[]) => ports.map((port) => ({ port, cable: null }));
		expect(await lab.run("topology")).toEqual({
			kind: "report",
			header: "2 switches · 4 of 16 ports taken",
			blocks: [],
			rows: [
				{
					term: "switch0",
					text: "port 1 · node1 · up\nport 2 · node2:eth1 · cut\nports 3, 4, 5, 6, 7 and 8 · free",
				},
				{
					term: "lan",
					text: "port 1 · node2:eth0 · up\nport 2 · node3 · down · off\nports 3, 4, 5, 6, 7 and 8 · free",
				},
				{ term: "unplugged", text: "node4 · no cable · booting" },
			],
			data: {
				switches: [
					{
						name: "switch0",
						ports: [
							{ port: 1, cable: { to: nic("node1", "eth0", "ready"), link: "up" } },
							{ port: 2, cable: { to: nic("node2", "eth1", "ready"), link: "cut" } },
							...free(3, 4, 5, 6, 7, 8),
						],
					},
					{
						name: "lan",
						ports: [
							{ port: 1, cable: { to: nic("node2", "eth0", "ready"), link: "up" } },
							{ port: 2, cable: { to: nic("node3", "eth0", "off"), link: "down" } },
							...free(3, 4, 5, 6, 7, 8),
						],
					},
				],
				unplugged: [nic("node4", "eth0", "booting")],
			},
		});
	});

	it("says that a cable is cut whatever its machine is doing", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("link down node1");
		await lab.run("poweroff node1");
		await lab.run("boot node1");
		const listed = await lab.run("topology");
		const { switches } = (listed.kind === "report" ? listed.data : null) as Topology;
		expect(switches[0].ports.slice(0, 2)).toMatchObject([
			{ cable: { to: { state: "booting" }, link: "cut" } },
			{ cable: { to: { state: "ready" }, link: "up" } },
		]);
	});

	it("lists an empty lab", async () => {
		const lab = storeLab();
		expect(await lab.run("topology")).toMatchObject({
			header: "1 switch · 0 of 8 ports taken",
			rows: [{ term: "switch0", text: "ports 1, 2, 3, 4, 5, 6, 7 and 8 · free" }],
			data: { switches: [{ name: "switch0" }], unplugged: [] },
		});
	});
});

describe("a port", () => {
	it("is named with its switch in a lab of several, by every command that names one", async () => {
		const lab = await wired();
		expect(will(lab, "link down node1,node2")).toBe(
			"cut the cables to node1, node2:eth0 and node2:eth1 on switch0 ports 1 and 2 and lan port 1",
		);
		expect(await lab.run("link down node2")).toMatchObject({
			data: [
				{ machine: "node2", nic: "eth0", switch: "lan", port: 1, link: "cut" },
				{ machine: "node2", nic: "eth1", switch: "switch0", port: 2, link: "cut" },
			],
		});
		expect(will(lab, "link up node2:eth0")).toBe("reconnect node2:eth0 on lan port 1");
		expect(will(lab, "rm node2")).toBe("remove node2 with its disk · frees lan port 1 and switch0 port 2");
		expect(will(lab, "boot node3")).toContain("plugged into lan on port 2");
		const listed = await lab.run("ls");
		expect(listed).toMatchObject({
			blocks: [
				{ lastLine: expect.stringContaining(" · up on switch0 port 1 · ") },
				{ lastLine: expect.stringContaining(" · cut on lan port 1\n") },
				{ lastLine: expect.stringContaining(" · plugged into lan port 2 · ") },
			],
			data: [
				{ nics: [{ switch: "switch0", port: 1 }] },
				{
					nics: [
						{ switch: "lan", port: 1 },
						{ switch: "switch0", port: 2 },
					],
				},
				{ nics: [{ switch: "lan", port: 2 }] },
			],
		});
		const line = "link up node2:";
		expect(completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.detail)).toEqual([
			"lan port 1 · down",
			"switch0 port 2 · down",
		]);
	});

	it("is a number alone again once the others are removed", async () => {
		const lab = await wired();
		await (await yes(lab, "rmswitch lan")).run();
		expect(will(lab, "link down node1")).toBe("cut the cable to node1 on port 1");
		const listed = await lab.run("ls");
		expect(JSON.stringify(listed.kind === "report" ? listed.data : null)).not.toContain('"switch"');
	});
});
