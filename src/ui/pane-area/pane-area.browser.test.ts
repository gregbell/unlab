import "./pane-area.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LabState, MachineName } from "../../model/index.ts";
import { focus, lab, mount, named, park, ready, spawn, spawnNamed, unmountAll } from "../base/testing.ts";
import type { UnlabPane } from "../pane/pane.ts";
import { fakeTerminals } from "../terminal/testing.ts";

beforeEach(() => page.viewport(1600, 1000));
afterEach(unmountAll);

interface Size {
	readonly width: number;
	readonly height: number;
}

/** 3 columns by 2 rows, 2 by 2, and 1 by 1: a pane is at least 400px wide and 200px high. */
const GRID_3X2: Size = { width: 1300, height: 500 };
const GRID_2X2: Size = { width: 900, height: 500 };
const GRID_1X1: Size = { width: 500, height: 300 };

async function mountArea(state: LabState, size: Size = GRID_3X2) {
	const terminals = fakeTerminals();
	const mounted = await mount("unlab-pane-area", {
		state,
		terminals: terminals.service,
		prepare: (element) => {
			element.style.width = `${size.width}px`;
			element.style.height = `${size.height}px`;
		},
	});
	await expect.poll(() => mounted.store.state.panes.grid).toEqual(gridOf(size));
	await mounted.settle();
	return { ...mounted, terminals };
}

function gridOf({ width, height }: Size) {
	return { cols: width >= 1200 ? 3 : width >= 800 ? 2 : 1, rows: height >= 400 ? 2 : 1 };
}

function paneOf(machine: MachineName): UnlabPane {
	const pane = document.querySelector<UnlabPane>(`unlab-pane[machine="${machine}"]`);
	if (!pane) throw new Error(`no pane for ${machine}`);
	return pane;
}

const visiblePanes = (): UnlabPane[] => [...document.querySelectorAll<UnlabPane>("unlab-pane:not([hidden])")];

/** Each visible pane's box as fractions of the area: x, y, width, height. */
function layout(): { readonly machine: string; readonly box: readonly number[] }[] {
	const area = document.querySelector("unlab-pane-area")?.getBoundingClientRect();
	if (!area) throw new Error("no pane area");
	return visiblePanes().map((pane) => {
		const r = pane.getBoundingClientRect();
		return {
			machine: pane.machine,
			box: [
				(r.left - area.left) / area.width,
				(r.top - area.top) / area.height,
				r.width / area.width,
				r.height / area.height,
			],
		};
	});
}

/** Ideal fractions can differ by the width of a gutter between tiles. */
function expectLayout(expected: readonly (readonly number[])[], size: Size): void {
	const actual = layout();
	expect(actual).toHaveLength(expected.length);
	actual.forEach(({ box }, i) => {
		const want = expected[i] ?? [];
		const px = [size.width, size.height, size.width, size.height];
		box.forEach((value, k) => {
			expect(Math.abs(value - (want[k] ?? Number.NaN)) * (px[k] ?? 0), `pane ${i + 1} edge ${k}`).toBeLessThanOrEqual(
				6,
			);
		});
	});
}

const third = 1 / 3;

/** The handoff's tiling table, as fractions of the area, in pane order. */
const TILINGS_3X2: Readonly<Record<number, readonly (readonly number[])[]>> = {
	1: [[0, 0, 1, 1]],
	2: [
		[0, 0, 0.5, 1],
		[0.5, 0, 0.5, 1],
	],
	3: [
		[0, 0, 0.6, 1],
		[0.6, 0, 0.4, 0.5],
		[0.6, 0.5, 0.4, 0.5],
	],
	4: [
		[0, 0, 0.5, 0.5],
		[0.5, 0, 0.5, 0.5],
		[0, 0.5, 0.5, 0.5],
		[0.5, 0.5, 0.5, 0.5],
	],
	5: [
		[0, 0, third, 0.5],
		[third, 0, third, 0.5],
		[2 * third, 0, third, 0.5],
		[0, 0.5, 0.5, 0.5],
		[0.5, 0.5, 0.5, 0.5],
	],
	6: [
		[0, 0, third, 0.5],
		[third, 0, third, 0.5],
		[2 * third, 0, third, 0.5],
		[0, 0.5, third, 0.5],
		[third, 0.5, third, 0.5],
		[2 * third, 0.5, third, 0.5],
	],
};

describe("<unlab-pane-area> tiling", () => {
	it.each([1, 2, 3, 4, 5, 6])("lays out %i panes on a three by two grid as the handoff's table", async (count) => {
		await mountArea(lab(spawn(count), ready()));
		expectLayout(TILINGS_3X2[count] ?? [], GRID_3X2);
		expect(visiblePanes().map((pane) => pane.machine)).toEqual(Array.from({ length: count }, (_, i) => `node${i + 1}`));
	});

	it("puts the three-pane split on the same 3:2 line as the dock", async () => {
		await mountArea(lab(spawn(3), ready()));
		const main = paneOf("node1").getBoundingClientRect();
		const stack = paneOf("node2").getBoundingClientRect();
		expect(main.width / (main.width + stack.width)).toBeCloseTo(0.6, 3);
	});

	it.each([
		[1, [[0, 0, 1, 1]]],
		[
			2,
			[
				[0, 0, 0.5, 1],
				[0.5, 0, 0.5, 1],
			],
		],
		// Under 1200px a 2/5 stack would be narrower than 400px, so main and stack split evenly.
		[
			3,
			[
				[0, 0, 0.5, 1],
				[0.5, 0, 0.5, 0.5],
				[0.5, 0.5, 0.5, 0.5],
			],
		],
		[4, TILINGS_3X2[4] ?? []],
		[5, TILINGS_3X2[4] ?? []],
		[6, TILINGS_3X2[4] ?? []],
	] as const)("lays out %i machines on a two by two grid, four at most", async (count, expected) => {
		await mountArea(lab(spawn(count), ready()), GRID_2X2);
		expectLayout(expected, GRID_2X2);
		expect(document.querySelectorAll("unlab-pane[hidden]")).toHaveLength(Math.max(0, count - 4));
	});

	it.each([1, 3, 6])("shows one of %i machines over the whole area on a one by one grid", async (count) => {
		await mountArea(lab(spawn(count), ready()), GRID_1X1);
		expectLayout([[0, 0, 1, 1]], GRID_1X1);
		expect(document.querySelectorAll("unlab-pane")).toHaveLength(count);
	});

	it("parks and brings back panes as the area crosses a size that changes capacity", async () => {
		const { element, store } = await mountArea(lab(spawn(6), ready(), focus("node2")));
		element.style.width = `${GRID_2X2.width}px`;
		await expect.poll(() => visiblePanes().length).toBe(4);
		expect(visiblePanes().map((pane) => pane.machine)).toContain("node2");
		element.style.width = `${GRID_3X2.width}px`;
		await expect.poll(() => visiblePanes().length).toBe(6);
		expect(store.state.panes.grid).toEqual({ cols: 3, rows: 2 });
	});

	it("does not tile for zero while the lab is hidden under another view", async () => {
		const { element, store } = await mountArea(lab(spawn(4), ready()));
		element.style.display = "none";
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(store.state.panes.grid).toEqual({ cols: 3, rows: 2 });
		expect(visiblePanes()).toHaveLength(4);
	});

	it("keeps creation order in the DOM when focus --main moves a pane to the front", async () => {
		const { store, settle } = await mountArea(lab(spawn(3), ready()));
		const before = [...document.querySelectorAll("unlab-pane")];
		store.dispatchCommand({ type: "cmd/focus", target: "node3", mode: "main" });
		await settle();
		expect([...document.querySelectorAll("unlab-pane")]).toEqual(before);
		const main = paneOf("node3").getBoundingClientRect();
		const area = document.querySelector("unlab-pane-area")?.getBoundingClientRect();
		expect([main.left, main.top, main.height]).toEqual([area?.left, area?.top, area?.height]);
	});

	it("passes axe with panes in several states", async () => {
		const { element } = await mountArea(
			lab(spawn(4), ready("node1", "node2"), { type: "cmd/shell", machine: "node1" }),
		);
		const results = await axe.run(element);
		const failures = results.violations.flatMap((violation) =>
			violation.nodes.map((node) => `${violation.id} at ${node.target.join(" ")}: ${node.failureSummary}`),
		);
		expect(failures).toEqual([]);
	});
});

describe("<unlab-pane-area> parking and maximise", () => {
	it("hides a parked pane without unmounting it or its terminal", async () => {
		const { store, settle, terminals } = await mountArea(lab(spawn(3), ready()));
		const pane = paneOf("node1");
		const terminal = pane.querySelector("unlab-terminal");
		const host = terminals.host("node1:console");
		expect(host.visible.at(-1)).toBe(true);

		await page.getByRole("button", { name: "Park node1" }).click();
		await settle();
		expect(store.state.panes.parked.node1).toBe("user");
		expect(pane.hidden).toBe(true);
		expect(pane.isConnected).toBe(true);
		expect(host.visible.at(-1)).toBe(false);

		store.dispatchUi({ type: "ui/unpark", machine: "node1" });
		await settle();
		expect(paneOf("node1")).toBe(pane);
		expect(pane.querySelector("unlab-terminal")).toBe(terminal);
		expect(pane.hidden).toBe(false);
		expect(host.visible.at(-1)).toBe(true);
		expect(host.mounts).toHaveLength(1);
	});

	it("maximises from the button and restores the exact previous layout", async () => {
		const { store, settle } = await mountArea(lab(spawn(5), ready(), park("node4")));
		const before = layout();
		await page.getByRole("button", { name: "Maximise node2" }).click();
		await settle();
		expectLayout([[0, 0, 1, 1]], GRID_3X2);
		expect(visiblePanes().map((pane) => pane.machine)).toEqual(["node2"]);
		await expect.element(page.getByRole("button", { name: "Maximise node2" })).toHaveAttribute("aria-pressed", "true");
		expect(paneOf("node2").hasAttribute("maximised")).toBe(true);
		expect(store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });

		await page.getByRole("button", { name: "Maximise node2" }).click();
		await settle();
		expect(layout()).toEqual(before);
		expect(store.state.panes.parked).toEqual({ node4: "user" });
	});

	it("maximises and restores on a double-click in the header", async () => {
		const { settle } = await mountArea(lab(spawn(3), ready()));
		const name = paneOf("node3").querySelector(".name");
		if (!name) throw new Error("no name in the header");
		await userEvent.dblClick(name);
		await settle();
		expect(visiblePanes().map((pane) => pane.machine)).toEqual(["node3"]);
		await userEvent.dblClick(name);
		await settle();
		expect(visiblePanes()).toHaveLength(3);
	});
});

describe("<unlab-pane-area> keyboard", () => {
	it("puts DOM focus in the active terminal of the pane with the keyboard", async () => {
		const { store, settle, terminals } = await mountArea(lab(spawn(3), ready(), focus("node2")));
		expect(document.activeElement).toBe(terminals.host("node2:console").input);

		store.dispatchCommand({ type: "cmd/focus", target: "node3", mode: "plain" });
		await settle();
		expect(document.activeElement).toBe(terminals.host("node3:console").input);
		expect(terminals.host("node2:console").focused.at(-1)).toBe(false);
	});

	it("takes the keyboard when a pane is clicked", async () => {
		const { store, settle, terminals } = await mountArea(lab(spawn(2), ready(), focus("node1")));
		const name = paneOf("node2").querySelector(".name");
		if (!name) throw new Error("no name in the header");
		await userEvent.click(name);
		await settle();
		expect(store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(document.activeElement).toBe(terminals.host("node2:console").input);
	});

	it("takes the keyboard when focus lands in a terminal", async () => {
		const { store, settle, terminals } = await mountArea(lab(spawn(2), ready(), focus("node1")));
		terminals.host("node2:console").input.focus();
		await settle();
		expect(store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	it("never takes focus from the command bar, and gives it back when the bar closes", async () => {
		const { store, settle, terminals } = await mountArea(lab(spawn(2), ready(), focus("node1")));
		const bar = document.createElement("input");
		document.body.append(bar);
		try {
			bar.focus();
			store.dispatchUi({ type: "ui/bar", open: true });
			await settle();
			expect(document.activeElement).toBe(bar);
			expect(terminals.host("node1:console").focused.at(-1)).toBe(false);

			store.dispatchCommand({ type: "cmd/focus", target: "node2", mode: "plain" });
			await settle();
			expect(document.activeElement).toBe(bar);

			store.dispatchUi({ type: "ui/bar", open: false });
			await settle();
			expect(document.activeElement).toBe(terminals.host("node2:console").input);
		} finally {
			bar.remove();
		}
	});

	it("ignores keys in a booting pane: its terminal never keeps focus", async () => {
		const { store, settle, terminals } = await mountArea(lab(spawn(2), ready("node1"), focus("node1")));
		const booting = terminals.host("node2:console");
		booting.input.focus();
		await settle();
		expect(document.activeElement).not.toBe(booting.input);
		expect(store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(booting.focused).not.toContain(true);

		store.dispatchRuntime({ type: "vm/ready", machine: "node2", attempt: 1, bootMs: 3582 });
		await settle();
		expect(document.activeElement).toBe(booting.input);
	});
});

describe("<unlab-pane-area> when a name is used again", () => {
	it("gives the new machine a pane of its own, even when the old one was never rendered away", async () => {
		const web = named("web");
		const { store, settle, terminals } = await mountArea(lab(spawnNamed(web), ready()));
		const old = paneOf(web);
		const host = terminals.host(`${web}:console`);
		expect(host.mounts).toHaveLength(1);
		store.dispatchCommand({ type: "cmd/remove", machines: [web], cause: "bar" });
		store.dispatchRuntime({ type: "vm/stopped", machine: web, attempt: 1, clean: true, at: 0 });
		for (const event of spawnNamed(web)(store.state)) store.dispatchCommand(event);
		await settle();
		expect(paneOf(web)).not.toBe(old);
		expect(old.isConnected).toBe(false);
		expect(host.mounts).toHaveLength(2);
	});
});
