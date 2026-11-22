import { describe, expect, it } from "vitest";
import { storeLab } from "../testing/store.ts";

describe("focus", () => {
	it("moves the keyboard to a machine or a session, and can promote or maximise its pane", async () => {
		const lab = storeLab();
		await lab.lab(3);
		await lab.run("sh node2");
		const will = (line: string) => {
			const preview = lab.parsed(line).preview(lab.store.state);
			return "will" in preview ? preview.will : preview.message;
		};
		expect(will("focus node1")).toBe("move the keyboard to node1");
		expect(will("focus node3 --main")).toBe("move node3 to the front and the keyboard to node3");
		expect(will("focus node2:console --max")).toBe(
			"maximise node2, or restore it if it is maximised, and move the keyboard to node2:console",
		);
		expect(await lab.run("focus node2:console --main")).toMatchObject({ kind: "visible" });
		expect(lab.store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(lab.store.state.machines.node2?.activeSession).toBe("node2:console");
		expect(lab.store.state.panes.order[0]).toBe("node2");
	});

	it("takes booting and failed machines, whose panes are worth looking at", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine");
		expect(await lab.run("focus node1")).toMatchObject({ kind: "visible" });
		expect(lab.parse("focus node1 --main --max")).toMatchObject({
			message: "focus takes --main or --max, not both. Nothing was changed.",
		});
		expect(lab.registry.find("focus")?.tool).toBeNull();
	});
});
