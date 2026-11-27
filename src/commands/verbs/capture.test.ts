import { describe, expect, it } from "vitest";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";

/** node2 on switch0 and lan, and node1's cable, which is cut, in lan. */
async function several() {
	const lab = storeLab();
	await lab.lab(1);
	await lab.run("mkswitch lan");
	await lab.run("spawn 1 alpine --nics 2 --net switch0,lan");
	lab.ready("node2");
	await lab.run("plug node1 lan:4");
	await lab.run("link down node1");
	return lab;
}

describe("capture", () => {
	it("sets the filter and maximises the capture", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(lab.parsed("capture icmp node1").preview(lab.store.state)).toMatchObject({
			will: "show captured frames matching icmp node1",
		});
		expect(lab.parsed("capture").preview(lab.store.state)).toMatchObject({ will: "show every captured frame" });
		expect(await lab.run("capture icmp")).toMatchObject({ kind: "visible", text: "showing frames matching icmp" });
		expect(lab.store.state.panels.maximised).toBe("capture");
		expect(lab.store.state.capture.filter).toBe("icmp");
	});

	it("refuses a filter it cannot read", () => {
		const lab = storeLab();
		expect(lab.parse("capture icmp bogus")).toEqual({
			message:
				"capture cannot read bogus, so use a protocol, a machine, a NIC (node2:eth1), an address, a MAC, vlan N or port:N. Nothing was changed.",
			token: 2,
		});
	});

	it("marks the term at fault, and takes a misspelt one as a typo", async () => {
		const lab = await several();
		expect(lab.parse("capture arp  or lam:3 icmp")).toMatchObject({
			message: "No switch is called lam, so use switch0 or lan. Nothing was changed.",
			token: 3,
			fix: "capture arp  or lan:3 icmp",
		});
		expect(lab.parse("capture icmp lan:9")).toEqual({
			message: "lan:9 is no port, so use one from lan:1 to lan:8. Nothing was changed.",
			token: 2,
		});
		expect(lab.parse("capture icmpp lan")).toMatchObject({ token: 1, fix: "capture icmp lan" });
		expect(lab.parse("capture arp or")).toMatchObject({ token: 2 });
		expect(lab.parsed("capture lan:2 icmp or port:3").validate(lab.store.state)).toBeNull();
	});

	it("offers no fix that would be refused in its turn", async () => {
		const lab = storeLab();
		await lab.lab(2);
		const once = lab.parse("capture node1:eth5");
		expect(once).toMatchObject({ token: 1 });
		expect(once).not.toHaveProperty("fix");
		const several = await (async () => {
			const two = storeLab();
			await two.lab(1);
			await two.run("mkswitch");
			return two;
		})();
		expect(several.parse("capture switch1:9")).not.toHaveProperty("fix");
	});

	it("is refused when the switch that it names has gone to a machine since it was read", async () => {
		const lab = await several();
		const line = lab.parsed("capture lan:2");
		for (const nic of ["node2:eth1", "node1"]) await lab.run(`unplug ${nic}`);
		lab.store.dispatchCommand({
			type: "cmd/switch-remove",
			switch: lab.store.state.switches[1] ?? "switch0",
			cause: "bar",
		});
		expect(line.validate(lab.store.state)).toBeNull();
		await lab.run("spawn 1 alpine --name lan");
		expect(line.validate(lab.store.state)?.message).toContain("capture cannot read lan:2");
	});

	it("completes machines, NICs, switches with their ports, and protocols, in any place", async () => {
		const lab = await several();
		const offered = (line: string) =>
			completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => [s.insert, s.detail]);
		expect(offered("capture l")).toEqual([["lan", "2 of 8 ports taken"]]);
		expect(offered("capture icmp or node")).toEqual([
			["node1", "10.88.0.11 · down"],
			["node2", "10.88.0.12 · up"],
			["node2:eth0", "switch0 port 2 · up"],
			["node2:eth1", "lan port 1 · up"],
		]);
		expect(offered("capture node1:")).toEqual([["node1:eth0", "lan port 4 · down"]]);
		expect(offered("capture icmp lan:").slice(0, 4)).toEqual([
			["lan:1", "node2:eth1 · up"],
			["lan:2", "no cable"],
			["lan:3", "no cable"],
			["lan:4", "node1 · down"],
		]);
		expect(offered("capture port:").map(([insert]) => insert)).toEqual(
			[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `port:${n}`),
		);
		expect(offered("capture d")).toEqual([
			["dhcp", undefined],
			["dns", undefined],
		]);
	});

	it("offers no switch in a lab of one, which still reads its ports", async () => {
		const lab = storeLab();
		await lab.lab(1);
		const offered = (line: string) =>
			completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.insert);
		expect(offered("capture ")).toEqual([
			"node1",
			"arp",
			"ip",
			"ipv4",
			"ipv6",
			"icmp",
			"tcp",
			"udp",
			"dhcp",
			"dns",
			"stp",
		]);
		expect(offered("capture switch0:1")).toEqual(["switch0:1"]);
		expect(lab.parsed("capture switch0:1").validate(lab.store.state)).toBeNull();
	});
});
