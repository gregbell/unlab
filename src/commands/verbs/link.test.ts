import { describe, expect, it } from "vitest";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";

describe("link", () => {
	it("previews each cable it changes by machine and port", async () => {
		const lab = storeLab();
		await lab.lab(3);
		const will = (line: string) => lab.parsed(line).preview(lab.store.state);
		expect(will("link down node3")).toEqual({ will: "cut the cable to node3 on port 3", assumed: null, tone: "plain" });
		expect(will("link down node1,node3")).toMatchObject({ will: "cut the cables to node1 and node3 on ports 1 and 3" });
		await lab.run("link down node2");
		expect(will("link up all")).toMatchObject({ will: "reconnect node2 on port 2 · node1 and node3 are already up" });
		expect(will("link down node2")).toMatchObject({ will: "change nothing: node2 is already cut" });
	});

	it("plugs an unplugged machine into the lowest free port", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("spawn 1 alpine --no-net");
		lab.ready("node3");
		expect(lab.parsed("link up node3").preview(lab.store.state)).toMatchObject({ will: "plug node3 into port 3" });
		expect(await lab.run("link up node3")).toEqual({
			kind: "visible",
			text: "node3 up",
			data: [{ machine: "node3", nic: "eth0", port: 3, link: "up" }],
		});
	});

	it("changes one NIC's cable, and leaves the machine's others alone", async () => {
		const lab = storeLab();
		await lab.lab(1);
		await lab.run("spawn 1 alpine --nics 3 --net switch0,switch0,none");
		lab.ready("node2");
		const will = (line: string) => lab.parsed(line).preview(lab.store.state);
		expect(will("link down node2:eth1")).toMatchObject({ will: "cut the cable to node2:eth1 on port 3" });
		expect(await lab.run("link down node2:eth1")).toEqual({
			kind: "visible",
			text: "node2:eth1 cut",
			data: [{ machine: "node2", nic: "eth1", port: 3, link: "cut" }],
		});
		expect(lab.store.state.machines.node2?.life).toMatchObject({
			plugs: [{ link: "up" }, { link: "cut" }, { kind: "none" }],
		});
		expect(will("link down node2")).toMatchObject({
			will: "cut the cable to node2:eth0 on port 2 · node2:eth1 and node2:eth2 are already cut",
		});
		expect(will("link up node2")).toMatchObject({
			will: "reconnect node2:eth1 on port 3 · plug node2:eth2 into port 4 · node2:eth0 is already up",
		});
		expect(will("link up node1,node2:eth2")).toMatchObject({
			will: "plug node2:eth2 into port 4 · node1 is already up",
		});
	});

	it("cuts every cable of a machine named alone", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --nics 2");
		lab.ready("node1");
		expect(await lab.run("link down node1")).toMatchObject({ text: "node1:eth0 cut, node1:eth1 cut" });
	});

	it("takes eth0 of a machine with one NIC, and says which NICs a machine has when it lacks the one named", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("spawn 1 alpine --nics 2");
		lab.ready("node3");
		expect(lab.parsed("link down node1:eth0").preview(lab.store.state)).toMatchObject({
			will: "cut the cable to node1 on port 1",
		});
		expect(lab.parse("link down node1:eth1")).toEqual({
			message: "node1 has no NIC called eth1. It has eth0. Nothing was changed.",
			token: 2,
		});
		expect(lab.parse("link down node3:eth7")).toMatchObject({
			message: "node3 has no NIC called eth7. It has eth0 and eth1. Nothing was changed.",
		});
		expect(lab.parse("link down all:wlan0")).toMatchObject({
			message: "No NIC is called wlan0. A machine has eth0, eth1, eth2 or eth3. Nothing was changed.",
		});
		expect(lab.parse("link down node9:eth0")).toMatchObject({
			message: "No machine called node9. You have node1, node2, node3. Nothing was changed.",
		});
		expect(lab.parsed("link down node*:eth1").preview(lab.store.state)).toMatchObject({
			will: "cut the cable to node3:eth1 on port 4 · skipped node1: no eth1, node2: no eth1",
		});
	});

	it("offers a machine's NICs by name once it has more than one", async () => {
		const lab = storeLab();
		await lab.lab(1);
		await lab.run("spawn 1 alpine --nics 2 --net switch0,none");
		lab.ready("node2");
		const { suggestions } = completeLine(lab.registry, "link up ", 8, lab.store.state);
		expect(suggestions.map((s) => [s.insert, s.detail])).toEqual([
			["node1", "10.88.0.11 · up"],
			["node2", "10.88.0.12 · up"],
			["node2:eth0", "port 2 · up"],
			["node2:eth1", "no cable"],
			["all", "every machine that can take it"],
		]);
	});

	it("refuses to plug in more NICs than the switch has ports for", async () => {
		const lab = storeLab();
		await lab.lab(7);
		await lab.run("spawn 1 alpine --nics 2 --no-net");
		lab.ready("node8");
		expect(lab.parsed("link up node8").validate(lab.store.state)).toEqual({
			message:
				"switch0 has 1 free port, and this takes 2. Remove a machine with rm to free its ports. Nothing was changed.",
			token: 2,
		});
	});

	it("acts on ready machines only, and says which it skipped", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("spawn 1 alpine");
		expect(lab.parsed("link down node*").preview(lab.store.state)).toMatchObject({
			will: "cut the cables to node1 and node2 on ports 1 and 2 · skipped node3: still booting",
		});
		expect(lab.parse("link down node3")).toEqual({
			message: "link has no machine to act on. Skipped node3: still booting. Nothing was changed.",
			token: 2,
		});
	});

	it("wants up or down, and offers the one-edit fix", async () => {
		const lab = storeLab();
		await lab.lab(3);
		expect(lab.parse("link dwon node3")).toEqual({
			message: "link wants up or down here, not dwon. Nothing was changed.",
			token: 1,
			fix: "link down node3",
		});
		const completion = completeLine(lab.registry, "link d", 6, lab.store.state);
		expect(completion).toMatchObject({ slot: 0, suggestions: [{ insert: "down" }] });
	});

	it("cuts the cable, writes the cause, and closes once the switch shows it", async () => {
		const lab = storeLab();
		await lab.lab(3);
		const result = await lab.run("link down node3", "agent");
		expect(result).toEqual({
			kind: "visible",
			text: "node3 cut",
			data: [{ machine: "node3", nic: "eth0", port: 3, link: "cut" }],
		});
		expect(lab.events[0]).toEqual({
			type: "cmd/link",
			changes: [{ machine: "node3", nic: 0, up: false, port: 3, newPort: false }],
			cause: "agent",
		});
		expect(lab.effects).toContainEqual({
			type: "link/set",
			port: 3,
			machine: "node3",
			nic: 0,
			up: false,
			cause: "agent",
		});
	});

	it("cuts and plugs in a machine that is off, whose link comes up when it boots", async () => {
		const lab = storeLab();
		await lab.lab(1);
		await lab.run("spawn 1 alpine --no-net");
		lab.ready("node2");
		await lab.run("poweroff all");
		expect(lab.parsed("link down node1").preview(lab.store.state)).toMatchObject({
			will: "cut the cable to node1 on port 1 · node1 is off",
		});
		expect(await lab.run("link down node1")).toMatchObject({
			text: "node1 cut",
			data: [{ machine: "node1", nic: "eth0", port: 1, link: "cut" }],
		});
		lab.effects.length = 0;
		expect(await lab.run("link up all")).toMatchObject({
			text: "node1 plugged in, node2 plugged in",
			data: [
				{ machine: "node1", nic: "eth0", port: 1, link: "off" },
				{ machine: "node2", nic: "eth0", port: 2, link: "off" },
			],
		});
		expect(lab.effects.filter((e) => e.type === "link/set")).toEqual([]);
		await lab.run("boot all");
		lab.runtime(
			{ type: "vm/ready", machine: "node1", attempt: 2, bootMs: 1 },
			{ type: "vm/ready", machine: "node2", attempt: 2, bootMs: 1 },
		);
		expect(lab.effects.filter((e) => e.type === "link/set")).toMatchObject([
			{ port: 1, up: true },
			{ port: 2, up: true },
		]);
	});

	it("is the link_set tool", () => {
		const { tool } = storeLab().registry.find("link") ?? {};
		expect(tool).toMatchObject({ name: "link_set", policy: "run", annotations: {} });
		expect(tool?.toLine({ link: "down", machines: "node1,node3" })).toBe("link down node1,node3");
	});
});
