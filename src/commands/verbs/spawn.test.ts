import { describe, expect, it } from "vitest";
import { completeLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";

describe("spawn", () => {
	it("previews the machines, image, memory and ports it will take, and what it assumed", async () => {
		const lab = storeLab();
		await lab.lab(3);
		expect(lab.parsed("spawn 2 alpine").preview(lab.store.state)).toEqual({
			will: "boot node4 and node5 · alpine 3.24 · 256 MiB each · 2 CPUs · 4 GiB disk · plugged into switch0 on ports 4 and 5",
			assumed: "Left out, so assumed: --mem 256 --cpus 2 --disk 4 --net switch0",
			tone: "plain",
		});
		expect(lab.parsed("spawn 1 debian --mem 512 --no-net").preview(lab.store.state)).toEqual({
			will: "boot node4 · debian 13 · 512 MiB · 2 CPUs · 4 GiB disk · unplugged",
			assumed: "Left out, so assumed: --cpus 2 --disk 4",
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
		expect(options.suggestions.map((s) => s.insert)).toEqual(["--mem", "--cpus", "--disk"]);
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
		expect(tool?.toLine({ count: 2, image: "alpine", mem: 512, net: "none" })).toBe(
			"spawn 2 alpine --mem 512 --no-net",
		);
	});
});
