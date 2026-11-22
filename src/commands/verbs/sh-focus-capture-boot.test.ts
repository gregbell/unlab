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

describe("capture", () => {
	it("sets the filter and opens Wire", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(lab.parsed("capture icmp node1").preview(lab.store.state)).toMatchObject({
			will: "show frames matching icmp node1 in Wire",
		});
		expect(lab.parsed("capture").preview(lab.store.state)).toMatchObject({ will: "show every frame in Wire" });
		expect(await lab.run("capture icmp")).toMatchObject({ kind: "visible", text: "showing frames matching icmp" });
		expect(lab.store.state.view).toBe("wire");
		expect(lab.store.state.capture.filter).toBe("icmp");
	});

	it("refuses a filter it cannot read", () => {
		const lab = storeLab();
		expect(lab.parsed("capture icmp bogus").validate(lab.store.state)).toEqual({
			message:
				"capture cannot read bogus. A term is a protocol, a machine, an address, a MAC or port:N. Nothing was changed.",
			token: 1,
		});
	});
});

describe("boot", () => {
	it("boots a failed machine again on the lowest free port", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("spawn 1 alpine");
		lab.runtime({ type: "vm/failed", machine: "node3", attempt: 1, reason: "Kernel panic." });
		expect(lab.parsed("boot node3").preview(lab.store.state)).toMatchObject({
			will: "boot node3 again · alpine 3.24 · 256 MiB · plugged into switch0 on port 3",
		});
		expect(await lab.run("boot node3", "button")).toEqual({
			kind: "visible",
			text: "booting node3 again",
			data: null,
		});
		expect(lab.store.state.machines.node3?.life).toMatchObject({ phase: "booting", attempt: 2 });
		expect(lab.events).toContainEqual({ type: "cmd/boot-again", machine: "node3", port: 3, at: 0 });
	});

	it("wants a failed machine, and has no agent tool", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(lab.parse("boot node1")).toEqual({
			message: "boot wants a failed machine here, and node1 is already running. Nothing was changed.",
			token: 1,
		});
		expect(lab.registry.find("boot")?.tool).toBeNull();
	});
});
