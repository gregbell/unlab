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
			data: [{ machine: "node3", port: 3, link: "up" }],
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
		expect(result).toEqual({ kind: "visible", text: "node3 cut", data: [{ machine: "node3", port: 3, link: "cut" }] });
		expect(lab.events[0]).toEqual({
			type: "cmd/link",
			changes: [{ machine: "node3", up: false, port: 3, newPort: false }],
			cause: "agent",
		});
		expect(lab.effects).toContainEqual({ type: "link/set", port: 3, machine: "node3", up: false, cause: "agent" });
	});

	it("is the link_set tool", () => {
		const { tool } = storeLab().registry.find("link") ?? {};
		expect(tool).toMatchObject({ name: "link_set", policy: "run", annotations: {} });
		expect(tool?.toLine({ link: "down", machines: "node1,node3" })).toBe("link down node1,node3");
	});
});
