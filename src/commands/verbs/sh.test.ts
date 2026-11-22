import { describe, expect, it } from "vitest";
import { storeLab } from "../testing/store.ts";

describe("sh", () => {
	it("opens the next shell, gives it the keyboard, and closes the bar once the tab shows", async () => {
		const lab = storeLab();
		await lab.lab(2);
		expect(lab.parsed("sh node2").preview(lab.store.state)).toMatchObject({
			will: "open node2:sh1, another shell on node2, and move the keyboard to it",
		});
		expect(await lab.run("sh node2")).toEqual({
			kind: "visible",
			text: "opened node2:sh1",
			data: { session: "node2:sh1" },
		});
		expect(lab.events.slice(0, 2)).toEqual([
			{ type: "cmd/shell", machine: "node2" },
			{ type: "cmd/focus", target: "node2:sh1", mode: "plain" },
		]);
		expect(lab.store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(lab.store.state.machines.node2?.activeSession).toBe("node2:sh1");
	});

	it("wants a ready machine, and has no agent tool", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine");
		expect(lab.parse("sh node1")).toEqual({
			message: "sh wants a ready machine here, and node1 is still booting. Nothing was changed.",
			token: 1,
		});
		expect(lab.registry.find("sh")?.tool).toBeNull();
	});
});
