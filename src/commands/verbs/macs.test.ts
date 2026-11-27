import { describe, expect, it } from "vitest";
import type { PortNo } from "../../model/index.ts";
import { storeLab } from "../testing/store.ts";

describe("macs", () => {
	it("reports every switch when none is named, and says when one has learned nothing", async () => {
		const lab = storeLab();
		await lab.lab(1);
		await lab.run("mkswitch lan");
		lab.advance(5000);
		lab.learned.set("switch0", [{ vlan: 1, mac: "52:54:00:88:00:0b", port: 1 as PortNo, seen: 2000, flushed: false }]);
		lab.totals.set("switch0", { in: 4, delivered: 4, flooded: 1 });
		const result = await lab.run("macs");
		expect(result).toMatchObject({
			kind: "report",
			header: "2 switches · 1 learned",
			rows: [
				{ term: "switch0", text: "4 in · 4 delivered · 1 flooded\n52:54:00:88:00:0b · port 1 · node1 · 3 s ago" },
				{ term: "lan", text: "0 in · 0 delivered · 0 flooded\nnothing learned yet" },
			],
		});
		expect(lab.store.state.log.at(-1)).toMatchObject({ line: "macs", outcome: "ok" });
	});

	it("is the line its tool's input says, with or without switches", () => {
		const { registry } = storeLab();
		const tool = registry.find("macs")?.tool;
		expect([tool?.toLine({}), tool?.toLine({ switches: "switch0" })]).toEqual(["macs", "macs switch0"]);
	});
});
