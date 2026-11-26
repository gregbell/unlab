import { describe, expect, it } from "vitest";
import { conditions } from "../../../test/support/conditions.ts";
import { port0 } from "../../../test/support/ports.ts";
import { conditionsAt, type PortRef, parseSwitchName, type SwitchName } from "../../model/index.ts";
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
			message: "node1 has no NIC called eth1, so use eth0. Nothing was changed.",
			token: 2,
		});
		expect(lab.parse("link down node3:eth7")).toMatchObject({
			message: "node3 has no NIC called eth7, so use eth0 or eth1. Nothing was changed.",
		});
		expect(lab.parse("link down all:wlan0")).toMatchObject({
			message: "No NIC is called wlan0, so use eth0, eth1, eth2 or eth3. Nothing was changed.",
		});
		expect(lab.parse("link down node9:eth0")).toMatchObject({
			message: "No machine is called node9, so use node1, node2 or node3. Nothing was changed.",
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
				"switch0 has 1 free port and this takes 2, so remove a machine with rm to free its ports. Nothing was changed.",
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
			message: "link wants a ready or off machine here, and node3 is still booting. Nothing was changed.",
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
			changes: [{ machine: "node3", nic: 0, up: false, port: port0(3), newPort: false }],
			cause: "agent",
		});
		expect(lab.effects).toContainEqual({
			type: "link/set",
			port: port0(3),
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
			{ port: port0(1), up: true },
			{ port: port0(2), up: true },
		]);
	});

	it("is the link_set tool", () => {
		const { tool } = storeLab().registry.find("link") ?? {};
		expect(tool).toMatchObject({ name: "link_set", policy: "run", annotations: {} });
		expect(tool?.toLine({ link: "down", machines: "node1,node3" })).toBe("link down node1,node3");
	});
});

describe("link, with conditions", () => {
	const lan = parseSwitchName("lan") as SwitchName;
	const at = (on: SwitchName, port: PortRef["port"]): PortRef => ({ switch: on, port });

	/** node1 and node2 on switch0, and a cable from its port 8 to port 1 of lan. */
	async function wired() {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("mkswitch lan");
		await lab.run("cable switch0:8 lan:1");
		lab.events.length = 0;
		lab.effects.length = 0;
		return lab;
	}
	const will = (lab: Awaited<ReturnType<typeof wired>>, line: string) => {
		const preview = lab.parsed(line).preview(lab.store.state);
		return "will" in preview ? preview.will : preview.message;
	};

	it("sets any of them on a NIC's cable in one line, says so before it runs, and returns them as an option takes them", async () => {
		const lab = await wired();
		const line = "link up node1 --delay 100ms --loss 20% --reorder 25% --rate 1mbit --mtu 1400";
		expect(will(lab, line)).toBe(
			"node1 is already up · give the cable to node1 delay 100 ms, loss 20%, reorder 25%, rate 1 Mbit/s and mtu 1400",
		);
		const all = conditions({ delay: 100, loss: 20, reorder: 25, rate: 1_000_000, mtu: 1400 });
		expect(await lab.run(line)).toEqual({
			kind: "visible",
			text: "node1 up with delay 100 ms, loss 20%, reorder 25%, rate 1 Mbit/s and mtu 1400",
			data: [
				{
					machine: "node1",
					nic: "eth0",
					switch: "switch0",
					port: 1,
					link: "up",
					conditions: { delay: "100ms", loss: "20%", reorder: "25%", rate: "1mbit", mtu: "1400" },
				},
			],
		});
		expect(lab.events.slice(0, 2)).toEqual([
			{ type: "cmd/link", changes: [], cause: "bar" },
			{ type: "cmd/conditions", changes: [{ port: port0(1), conditions: all }] },
		]);
		// Both directions are the switch's to treat, at the port, and no machine is stopped or booted for it.
		expect(lab.effects).toEqual([{ type: "port/conditions", port: port0(1), conditions: all }]);
		expect(conditionsAt(lab.store.state, port0(2))).toEqual({});
	});

	it("sets them on a cable between switches by either of its ports, and on several cables at once", async () => {
		const lab = await wired();
		expect(will(lab, "link up lan:1 --loss 100%")).toBe(
			"the cable from lan port 1 to switch0 port 8 is already up · give the cable from lan port 1 to switch0 port 8 loss 100%",
		);
		expect(await lab.run("link up lan:1 --loss 100%")).toMatchObject({
			text: "lan:1 up with loss 100%",
			data: [{ switch: "lan", port: 1, to: at("switch0", 8), link: "up", conditions: { loss: "100%" } }],
		});
		const lossy = conditions({ loss: 100 });
		expect(lab.effects).toEqual([
			{ type: "port/conditions", port: port0(8), conditions: lossy },
			{ type: "port/conditions", port: at(lan, 1), conditions: lossy },
		]);
		expect(will(lab, "link up all,switch0:8 --delay 5ms")).toBe(
			"node1 and node2 are already up · the cable from switch0 port 8 to lan port 1 is already up · give the cables to node1 and node2 delay 5 ms · give the cable from switch0 port 8 to lan port 1 delay 5 ms and loss 100%",
		);
		expect(await lab.run("link up all,switch0:8 --delay 5ms")).toMatchObject({
			text: "node1 up with delay 5 ms, node2 up with delay 5 ms, switch0:8 up with delay 5 ms and loss 100%",
		});
	});

	it("leaves the conditions it is not given as they are, takes one away with 0, and all with --clear", async () => {
		const lab = await wired();
		await lab.run("link up node1 --delay 100ms --loss 20% --mtu 1400");
		await lab.run("link up node1 --loss 5%");
		expect(conditionsAt(lab.store.state, port0(1))).toEqual({ delay: 100, loss: 5, mtu: 1400 });
		expect(will(lab, "link up node1 --delay 0 --mtu 1500")).toBe(
			"node1 is already up · give the cable to node1 loss 5%",
		);
		await lab.run("link up node1 --delay 0 --mtu 1500");
		expect(conditionsAt(lab.store.state, port0(1))).toEqual({ loss: 5 });
		expect(will(lab, "link up node1 --loss 5%")).toBe(
			"change nothing: node1 is already up · the cable to node1 already has loss 5%",
		);
		expect(will(lab, "link up node1 --clear --rate 500kbit")).toBe(
			"node1 is already up · give the cable to node1 rate 500 kbit/s",
		);
		expect(will(lab, "link up node1 --clear")).toBe("node1 is already up · clear the conditions of the cable to node1");
		expect(await lab.run("link up node1 --clear")).toMatchObject({
			text: "node1 up with no conditions",
			data: [{ machine: "node1", link: "up", conditions: {} }],
		});
		expect(conditionsAt(lab.store.state, port0(1))).toEqual({});
		expect(lab.effects.at(-1)).toEqual({ type: "port/conditions", port: port0(1), conditions: {} });
	});

	it("cuts or plugs in the cable in the same line, and a cable that it plugs in is new", async () => {
		const lab = await wired();
		expect(will(lab, "link down node1 --loss 20%")).toBe(
			"cut the cable to node1 on switch0 port 1 · give the cable to node1 loss 20%",
		);
		expect(await lab.run("link down node1 --loss 20%")).toMatchObject({ text: "node1 cut with loss 20%" });
		expect(await lab.run("link up node1")).toMatchObject({
			text: "node1 up",
			data: [{ machine: "node1", nic: "eth0", switch: "switch0", port: 1, link: "up" }],
		});
		expect(conditionsAt(lab.store.state, port0(1))).toEqual({ loss: 20 });
		await lab.run("unplug node1");
		expect(will(lab, "link up node1 --delay 10ms")).toBe(
			"plug node1 into switch0 port 1 · give the cable to node1 delay 10 ms",
		);
		await lab.run("link up node1 --delay 10ms");
		expect(conditionsAt(lab.store.state, port0(1))).toEqual({ delay: 10 });
	});

	it("says nothing of conditions, and returns none, when the line has no option", async () => {
		const lab = await wired();
		await lab.run("link up node1 --loss 20%");
		const result = await lab.run("link down node1");
		expect(result).toEqual({
			kind: "visible",
			text: "node1 cut",
			data: [{ machine: "node1", nic: "eth0", switch: "switch0", port: 1, link: "cut" }],
		});
		expect(lab.events.filter((event) => event.type === "cmd/conditions")).toHaveLength(1);
	});

	it("refuses in one sentence what no cable can have, with the option at fault and what would do", async () => {
		const lab = await wired();
		const refused = (line: string) => {
			const parsed = lab.parse(line);
			const said = "message" in parsed ? parsed.message : (parsed.validate(lab.store.state)?.message ?? null);
			return said?.replace(/ Nothing was changed\.$/, "") ?? null;
		};
		expect(refused("link up node1 --delay fast")).toBe(
			"fast is no delay, so use one from 1ms to 10s in whole milliseconds, such as 100ms, or 0 for none.",
		);
		expect(refused("link up node1 --delay 11s")).toMatch(/^11s is no delay, so use one from 1ms to 10s/);
		expect(refused("link up node1 --loss 120%")).toBe(
			"120% is no share of frames, so use one from 0 to 100%, such as 20%.",
		);
		expect(refused("link up node1 --rate 1")).toBe(
			"1 is no rate, so use one from 1kbit to 10gbit, such as 1mbit, or 0 for none.",
		);
		expect(refused("link up node1 --mtu 9000")).toBe("9000 is no MTU, so use one from 68 to 1500 bytes, such as 1400.");
		expect(refused("link up node1 --reorder 25%")).toBe(
			"Reordering lets frames skip a cable's delay, and node1 has none, so give --delay too, such as --delay 20ms.",
		);
		expect(refused("link up node1 --delay 20ms --reorder 25%")).toBeNull();
		await lab.run("link up node1 --delay 20ms --reorder 25%");
		expect(refused("link up node1 --delay 0")).toBe(
			"node1 reorders frames by letting them skip its delay, so keep the delay, or take both away with --delay 0 --reorder 0.",
		);
		expect(refused("link up node1 --delay 0 --reorder 0")).toBeNull();
		await lab.run("unplug node2");
		expect(refused("link down node2 --loss 5%")).toBe(
			"node2 has no cable to give conditions, so plug it in with link up node2.",
		);
		expect(refused("link up node1 --loss")).toBe("link wants a share of frames such as 20% after --loss.");
	});

	it("takes the same from the link_set tool, and completes each option with values that would do", async () => {
		const lab = await wired();
		const { tool } = lab.registry.find("link") ?? {};
		const input = { link: "up", machines: "lan:1", delay: "100ms", loss: "20%", mtu: 1400, conditions: "clear" };
		expect(tool?.toLine(input)).toBe("link up lan:1 --delay 100ms --loss 20% --mtu 1400 --clear");
		expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
			"link",
			"machines",
			"delay",
			"loss",
			"reorder",
			"rate",
			"mtu",
			"conditions",
		]);
		expect(tool?.inputSchema.required).toEqual(["link", "machines"]);
		const offered = (line: string) =>
			completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.insert);
		expect(offered("link up node1 --")).toEqual(["--delay", "--loss", "--reorder", "--rate", "--mtu", "--clear"]);
		expect(offered("link up node1 --rate ")).toEqual(["1mbit", "10mbit", "500kbit", "0"]);
	});
});
