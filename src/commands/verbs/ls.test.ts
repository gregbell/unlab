import { describe, expect, it } from "vitest";
import { storeLab } from "../testing/store.ts";

describe("ls", () => {
	it("returns one block per machine, with its address, cable and sessions, and keeps the bar open", async () => {
		const lab = storeLab();
		await lab.lab(3);
		await lab.run("sh node1");
		await lab.run("link down node2");
		await lab.run("spawn 1 alpine");
		lab.runtime({ type: "vm/failed", machine: "node4", attempt: 1, reason: "No prompt after 120 s." });
		await lab.run("spawn 1 alpine --no-net");

		const result = await lab.run("ls");
		if (result.kind !== "report") throw new Error("ls reports");
		expect(result.header).toBe("5 machines · 3 ready, 1 booting, 1 failed");
		expect(result.blocks.map((b) => [b.machine, b.status, b.lastLine, b.focus])).toEqual([
			[
				"node1",
				{ kind: "state", text: "ready" },
				"10.88.0.11/24 · 52:54:00:88:00:0b · up on port 1 · 4 GiB disk · console, sh1",
				"node1:sh1",
			],
			[
				"node2",
				{ kind: "state", text: "ready" },
				"10.88.0.12/24 · 52:54:00:88:00:0c · cut on port 2 · 4 GiB disk · console",
				"node2:console",
			],
			[
				"node3",
				{ kind: "state", text: "ready" },
				"10.88.0.13/24 · 52:54:00:88:00:0d · up on port 3 · 4 GiB disk · console",
				"node3:console",
			],
			["node4", { kind: "state", text: "failed" }, "No prompt after 120 s.", "node4:console"],
			[
				"node5",
				{ kind: "state", text: "booting" },
				"10.88.0.15/24 · 52:54:00:88:00:0f · unplugged · 4 GiB disk · console",
				"node5:console",
			],
		]);
		expect(result.data).toContainEqual({
			name: "node2",
			state: "ready",
			address: "10.88.0.12",
			gateway: true,
			nics: [{ name: "eth0", mac: "52:54:00:88:00:0c", address: "10.88.0.12", prefix: 24, port: 2, link: "cut" }],
			disks: [{ device: "/dev/wdb", gib: 4 }],
			checkpoints: [],
			sessions: ["node2:console"],
		});
	});

	it("gives each NIC of a machine its own line, with its MAC, address and port", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --nics 3 --net switch0,switch0,none");
		lab.ready("node1");
		await lab.run("link down node1:eth1");
		const result = await lab.run("ls");
		if (result.kind !== "report") throw new Error("ls reports");
		expect(result.blocks[0].lastLine.split("\n")).toEqual([
			"eth0 · 10.88.0.11/24 · 52:54:00:88:00:0b · up on port 1",
			"eth1 · no address · 52:54:00:88:01:0b · cut on port 2",
			"eth2 · no address · 52:54:00:88:02:0b · unplugged",
			"4 GiB disk · console",
		]);
		expect(result.data).toMatchObject([
			{
				address: "10.88.0.11",
				nics: [
					{ name: "eth0", mac: "52:54:00:88:00:0b", address: "10.88.0.11", port: 1, link: "up" },
					{ name: "eth1", mac: "52:54:00:88:01:0b", address: null, port: 2, link: "cut" },
					{ name: "eth2", mac: "52:54:00:88:02:0b", address: null, port: null, link: "unplugged" },
				],
			},
		]);
	});

	it("lists every disk of a machine with its size", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --disk 8 --extra-disk 1,64 --no-net");
		const result = await lab.run("ls");
		if (result.kind !== "report") throw new Error("ls reports");
		expect(result.blocks[0].lastLine).toBe(
			"10.88.0.11/24 · 52:54:00:88:00:0b · unplugged · /dev/wdb 8 GiB, /dev/wdc 1 GiB, /dev/wdd 64 GiB · console",
		);
		expect(result.data).toMatchObject([
			{
				disks: [
					{ device: "/dev/wdb", gib: 8 },
					{ device: "/dev/wdc", gib: 1 },
					{ device: "/dev/wdd", gib: 64 },
				],
			},
		]);
	});

	it("shows the addresses the lab set, and which machines have no package gateway", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --nics 2 --addr none,10.2.0.1/16 --no-gateway");
		await lab.run("spawn 1 alpine --addr none");
		const result = await lab.run("ls");
		if (result.kind !== "report") throw new Error("ls reports");
		expect(result.blocks.map((b) => b.lastLine.split("\n"))).toEqual([
			[
				"eth0 · no address · 52:54:00:88:00:0b · port 1 reserved",
				"eth1 · 10.2.0.1/16 · 52:54:00:88:01:0b · port 2 reserved",
				"no package gateway · 4 GiB disk · console",
			],
			["no address · 52:54:00:88:00:0c · port 3 reserved · 4 GiB disk · console"],
		]);
		expect(result.data).toMatchObject([
			{
				address: "10.2.0.1",
				gateway: false,
				nics: [
					{ address: null, prefix: null },
					{ address: "10.2.0.1", prefix: 16 },
				],
			},
			{ address: null, gateway: true },
		]);
	});

	it("says so when the lab is empty", async () => {
		const lab = storeLab();
		expect(lab.parsed("ls").preview(lab.store.state)).toMatchObject({
			will: "list 0 machines with their addresses, links and disks",
		});
		expect(await lab.run("ls")).toEqual({ kind: "report", header: "no machines yet", blocks: [], data: [] });
	});

	it("takes no arguments", () => {
		expect(storeLab().parse("ls node1")).toEqual({
			message: "ls takes no arguments, so node1 is one too many. Nothing was changed.",
			token: 1,
		});
	});

	it("is the read-only machines_list tool", () => {
		const { tool } = storeLab().registry.find("ls") ?? {};
		expect(tool).toMatchObject({ name: "machines_list", policy: "run", annotations: { readOnlyHint: true } });
		expect(tool?.toLine({})).toBe("ls");
	});
});
