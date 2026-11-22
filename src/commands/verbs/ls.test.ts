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
			["node1", { kind: "state", text: "ready" }, "10.88.0.11 · up on port 1 · console, sh1", "node1:sh1"],
			["node2", { kind: "state", text: "ready" }, "10.88.0.12 · cut on port 2 · console", "node2:console"],
			["node3", { kind: "state", text: "ready" }, "10.88.0.13 · up on port 3 · console", "node3:console"],
			["node4", { kind: "state", text: "failed" }, "No prompt after 120 s.", "node4:console"],
			["node5", { kind: "state", text: "booting" }, "10.88.0.15 · unplugged · console", "node5:console"],
		]);
		expect(result.data).toContainEqual({
			name: "node2",
			state: "ready",
			address: "10.88.0.12",
			port: 2,
			link: "cut",
			sessions: ["node2:console"],
		});
	});

	it("says so when the lab is empty", async () => {
		const lab = storeLab();
		expect(lab.parsed("ls").preview(lab.store.state)).toMatchObject({
			will: "list 0 machines with their addresses and links",
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
