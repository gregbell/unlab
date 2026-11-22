import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { isPlanError, type LabState, planSpawn } from "../../model/index.ts";
import { lab, mount, ready, spawn, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

function mountApp(state: LabState = lab()) {
	return mount("unlab-app", {
		state,
		prepare: (element, services) => {
			element.services = services;
		},
	});
}

function the(selector: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(`unlab-app ${selector}`);
	if (!found) throw new Error(`no ${selector} in the app`);
	return found;
}

const button = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });

describe("the empty lab", () => {
	it("takes the place of the panes and the dock while there are no machines", async () => {
		await mountApp();
		expect(the("unlab-start").hidden).toBe(false);
		expect(the("unlab-pane-area").hidden).toBe(true);
		expect(the(".dock").hidden).toBe(true);
		expect(the("unlab-rail").hidden).toBe(false);
		await expect.element(page.getByRole("heading", { name: "Boot some Linux." })).toBeVisible();
		expect(the("unlab-statusline").textContent).toMatch(/0 machines/);
		expect(the("unlab-rail").textContent).toMatch(/Nothing booted yet\./);
	});

	it("goes away with the first spawn, and comes back when the last machine is gone", async () => {
		const { store, settle } = await mountApp();
		const plan = planSpawn(store.state, 1, { image: "alpine", memMiB: 256, net: "switch0" });
		if (isPlanError(plan)) throw new Error(plan.kind);
		store.dispatchCommand({ type: "cmd/spawn", plan, at: 0 });
		await settle();
		expect(the("unlab-start").hidden).toBe(true);
		expect(the("unlab-pane-area").hidden).toBe(false);
		expect(the(".dock").hidden).toBe(false);

		store.dispatchCommand({ type: "cmd/remove", machines: ["node1"], cause: "bar" });
		await settle();
		expect(the("unlab-start").hidden).toBe(true);
		const attempt = store.state.machines.node1?.life.attempt ?? 1;
		store.dispatchRuntime({ type: "vm/stopped", machine: "node1", attempt });
		await settle();
		expect(the("unlab-start").hidden).toBe(false);
	});

	it("is not there in a lab with machines", async () => {
		await mountApp(lab(spawn(2), ready()));
		expect(the("unlab-start").hidden).toBe(true);
	});

	it("runs a starting point's line as a button", async () => {
		const { runs } = await mountApp();
		await button(/^2 on a switch/).click();
		expect(runs).toEqual([{ line: "spawn 2 alpine --net switch0", source: "button" }]);
	});

	it("lists the three starting points with the line each one runs", async () => {
		await mountApp();
		const points = [...document.querySelectorAll("unlab-start .starts li")].map((li) =>
			[...(li.querySelector("button")?.children ?? [])].map((cell) => cell.textContent),
		);
		expect(points).toEqual([
			["1 machine", "A shell and nothing else.", "spawn 1 alpine"],
			["2 on a switch", "Ping across and watch the frames.", "spawn 2 alpine --net switch0"],
			["3 and a cut cable", "Take one off the network. See who notices.", "spawn 3 alpine --net switch0"],
		]);
	});

	it("runs a typed line as if typed in the bar", async () => {
		const { runs } = await mountApp();
		const input = page.getByRole("textbox", { name: "Command" });
		await expect.element(input).toHaveValue("spawn 2 alpine --net switch0");
		await input.fill("spawn 1 alpine");
		await button("Run ↵").click();
		expect(runs).toEqual([{ line: "spawn 1 alpine", source: "bar" }]);
	});

	it("shows the command's own error on Run, and clears it on an edit", async () => {
		const { services, settle } = await mountApp();
		services.commands.run = async (line) => {
			const parsed = services.commands.parse(line);
			if ("message" in parsed) return parsed;
			throw new Error(`expected ${line} to fail`);
		};
		const input = page.getByRole("textbox", { name: "Command" });
		await input.fill("spawn 2 alpne");
		await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
		await button("Run ↵").click();
		await settle();
		await expect.element(page.getByRole("alert")).toBeVisible();
		expect(the("unlab-start .error p").textContent).toBe(
			"No image called alpne. You have alpine. Nothing was changed.",
		);
		await button("did you mean spawn 2 alpine").click();
		await settle();
		await expect.element(input).toHaveValue("spawn 2 alpine");
		await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
	});

	it("counts the WebMCP tools and opens the agent panel from See the tools", async () => {
		const { store, settle } = await mountApp();
		expect(the("unlab-start .agent").textContent).toMatch(/exposes 7 WebMCP tools/);
		await button("See the tools").click();
		await settle();
		expect(store.state.agentPanel).toBe(true);
	});

	it("sets its title at 28px on 36px", async () => {
		await mountApp();
		const title = getComputedStyle(the("unlab-start h1"));
		expect([title.fontSize, title.lineHeight, title.letterSpacing]).toEqual(["28px", "36px", "-0.4px"]);
	});

	it("passes axe", async () => {
		const { element } = await mountApp();
		const results = await axe.run(element);
		const failures = results.violations.flatMap((violation) =>
			violation.nodes.map((node) => `${violation.id} at ${node.target.join(" ")}: ${node.failureSummary}`),
		);
		expect(failures).toEqual([]);
	});
});
