import { describe, expect, it } from "vitest";
import { createCommandService, isLineError } from "./index.ts";
import { storeLab } from "./testing/store.ts";

function service() {
	const lab = storeLab();
	const opened: string[] = [];
	const commands = createCommandService({
		registry: lab.registry,
		store: lab.store,
		openBar: (line) => opened.push(line),
	});
	return { lab, commands, opened };
}

describe("createCommandService", () => {
	it("parses and completes against the lab as it is now", async () => {
		const { lab, commands } = service();
		expect(commands.parse("focus node1")).toMatchObject({
			message: expect.stringContaining("No machine called node1"),
		});
		expect(commands.complete("rm ", 3).suggestions.map((s) => s.insert)).toEqual(["all"]);
		await lab.lab(1);
		expect(isLineError(commands.parse("focus node1"))).toBe(false);
		expect(commands.complete("rm ", 3).suggestions.map((s) => s.insert)).toEqual(["node1", "all"]);
	});

	it("runs a safe line as its source and logs it", async () => {
		const { lab, commands } = service();
		await lab.lab(2);
		expect(await commands.run("link down node2", "button")).toMatchObject({ kind: "visible" });
		expect(lab.store.state.log.at(-1)).toMatchObject({ line: "link down node2", source: "button", outcome: "ok" });
	});

	it("refuses a dangerous line, which needs a yes in the bar, and changes nothing", async () => {
		const { lab, commands } = service();
		await lab.lab(2);
		const logged = lab.store.state.log.length;
		expect(await commands.run("rm node2", "button")).toEqual({
			message: "rm node2 asks first, so it runs from the command bar once you say yes there. Nothing was changed.",
		});
		expect(lab.store.state.rail).toEqual(["node1", "node2"]);
		expect(lab.store.state.log).toHaveLength(logged);
	});

	it("returns the parse error for a line that does not parse", async () => {
		const { commands } = service();
		expect(await commands.run("linq up all", "bar")).toMatchObject({ fix: "link up all" });
	});

	it("opens the bar on a line to confirm it there", () => {
		const { commands, opened } = service();
		commands.confirmInBar("rm node3");
		expect(opened).toEqual(["rm node3"]);
	});
});
