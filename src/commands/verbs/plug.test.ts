import { describe, expect, it } from "vitest";
import type { MachineName } from "../../model/index.ts";
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

/** node1 and node2 on switch0, node3 on switch0 and on none, and lan with nothing in it. */
async function wired(): Promise<Lab> {
	const lab = storeLab();
	await lab.lab(2);
	await lab.run("mkswitch lan");
	await lab.run("spawn 1 alpine --nics 2 --net switch0,none");
	lab.ready("node3");
	return lab;
}

async function spawned(lab: Lab, line: string): Promise<void> {
	await lab.run(line);
	lab.ready(...(lab.store.state.rail as readonly MachineName[]));
}

describe("plug", () => {
	it("moves a cable to a switch's lowest free port, or to the port that is named", async () => {
		const lab = await wired();
		expect(will(lab, "plug node1 lan")).toBe("move node1 from switch0 port 1 to lan port 1");
		expect(await lab.run("plug node1 lan:3", "agent")).toEqual({
			kind: "visible",
			text: "node1 plugged into lan port 3 · up",
			data: { machine: "node1", nic: "eth0", switch: "lan", port: 3, link: "up" },
		});
		expect(will(lab, "plug node3:eth1 lan")).toBe("plug node3:eth1 into lan port 1");
		expect(will(lab, "plug node1 lan:8")).toBe("move node1 from lan port 3 to lan port 8");
		expect(await lab.run("plug node1:eth0 switch0")).toMatchObject({
			text: "node1 plugged into switch0 port 1 · up",
			data: { switch: "switch0", port: 1 },
		});
	});

	it("changes nothing for a NIC that is there already, and says so", async () => {
		const lab = await wired();
		for (const line of ["plug node2 switch0", "plug node2 switch0:2"]) {
			expect(will(lab, line)).toBe("change nothing: node2 is already in switch0 port 2");
			lab.effects.length = 0;
			expect(await lab.run(line)).toEqual({
				kind: "visible",
				text: "node2 already in switch0 port 2 · up",
				data: { machine: "node2", nic: "eth0", switch: "switch0", port: 2, link: "up" },
			});
			expect(lab.effects).toEqual([]);
		}
	});

	it("moves a cut cable as it is, for link up to reconnect where it is now", async () => {
		const lab = await wired();
		await lab.run("link down node1");
		expect(will(lab, "plug node1 lan:2")).toBe(
			"move node1 from switch0 port 1 to lan port 2 · its cable is cut and stays cut",
		);
		expect(await lab.run("plug node1 lan:2")).toMatchObject({ data: { port: 2, link: "cut" } });
		expect(await lab.run("link up node1")).toMatchObject({ data: [{ switch: "lan", port: 2, link: "up" }] });
	});

	it("moves the cable of a machine that is off, which boots there", async () => {
		const lab = await wired();
		await lab.run("poweroff node1");
		expect(will(lab, "plug node1 lan")).toBe("move node1 from switch0 port 1 to lan port 1 · node1 is off");
		expect(await lab.run("plug node1 lan")).toMatchObject({ data: { switch: "lan", port: 1, link: "off" } });
		expect(will(lab, "boot node1")).toContain("plugged into lan on port 1");
	});

	it("says a port as the lab's other commands do, and takes it with its switch in a lab of one", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(will(lab, "plug node1 switch0:5")).toBe("move node1 from port 1 to port 5");
		expect(await lab.run("plug node1 switch0:5")).toMatchObject({
			text: "node1 plugged into port 5 · up",
			data: { switch: "switch0", port: 5 },
		});
	});

	it.each([
		["plug node3 lan", "node3 has 2 NICs, so use node3:eth0 or node3:eth1."],
		["plug node3:eth2 lan", "node3 has no NIC called eth2, so use eth0 or eth1."],
		["plug node1 switch0:3", "switch0:3 is taken by node3:eth0, so use switch0:4."],
		["plug node3:eth0 switch0:2", "switch0:2 is taken by node2, so use switch0:4."],
	])("%s is refused: %s", async (line, sentence) => {
		expect(refused(await wired(), line)).toBe(`${sentence} Nothing was changed.`);
	});

	it("names a full switch and a taken port of it, and what has room", async () => {
		const lab = await wired();
		await spawned(lab, "spawn 2 alpine --nics 4 --net lan");
		expect(refused(lab, "plug node1 lan")).toBe(
			"lan has no free port, so use switch0, or free a port with unplug. Nothing was changed.",
		);
		expect(refused(lab, "plug node1 lan:7")).toBe(
			"lan:7 is taken by node5:eth2 and lan has no free port, so use switch0, or free a port with unplug. Nothing was changed.",
		);
		const only = storeLab();
		await spawned(only, "spawn 2 alpine --nics 4");
		await spawned(only, "spawn 1 alpine --no-net");
		expect(refused(only, "plug node3 switch0")).toBe(
			"switch0 has no free port, so free a port with unplug. Nothing was changed.",
		);
		await only.run("unplug node2:eth1");
		expect(await only.run("plug node3 switch0")).toMatchObject({ data: { port: 6 } });
	});

	it("is refused when the lab has changed since the line was read", async () => {
		const lab = await wired();
		const line = lab.parsed("plug node1 lan:1");
		await lab.run("plug node2 lan:1");
		expect(line.validate(lab.store.state)?.message).toBe("lan:1 is taken by node2, so use lan:2. Nothing was changed.");
		lab.runtime({ type: "vm/failed", machine: "node1", attempt: 1, reason: "Broke." });
		expect(line.validate(lab.store.state)?.message).toBe(
			"plug wants a ready or off machine here, and node1 has failed. Nothing was changed.",
		);
	});

	it("completes a NIC, a switch and a switch's free ports, and fixes a switch that is nearly right", async () => {
		const lab = await wired();
		expect(offered(lab, "plug ")).toEqual([
			["node1", "switch0 port 1 · up"],
			["node2", "switch0 port 2 · up"],
			["node3:eth0", "switch0 port 3 · up"],
			["node3:eth1", "no cable"],
		]);
		expect(offered(lab, "plug node1 ")).toEqual([
			["switch0", "3 of 8 ports taken"],
			["lan", "0 of 8 ports taken"],
		]);
		expect(offered(lab, "plug node1 switch0:").map(([insert]) => insert)).toEqual(
			[4, 5, 6, 7, 8].map((port) => `switch0:${port}`),
		);
		expect(lab.parse("plug node1 lam:3")).toMatchObject({ token: 2, fix: "plug node1 lan:3" });
	});

	it("is the cable_plug tool", () => {
		const { tool } = storeLab().registry.find("plug") ?? {};
		expect(tool?.toLine({ nic: "node2:eth1", to: "lan:3" })).toBe("plug node2:eth1 lan:3");
	});
});

describe("unplug", () => {
	it("takes the cable out, whole or cut, and frees its port", async () => {
		const lab = await wired();
		await lab.run("link down node3:eth0");
		expect(will(lab, "unplug node3:eth0")).toBe("unplug node3:eth0 from switch0 port 3");
		expect(await lab.run("unplug node3:eth0")).toEqual({
			kind: "visible",
			text: "node3:eth0 unplugged",
			data: { machine: "node3", nic: "eth0", port: null, link: "unplugged" },
		});
		expect(will(lab, "plug node2 switch0:3")).toBe("move node2 from switch0 port 2 to switch0 port 3");
		expect(await lab.run("topology")).toMatchObject({
			data: {
				unplugged: [
					{ machine: "node3", nic: "eth0" },
					{ machine: "node3", nic: "eth1" },
				],
			},
		});
		expect(await lab.run("plug node3:eth0 lan")).toMatchObject({ data: { link: "up" } });
	});

	it("changes nothing for a NIC with no cable, and says so", async () => {
		const lab = await wired();
		expect(will(lab, "unplug node3:eth1")).toBe("change nothing: node3:eth1 is already unplugged");
		expect(await lab.run("unplug node3:eth1")).toMatchObject({ text: "node3:eth1 already unplugged" });
	});

	it("leaves a machine that is off to boot unplugged", async () => {
		const lab = await wired();
		await lab.run("poweroff node1");
		expect(will(lab, "unplug node1")).toBe("unplug node1 from switch0 port 1 · node1 is off");
		await lab.run("unplug node1");
		expect(will(lab, "boot node1")).toContain("unplugged");
	});

	it("is the cable_unplug tool", () => {
		const { tool } = storeLab().registry.find("unplug") ?? {};
		expect(tool?.toLine({ nic: "node2:eth1" })).toBe("unplug node2:eth1");
	});
});

describe("a port's name", () => {
	it("is none of a machine's, a NIC's or a switch's, and a capture filter's for its cable", async () => {
		const lab = await wired();
		for (const line of ["rm lan:3", "link down lan:3", "sh lan:3", "focus lan:3", "plug lan:3 lan"]) {
			expect(refused(lab, line), line).toMatch(/Nothing was changed\.$/);
		}
		for (const line of ["mkswitch lan:3", "spawn 1 alpine --name lan:3", "spawn 1 alpine --net lan:3"]) {
			expect(refused(lab, line), line).toMatch(/Nothing was changed\.$/);
		}
		expect(refused(lab, "capture lan:3")).toBeNull();
		// A filter reads port:3 as any switch's port 3, so no switch can be called port.
		expect(refused(lab, "mkswitch port")).toContain("port already means something in the lab");
		for (const line of ["plug node1 node2", "plug node1 node2:eth0", "plug node1 port:3"]) {
			expect(refused(lab, line), line).toMatch(/^No switch is called \w+, so use switch0 or lan\./);
		}
	});

	it("is the switch's, after a machine that had its name has gone", async () => {
		const lab = storeLab();
		await spawned(lab, "spawn 1 alpine --name lan");
		lab.store.dispatchCommand({ type: "cmd/remove", machines: lab.store.state.rail, cause: "bar" });
		expect(refused(lab, "capture lan:3")).toContain("capture cannot read lan:3");
		const [machine] = lab.store.state.rail;
		lab.runtime({ type: "vm/stopped", machine, attempt: 1, clean: true, at: 0 });
		await lab.run("mkswitch lan");
		expect(refused(lab, "capture lan:3")).toBeNull();
		expect(refused(lab, "plug lan:3 lan")).toContain("No machine is called lan");
	});
});
