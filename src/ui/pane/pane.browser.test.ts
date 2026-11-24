import "../pane-area/pane-area.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LabState, MachineName } from "../../model/index.ts";
import {
	fail,
	focus,
	LONG_NAME,
	lab,
	link,
	mount,
	ready,
	remove,
	type Step,
	spawn,
	spawnNamed,
	tick,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";
import { fakeTerminals } from "../terminal/testing.ts";
import type { UnlabPane } from "./pane.ts";

beforeEach(() => page.viewport(1600, 1000));
afterEach(unmountAll);

async function mountPanes(state: LabState) {
	const terminals = fakeTerminals();
	const mounted = await mount("unlab-pane-area", {
		state,
		terminals: terminals.service,
		prepare: (element) => {
			element.style.width = "1300px";
			element.style.height = "500px";
		},
	});
	return { ...mounted, terminals };
}

function paneOf(machine: MachineName): UnlabPane {
	const pane = document.querySelector<UnlabPane>(`unlab-pane[machine="${machine}"]`);
	if (!pane) throw new Error(`no pane for ${machine}`);
	return pane;
}

function part(machine: MachineName, selector: string): HTMLElement {
	const found = paneOf(machine).querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`no ${selector} in the ${machine} pane`);
	return found;
}

const style = (machine: MachineName, selector: string): CSSStyleDeclaration =>
	getComputedStyle(part(machine, selector));
const word = (machine: MachineName): string => part(machine, ".word").textContent?.trim() ?? "";
const tabs = (machine: MachineName): string[] =>
	[...paneOf(machine).querySelectorAll("[role=tab]")].map((tab) => tab.textContent?.trim() ?? "");

/** A shell on node1, opened and selected. */
const SHELL: readonly Step[] = [
	spawn(2),
	ready(),
	focus("node1"),
	{ type: "cmd/shell", machine: "node1" },
	{ type: "session/opened", session: "node1:sh1" },
];
const withShell = (): LabState => lab(...SHELL);

describe("<unlab-pane> anatomy", () => {
	it("moves the outline with the active terminal without resizing the panes", async () => {
		const { store, settle } = await mountPanes(lab(spawn(2), ready(), focus("node1")));
		const first = paneOf("node1");
		const second = paneOf("node2");
		const before = second.getBoundingClientRect();
		expect(getComputedStyle(first).outlineColor).toBe(tokenColor("hue-1"));
		expect(getComputedStyle(first).outlineWidth).toBe("1px");
		expect(getComputedStyle(second).outlineStyle).toBe("none");

		await userEvent.click(page.getByRole("tablist", { name: "Sessions on node2" }));
		expect(getComputedStyle(first).outlineStyle).toBe("none");
		expect(getComputedStyle(second).outlineColor).toBe(tokenColor("hue-2"));
		expect(getComputedStyle(second).outlineWidth).toBe("1px");
		expect(second.getBoundingClientRect().toJSON()).toEqual(before.toJSON());

		store.dispatchUi({ type: "ui/bar", open: true });
		await settle();
		expect(document.querySelector("unlab-pane[focused]")).toBeNull();
	});

	it("sizes the header to 32px, padded 14px left and 6px right", async () => {
		await mountPanes(lab(spawn(1), ready()));
		const header = part("node1", ".header").getBoundingClientRect();
		expect(header.height).toBe(32);
		expect([style("node1", ".header").paddingLeft, style("node1", ".header").paddingRight]).toEqual(["14px", "6px"]);
	});

	it("sets the name at 12px and 500 in the hue, 8px before the first tab", async () => {
		await mountPanes(lab(spawn(2), ready()));
		const name = style("node2", ".name");
		expect([name.fontSize, name.fontWeight, name.color, name.marginRight]).toEqual([
			"12px",
			"500",
			tokenColor("hue-2"),
			"8px",
		]);
	});

	it("aligns the selected tab's underline with the lower edge of the title bar", async () => {
		await mountPanes(withShell());
		expect(tabs("node1")).toEqual(["console", "sh1"]);
		const [consoleTab, shellTab] = [...paneOf("node1").querySelectorAll<HTMLElement>("[role=tab]")];
		if (!consoleTab || !shellTab) throw new Error("no tabs");
		expect(shellTab.getBoundingClientRect().bottom).toBe(part("node1", ".header").getBoundingClientRect().bottom);
		const active = getComputedStyle(shellTab);
		expect([active.color, active.borderBottomWidth, active.borderBottomColor, active.paddingLeft]).toEqual([
			tokenColor("text"),
			"2px",
			tokenColor("hue-1"),
			"8px",
		]);
		expect(getComputedStyle(consoleTab).color).toBe(tokenColor("text-3"));
	});

	it("gives maximise and park 26px square buttons with 12px icons at 1.25px and names", async () => {
		await mountPanes(lab(spawn(1), ready()));
		for (const name of ["Maximise node1", "Park node1"]) {
			const button = page.getByRole("button", { name }).element();
			const box = button.getBoundingClientRect();
			expect([box.width, box.height], name).toEqual([26, 26]);
			const icon = button.querySelector("svg");
			expect(icon?.getBoundingClientRect().width).toBe(12);
			expect(icon && getComputedStyle(icon).strokeWidth).toBe("1.25px");
			expect(getComputedStyle(button).color).toBe(tokenColor("text-3"));
		}
	});
});

describe("<unlab-pane> right side of the header", () => {
	it("shows the address at 11px in --text-3 once ready", async () => {
		await mountPanes(lab(spawn(2), ready()));
		expect(word("node2")).toBe("10.88.0.12");
		const right = style("node2", ".word");
		expect([right.fontSize, right.color]).toEqual(["11px", tokenColor("text-3")]);
	});

	it("counts the boot in tenths, with no new-shell button and no other tab", async () => {
		const { store, settle } = await mountPanes(lab(spawn(1), tick(1400)));
		expect(word("node1")).toBe("booting 1.4 s");
		expect(style("node1", ".word").color).toBe(tokenColor("text-2"));
		expect(page.getByRole("button", { name: "New shell on node1" }).query()).toBeNull();
		store.dispatchRuntime({ type: "tick", now: 2050 });
		await settle();
		expect(word("node1")).toBe("booting 2.0 s");
	});

	it("says cable cut in --down", async () => {
		await mountPanes(lab(spawn(2), ready(), link("down", "node2")));
		expect(word("node2")).toBe("cable cut");
		expect(style("node2", ".word").color).toBe(tokenColor("down"));
		expect(word("node1")).toBe("10.88.0.11");
	});

	it("shows the agent legend only while the agent panel is open and the pane holds agent lines", async () => {
		const { store, settle } = await mountPanes(lab(spawn(2), ready()));
		const legend = () => paneOf("node1").querySelector(".legend")?.textContent?.trim() ?? null;
		store.dispatchRuntime({ type: "session/marked", session: "node1:console", source: "agent" });
		await settle();
		expect(legend()).toBeNull();
		store.dispatchUi({ type: "ui/agent-panel", open: true });
		await settle();
		expect(legend()).toBe("blue rule: sent by the agent");
		expect(paneOf("node2").querySelector(".legend")).toBeNull();
		expect(word("node1")).toBe("10.88.0.11");
	});
});

describe("<unlab-pane> failed and removing", () => {
	it("keeps the log of a failed machine and offers Boot again and Remove under it", async () => {
		const { runs, confirms, terminals } = await mountPanes(
			lab(spawn(2), ready("node2"), fail("node1", "No prompt after 120 s.")),
		);
		expect(word("node1")).toBe("failed");
		expect(style("node1", ".word").color).toBe(tokenColor("down"));
		expect(part("node1", ".headline").textContent).toBe("node1 did not boot.");
		expect(style("node1", ".headline").color).toBe(tokenColor("down"));
		expect(part("node1", ".reason").textContent).toBe("No prompt after 120 s.");
		expect(terminals.host("node1:console").visible.at(-1)).toBe(true);
		expect(page.getByRole("button", { name: "New shell on node1" }).query()).toBeNull();

		await page.getByRole("button", { name: "Boot again" }).click();
		expect(runs).toEqual([{ line: "boot node1", source: "button" }]);
		await page.getByRole("button", { name: "Remove", exact: true }).click();
		expect(confirms).toEqual(["rm node1"]);
	});

	it("says Removing node4. and takes no input while a machine leaves", async () => {
		const { terminals } = await mountPanes(lab(spawn(4), ready(), remove("node4")));
		expect(part("node4", ".removing").textContent).toBe("Removing node4.");
		expect(word("node4")).toBe("removing");
		expect(paneOf("node4").inert).toBe(true);
		expect(terminals.host("node4:console").visible.at(-1)).toBe(false);
		expect(terminals.host("node4:console").mounts).toHaveLength(1);
	});
});

describe("<unlab-pane> sessions", () => {
	it("runs sh <machine> from the + button as a button", async () => {
		const { runs } = await mountPanes(lab(spawn(2), ready()));
		await page.getByRole("button", { name: "New shell on node2" }).click();
		expect(runs).toEqual([{ line: "sh node2", source: "button" }]);
	});

	it("names the tab row, each tab's panel, and which tab is selected", async () => {
		await mountPanes(withShell());
		const list = page.getByRole("tablist", { name: "Sessions on node1" });
		await expect.element(list).toBeVisible();
		const shell = page.getByRole("tab", { name: "sh1" });
		await expect.element(shell).toHaveAttribute("aria-selected", "true");
		await expect.element(page.getByRole("tab", { name: "console" }).first()).toHaveAttribute("aria-selected", "false");
		const panel = page.getByRole("tabpanel", { name: "sh1" });
		await expect.element(panel).toBeVisible();
		expect(panel.element().querySelector("unlab-terminal")?.getAttribute("session")).toBe("node1:sh1");
	});

	it("marks a shell's panel busy until its pty is open", async () => {
		const { store, settle } = await mountPanes(lab(spawn(1), ready(), { type: "cmd/shell", machine: "node1" }));
		expect(part("node1", "#panel-node1-sh1").getAttribute("aria-busy")).toBe("true");
		expect(part("node1", "#panel-node1-console").getAttribute("aria-busy")).toBe("false");
		store.dispatchRuntime({ type: "session/opened", session: "node1:sh1" });
		await settle();
		expect(part("node1", "#panel-node1-sh1").getAttribute("aria-busy")).toBe("false");
	});

	it("switches tabs on click, hiding the other terminal without unmounting it", async () => {
		const { store, settle, terminals } = await mountPanes(withShell());
		const shell = paneOf("node1").querySelector('unlab-terminal[session="node1:sh1"]');
		await userEvent.click(part("node1", "#tab-node1-console"));
		await settle();
		expect(store.state.machines.node1?.activeSession).toBe("node1:console");
		expect(paneOf("node1").querySelector('unlab-terminal[session="node1:sh1"]')).toBe(shell);
		expect(part("node1", "#panel-node1-sh1").hidden).toBe(true);
		expect(terminals.host("node1:sh1").visible.at(-1)).toBe(false);
		expect(terminals.host("node1:console").visible.at(-1)).toBe(true);
		expect(document.activeElement).toBe(terminals.host("node1:console").input);
	});

	it("walks the tab row with the arrow keys, Home and End, and opens a tab with Enter", async () => {
		const { store, settle, terminals } = await mountPanes(
			lab(...SHELL, { type: "cmd/shell", machine: "node1" }, { type: "ui/tab-selected", session: "node1:console" }),
		);
		const tab = (label: string) => part("node1", `#tab-node1-${label}`);
		expect(tabs("node1")).toEqual(["console", "sh1", "sh2"]);
		expect([tab("console").tabIndex, tab("sh1").tabIndex, tab("sh2").tabIndex]).toEqual([0, -1, -1]);

		tab("console").focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(document.activeElement).toBe(tab("sh1"));
		await userEvent.keyboard("{ArrowRight}{ArrowRight}");
		expect(document.activeElement).toBe(tab("console"));
		await userEvent.keyboard("{ArrowLeft}");
		expect(document.activeElement).toBe(tab("sh2"));
		await userEvent.keyboard("{Home}");
		expect(document.activeElement).toBe(tab("console"));
		await userEvent.keyboard("{End}");
		expect(document.activeElement).toBe(tab("sh2"));
		expect(store.state.machines.node1?.activeSession).toBe("node1:console");

		await userEvent.keyboard("{Enter}");
		await settle();
		expect(store.state.machines.node1?.activeSession).toBe("node1:sh2");
		expect(document.activeElement).toBe(terminals.host("node1:sh2").input);
	});
});

describe("a machine with a long name", () => {
	it("is cut short in the header, which keeps its tabs, word and buttons", async () => {
		await mountPanes(lab(spawnNamed(LONG_NAME), spawn(5), ready(), { type: "cmd/shell", machine: LONG_NAME }));
		const header = part(LONG_NAME, ".header");
		const name = part(LONG_NAME, ".name");
		expect(name.title).toBe(LONG_NAME);
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
		expect(header.getBoundingClientRect().height).toBe(32);
		expect(header.scrollWidth).toBe(header.clientWidth);
		expect(part(LONG_NAME, ".tab").getBoundingClientRect().left).toBeGreaterThanOrEqual(
			name.getBoundingClientRect().right,
		);
		for (const button of paneOf(LONG_NAME).querySelectorAll(".icon")) {
			expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(header.getBoundingClientRect().right);
		}
	});
});
