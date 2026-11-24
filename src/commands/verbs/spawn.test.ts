import { describe, expect, it } from "vitest";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";

describe("spawn", () => {
	it("previews the machines, image, memory and ports it will take, and what it assumed", async () => {
		const lab = storeLab();
		await lab.lab(3);
		expect(lab.parsed("spawn 2 alpine").preview(lab.store.state)).toEqual({
			will: "boot node4 and node5 · alpine 3.24 · 256 MiB each · 2 CPUs · 4 GiB disk · plugged into switch0 on ports 4 and 5",
			assumed: "Left out, so assumed: --mem 256 --cpus 2 --disk 4 --nics 1 --net switch0",
			tone: "plain",
		});
		expect(lab.parsed("spawn 1 debian --mem 512 --no-net").preview(lab.store.state)).toEqual({
			will: "boot node4 · debian 13 · 512 MiB · 2 CPUs · 4 GiB disk · unplugged",
			assumed: "Left out, so assumed: --cpus 2 --disk 4 --nics 1",
			tone: "plain",
		});
	});

	it("refuses more machines than the lab has room for, under the count", async () => {
		const lab = storeLab();
		await lab.lab(7);
		expect(lab.parsed("spawn 2 alpine").validate(lab.store.state)).toEqual({
			message: "The lab has room for 1 more machine, not 2. Nothing was changed.",
			token: 1,
		});
		await lab.lab(1);
		expect(lab.parsed("spawn 1 alpine").validate(lab.store.state)).toEqual({
			message: "The lab has no room for another machine. Remove one with rm first. Nothing was changed.",
			token: 1,
		});
	});

	it("says what it wants in its own words, with a fix when one edit repairs the line", () => {
		const lab = storeLab();
		expect(lab.parse("spawn two alpine")).toEqual({
			message: "spawn wants a count here, not two. Nothing was changed.",
			token: 1,
		});
		expect(lab.parse("spawn 2 alpne")).toEqual({
			message: "No image called alpne. You have alpine, debian. Nothing was changed.",
			token: 2,
			fix: "spawn 2 alpine",
		});
		expect(lab.parse("spawn 2 alpine --mem")).toMatchObject({
			message: "spawn wants a size in MiB after --mem. Nothing was changed.",
		});
		expect(lab.parse("spawn 2 alpine --net switch0 --no-net")).toMatchObject({
			message: "spawn takes --net or --no-net, not both. Nothing was changed.",
		});
	});

	it("gives each NIC its own port, or leaves it unplugged", async () => {
		const lab = storeLab();
		await lab.lab(1);
		const will = (line: string) => lab.parsed(line).preview(lab.store.state);
		expect(will("spawn 2 alpine --nics 2")).toMatchObject({
			will: "boot node2 and node3 · alpine 3.24 · 256 MiB each · 2 CPUs · 4 GiB disk · 2 NICs each · plugged into switch0 on ports 2, 3, 4 and 5",
		});
		expect(will("spawn 1 alpine --nics 3 --net switch0,none,switch0")).toMatchObject({
			will: "boot node2 · alpine 3.24 · 256 MiB · 2 CPUs · 4 GiB disk · 3 NICs · plugged into switch0 on ports 2 and 3 · eth1 unplugged",
		});
		expect(will("spawn 1 alpine --nics 2 --no-net")).toMatchObject({
			will: "boot node2 · alpine 3.24 · 256 MiB · 2 CPUs · 4 GiB disk · 2 NICs · unplugged",
		});
		await lab.run("spawn 1 alpine --nics 3 --net none,switch0,none");
		expect(lab.store.state.machines.node2).toMatchObject({
			spec: { nics: [{ net: "none" }, { net: "switch0" }, { net: "none" }] },
			life: { plugs: [{ kind: "none" }, { kind: "port", port: 2 }, { kind: "none" }] },
		});
		expect(lab.events.at(-1)).toMatchObject({ line: "spawn 1 alpine --nics 3 --net none,switch0,none" });
	});

	it("refuses more switch ports than are free, naming how many there are and what would work", async () => {
		const lab = storeLab();
		await lab.lab(5);
		expect(lab.parsed("spawn 1 alpine --nics 4").validate(lab.store.state)).toEqual({
			message:
				"switch0 has 3 free ports, and this takes 4. Add --no-net to boot unplugged, or leave some NICs out with --net switch0,none. Nothing was changed.",
			token: 1,
		});
		expect(
			lab.parsed("spawn 1 alpine --nics 4 --net switch0,switch0,switch0,none").validate(lab.store.state),
		).toBeNull();
		expect(lab.parsed("spawn 1 alpine --nics 4 --no-net").validate(lab.store.state)).toBeNull();
	});

	it("refuses NICs a machine cannot have, and a --net list of some other length", () => {
		const lab = storeLab();
		const refusal = (line: string) => lab.parsed(line).validate(lab.store.state);
		expect(refusal("spawn 1 alpine --nics 5")).toEqual({
			message: "A machine has 1 to 4 NICs. Nothing was changed.",
			token: 3,
		});
		expect(refusal("spawn 1 alpine --net switch0,none")).toEqual({
			message: "--net names 2 NICs, so add --nics 2. Nothing was changed.",
			token: 3,
		});
		expect(refusal("spawn 1 alpine --nics 3 --net switch0,none")).toMatchObject({
			message: "--net names 2 NICs, so add --nics 2. Nothing was changed.",
		});
		expect(refusal("spawn 1 alpine --net none,none,none,none,none")).toMatchObject({
			message: "A machine has 1 to 4 NICs, and --net names 5. Nothing was changed.",
		});
		expect(lab.parse("spawn 1 alpine --nics 2 --net switch0,switc0")).toEqual({
			message: "spawn wants switch0 or none after --net, not switch0,switc0. Nothing was changed.",
			token: 6,
			fix: "spawn 1 alpine --nics 2 --net switch0,switch0",
		});
	});

	it("gives each NIC its address or none, and says so in the preview", async () => {
		const lab = storeLab();
		const will = (line: string) => lab.parsed(line).preview(lab.store.state);
		const head = "boot node1 · alpine 3.24 · 256 MiB · 2 CPUs · 4 GiB disk";
		expect(will("spawn 1 alpine --addr 10.1.0.1/24")).toEqual({
			will: `${head} · plugged into switch0 on port 1 · 10.1.0.1/24`,
			assumed: "Left out, so assumed: --mem 256 --cpus 2 --disk 4 --nics 1 --net switch0",
			tone: "plain",
		});
		expect(will("spawn 1 alpine --nics 2 --addr none,10.2.0.1/16 --no-gateway")).toMatchObject({
			will: `${head} · 2 NICs · plugged into switch0 on ports 1 and 2 · eth0 no address · eth1 10.2.0.1/16 · no package gateway`,
		});
		await lab.run("spawn 1 alpine --nics 2 --addr none,10.2.0.1/16 --no-gateway");
		expect(lab.store.state.machines.node1?.spec).toMatchObject({
			gateway: false,
			nics: [{ address: null }, { address: { ip: 0x0a020001, prefix: 16 } }],
		});
		expect(lab.events.at(-1)).toMatchObject({
			line: "spawn 1 alpine --nics 2 --addr none,10.2.0.1/16 --no-gateway",
		});
		await lab.run("spawn 2 alpine --addr none");
		expect(lab.store.state.machines.node3?.spec).toMatchObject({ gateway: true, nics: [{ address: null }] });
		await lab.run("spawn 1 alpine --no-net");
		expect(lab.store.state.machines.node4?.spec).toMatchObject({ gateway: false });
	});

	it.each([
		["--addr 10.1.0.1", "--addr 10.1.0.1 needs a prefix from 1 to 32, as in 10.1.0.1/24."],
		["--addr 10.1.0.1/33", "--addr 10.1.0.1/33 needs a prefix from 1 to 32, as in 10.1.0.1/24."],
		["--addr 10.1.0.1/0", "--addr 10.1.0.1/0 needs a prefix from 1 to 32, as in 10.1.0.1/24."],
		["--addr 10.1.0/24", "--addr wants an address with its prefix, such as 10.1.0.1/24, or none, not 10.1.0/24."],
		[
			"--addr 10.1.0.256/24",
			"--addr wants an address with its prefix, such as 10.1.0.1/24, or none, not 10.1.0.256/24.",
		],
		["--addr 10.1.0.0/24", "--addr 10.1.0.0/24 names its whole subnet, so use one from 10.1.0.1 to 10.1.0.254."],
		[
			"--addr 10.1.0.255/24",
			"--addr 10.1.0.255/24 is its subnet's broadcast address, so use one from 10.1.0.1 to 10.1.0.254.",
		],
		["--addr 127.0.0.1/8", "--addr 127.0.0.1/8 is not an address a NIC can have, so use one such as 10.1.0.1/24."],
		["--addr 224.0.0.5/24", "--addr 224.0.0.5/24 is not an address a NIC can have, so use one such as 10.1.0.1/24."],
		["--addr none,", "--addr wants an address with its prefix, such as 10.1.0.1/24, or none, not nothing."],
	])("cannot read %s", (option, sentence) => {
		expect(storeLab().parse(`spawn 1 alpine ${option}`)).toMatchObject({ message: `${sentence} Nothing was changed.` });
	});

	it.each([
		["spawn 1 alpine --addr 10.1.0.1/24,none", "--addr names 2 NICs, so add --nics 2."],
		[
			"spawn 1 alpine --nics 3 --addr 10.1.0.1/24",
			"--addr names 1 NIC of 3, so end it with none for each of the others.",
		],
		["spawn 1 alpine --nics 2 --addr none,none,none,none,none", "A machine has 1 to 4 NICs, and --addr names 5."],
		["spawn 2 alpine --addr 10.1.0.1/24", "--addr gives one machine its addresses, so spawn 1 at a time with it."],
		["spawn 1 alpine --addr 10.88.0.11/16", "10.88.0.11 is already node1's, so give another address with --addr."],
		[
			"spawn 1 alpine --nics 2 --addr 10.1.0.1/16,10.1.2.1/24",
			"--addr puts eth0 and eth1 in overlapping subnets, so give each its own, as in 10.1.0.1/24,10.2.0.1/24.",
		],
		[
			"spawn 1 alpine --addr 10.0.2.9/24",
			"--addr 10.0.2.9/24 overlaps 10.0.2.0/24, which the package gateway uses, so choose another subnet or add --no-gateway.",
		],
		[
			"spawn 1 alpine --addr 198.51.100.9/24",
			"--addr 198.51.100.9/24 overlaps 198.51.100.0/24, which the package gateway uses, so choose another subnet or add --no-gateway.",
		],
	])("refuses %s", async (line, sentence) => {
		const lab = storeLab();
		await lab.lab(1);
		const token = line.split(" ").indexOf("--addr");
		expect(lab.parsed(line).validate(lab.store.state)).toEqual({ message: `${sentence} Nothing was changed.`, token });
		expect(lab.parsed("spawn 1 alpine --addr 10.0.2.9/24 --no-gateway").validate(lab.store.state)).toBeNull();
	});

	it("completes none in an --addr list", () => {
		const lab = storeLab();
		const line = "spawn 1 alpine --nics 2 --addr 10.1.0.1/24,";
		expect(completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.insert)).toEqual([
			"10.1.0.1/24,none",
		]);
	});

	it("completes each network of a --net list", () => {
		const lab = storeLab();
		const line = "spawn 1 alpine --nics 2 --net switch0,";
		expect(completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.insert)).toEqual([
			"switch0,switch0",
			"switch0,none",
		]);
	});

	it("completes images by position and the options not yet used", () => {
		const lab = storeLab();
		const images = completeLine(lab.registry, "spawn 2 ", 8, lab.store.state);
		expect(images.slot).toBe(1);
		expect(images.suggestions.map((s) => [s.insert, s.detail])).toEqual([
			["alpine", "alpine 3.24"],
			["debian", "debian 13"],
		]);
		const line = "spawn 2 alpine --no-net --";
		const options = completeLine(lab.registry, line, line.length, lab.store.state);
		expect(options.suggestions.map((s) => s.insert)).toEqual([
			"--mem",
			"--cpus",
			"--disk",
			"--nics",
			"--addr",
			"--no-gateway",
		]);
	});

	it("logs the canonical line, leaving out what is the default", () => {
		const lab = storeLab();
		expect(lab.parsed("spawn  2 alpine --net switch0 --mem 256").line).toBe("spawn 2 alpine");
		expect(lab.parsed("spawn 1 alpine --no-net --mem 512").line).toBe("spawn 1 alpine --mem 512 --no-net");
	});

	it("adds every row at once, booting, and closes the bar as soon as they show", async () => {
		const lab = storeLab();
		const result = await lab.run("spawn 2 alpine");
		expect(result).toEqual({ kind: "visible", text: "booting node1 and node2", data: { names: ["node1", "node2"] } });
		expect(lab.store.state.rail).toEqual(["node1", "node2"]);
		expect(lab.store.state.rail.map((n) => lab.store.state.machines[n]?.life.phase)).toEqual(["booting", "booting"]);
		expect(lab.events.map((e) => e.type)).toEqual(["cmd/spawn", "cmd/logged"]);
		expect(lab.events[1]).toMatchObject({ line: "spawn 2 alpine", source: "bar", outcome: "ok" });
	});

	it("is the machines_spawn tool, asked first", () => {
		const { tool } = storeLab().registry.find("spawn") ?? {};
		expect(tool).toMatchObject({ name: "machines_spawn", policy: "ask", annotations: {} });
		expect(tool?.toLine({ count: 1, image: "alpine", nics: 2, net: "switch0,none" })).toBe(
			"spawn 1 alpine --nics 2 --net switch0,none",
		);
		expect(tool?.toLine({ count: 1, image: "alpine", addr: "10.1.0.1/24", gateway: "off" })).toBe(
			"spawn 1 alpine --addr 10.1.0.1/24 --no-gateway",
		);
		expect(tool?.toLine({ count: 2, image: "alpine", mem: 512, net: "none" })).toBe(
			"spawn 2 alpine --mem 512 --no-net",
		);
	});
});
