import { describe, expect, it } from "vitest";
import { vlanOf } from "../../model/index.ts";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";
import { isLineError } from "../types.ts";

type Lab = ReturnType<typeof storeLab>;

const NOTHING = " Nothing was changed.";

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

const carried = (lab: Lab, port: string) => {
	const [on, no] = port.split(":");
	return vlanOf(lab.store.state, { switch: on as "switch0", port: Number(no) as 1 });
};

/** node1 and node2 on switch0, a cable from its port 8 to port 1 of lan, and node3 with its NIC unplugged. */
async function wired(): Promise<Lab> {
	const lab = storeLab();
	await lab.lab(2);
	await lab.run("mkswitch lan");
	await lab.run("cable switch0:8 lan:1");
	await lab.run("spawn 1 alpine --no-net");
	return lab;
}

describe("vlan", () => {
	it("puts a port in a VLAN, named by its number or by the NIC in it, and says so", async () => {
		const lab = await wired();
		expect(will(lab, "vlan switch0:1 10")).toBe("put switch0 port 1 in vlan 10 · node1 is in it");
		expect(await lab.run("vlan switch0:1 10", "agent")).toEqual({
			kind: "visible",
			text: "switch0:1 vlan 10",
			data: { switch: "switch0", port: 1, mode: "access", vlan: 10 },
		});
		expect(await lab.run("vlan node2 20")).toMatchObject({ text: "switch0:2 vlan 20" });
		expect(will(lab, "vlan lan:1 30")).toBe("put lan port 1 in vlan 30 · its cable goes to switch0 port 8");
		await lab.run("vlan lan:1 30");
		expect([carried(lab, "switch0:1"), carried(lab, "switch0:2"), carried(lab, "lan:1")]).toEqual([
			{ mode: "access", vlan: 10 },
			{ mode: "access", vlan: 20 },
			{ mode: "access", vlan: 30 },
		]);
		expect(lab.effects.filter((e) => e.type === "port/vlan")).toHaveLength(3);
	});

	it("changes nothing for a port that is in the VLAN already, and puts a trunk back in one", async () => {
		const lab = await wired();
		expect(will(lab, "vlan node1 1")).toBe("change nothing: switch0 port 1 is already vlan 1 · node1 is in it");
		expect(await lab.run("vlan node1 1")).toMatchObject({ text: "switch0:1 already vlan 1" });
		await lab.run("trunk switch0:8");
		await lab.run("vlan switch0:8 10");
		expect(carried(lab, "switch0:8")).toEqual({ mode: "access", vlan: 10 });
	});

	it("refuses in one sentence what it cannot set, with the argument at fault and what would do", async () => {
		const lab = await wired();
		expect(refused(lab, "vlan switch0:5 10")).toBe(
			`switch0:5 has no cable, so use switch0:1, switch0:2 or switch0:8.${NOTHING}`,
		);
		expect(refused(lab, "vlan node3 10")).toBe(`node3 is in no port, so plug it into one first.${NOTHING}`);
		expect(refused(lab, "vlan node1 0")).toBe(`0 is no VLAN, so use one from 1 to 4094.${NOTHING}`);
		expect(refused(lab, "vlan node1 4095")).toBe(`4095 is no VLAN, so use one from 1 to 4094.${NOTHING}`);
		expect(refused(lab, "vlan nobody 10")).toMatch(/^No machine is called nobody, so use /);
		expect(refused(lab, "vlan switch0 10")).toBe(
			`switch0 is a switch, so name a port with a cable in it: switch0:1, switch0:2 or switch0:8.${NOTHING}`,
		);
	});

	it("offers the ports that something is in, with what is in each and its VLAN, and the VLANs in use", async () => {
		const lab = await wired();
		await lab.run("vlan node2 20");
		expect(offered(lab, "vlan ")).toEqual([
			["switch0:1", "node1 · up · vlan 1"],
			["switch0:2", "node2 · up · vlan 20"],
			["switch0:8", "cable to lan:1 · up · vlan 1"],
			["lan:1", "cable to switch0:8 · up · vlan 1"],
		]);
		expect(offered(lab, "vlan node1 ").map(([insert]) => insert)).toEqual(["1", "20"]);
	});
});

describe("trunk", () => {
	it("makes the port of a cable between switches a trunk, of every VLAN and native 1 unless told otherwise", async () => {
		const lab = await wired();
		expect(will(lab, "trunk switch0:8")).toBe(
			"make switch0 port 8 a trunk of all VLANs, native 1 · its cable goes to lan port 1",
		);
		expect(await lab.run("trunk switch0:8", "agent")).toEqual({
			kind: "visible",
			text: "switch0:8 trunk of all VLANs, native 1",
			data: { switch: "switch0", port: 8, mode: "trunk", allowed: "all", native: 1 },
		});
		expect(await lab.run("trunk lan:1 --allow 20,10,20 --native 10")).toMatchObject({
			text: "lan:1 trunk of 10 and 20, native 10",
			data: { mode: "trunk", allowed: [10, 20], native: 10 },
		});
	});

	it("says before it runs when its native VLAN is not allowed, so nothing crosses it untagged", async () => {
		const lab = await wired();
		expect(will(lab, "trunk lan:1 --allow 10,20")).toBe(
			"make lan port 1 a trunk of 10 and 20, native 1 · its cable goes to switch0 port 8 · native 1 is not allowed, so nothing crosses it untagged",
		);
	});

	it("refuses the port of a machine's NIC, whose kernel cannot read tags, and names what would do", async () => {
		const lab = await wired();
		const nic = `switch0:1 holds the cable of node1, whose kernel has no 802.1Q to read tags with, so make a trunk of a port that a cable between switches is in, or put node1 in one VLAN with vlan node1 10.${NOTHING}`;
		expect(refused(lab, "trunk switch0:1")).toBe(nic);
		expect(refused(lab, "trunk node1")).toBe(nic);
		expect(refused(lab, "trunk switch0:8 --allow 10,x")).toBe(`x is no VLAN, so use one from 1 to 4094.${NOTHING}`);
		expect(refused(lab, "trunk switch0:8 --allow 10,")).toMatch(/^trunk wants /);
		expect(refused(lab, "trunk switch0:8 --native 5000")).toBe(`5000 is no VLAN, so use one from 1 to 4094.${NOTHING}`);
	});
});

describe("a port's VLAN, through the verbs that free it", () => {
	it("is 1 again once its cable is out, so the next one starts there", async () => {
		const lab = await wired();
		await lab.run("vlan node1 10");
		await lab.run("trunk switch0:8");
		await lab.run("unplug node1");
		await lab.run("uncable lan:1");
		expect([carried(lab, "switch0:1"), carried(lab, "switch0:8"), carried(lab, "lan:1")]).toEqual([
			{ mode: "access", vlan: 1 },
			{ mode: "access", vlan: 1 },
			{ mode: "access", vlan: 1 },
		]);
		await lab.run("plug node1 switch0:1");
		expect(carried(lab, "switch0:1")).toEqual({ mode: "access", vlan: 1 });
	});
});
