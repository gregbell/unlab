import "./app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LabState } from "../../model/index.ts";
import {
	agentCall,
	fail,
	focus,
	lab,
	link,
	mount,
	park,
	ready,
	remove,
	spawn,
	tick,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";
import type { UnlabApp } from "./app.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

const threeReady = (): LabState => lab(spawn(3), ready(), focus("node2"));

/** node1 parked, node2 with the keyboard, node3 cut, node4 booting, node5 failed, node6 unplugged, node7 leaving. */
const everyState = (): LabState =>
	lab(
		spawn(5),
		spawn(1, "none"),
		spawn(1),
		ready("node1", "node2", "node3", "node6", "node7"),
		fail("node5"),
		link("down", "node3"),
		remove("node7"),
		focus("node2"),
		park("node1"),
		tick(1400),
	);

/** The Lab with five machines artboard: node2 focused with sh1, node3 cut, node4 booting 1.4 s, node5 parked, an agent active. */
const asPanesArtboard = (): LabState =>
	lab(
		spawn(5),
		ready("node1", "node2", "node3", "node5"),
		link("down", "node3"),
		{ type: "cmd/shell", machine: "node2" },
		(state) => [
			...state.rail.map((name) => ({ type: "session/opened" as const, session: `${name}:console` as const })),
			{ type: "session/opened", session: "node2:sh1" },
		],
		park("node5"),
		focus("node2"),
		tick(1400),
		agentCall(1),
	);

function mountApp(state: LabState = threeReady()) {
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

const box = (selector: string): DOMRect => the(selector).getBoundingClientRect();
const style = (selector: string): CSSStyleDeclaration => getComputedStyle(the(selector));

describe("<unlab-app> regions", () => {
	it("stacks a floating header, the body and a 26px status line over the full viewport", async () => {
		await mountApp();
		const top = box(".top-bar");
		const status = box("unlab-statusline");
		const body = box(".body");
		expect(top.top).toBe(8);
		expect(top.left).toBeCloseTo(17, 1);
		expect(top.height).toBe(36);
		expect(top.width).toBeCloseTo(1440 - 2 * top.left, 1);
		expect(status.height).toBe(26);
		expect(status.bottom).toBe(900 - 8);
		expect(box(".wordmark").left).toBe(box("unlab-rail").left);
		expect(box(".add-machines").right).toBe(box("main.centre").right);
		expect(status.left).toBe(top.left);
		expect(status.width).toBe(body.width);
		expect(body.top).toBe(top.bottom + 8);
		expect(status.top).toBe(body.bottom + 8);
		expect(style(".top-bar").backgroundColor).toBe("rgba(0, 0, 0, 0)");
	});

	it("splits the body into a 232px rail and the centre, with a wallpaper gutter", async () => {
		await mountApp();
		const rail = box("unlab-rail");
		const centre = box("main.centre");
		expect(Math.abs(rail.width - 232)).toBeLessThan(1);
		expect(centre.left).toBeCloseTo(rail.right + 8, 5);
		expect(centre.right).toBe(box(".body").right);
		expect(style(".body").backgroundColor).toBe("rgba(0, 0, 0, 0)");
		for (const selector of ["unlab-rail", "unlab-capture", "unlab-switch", "unlab-pane"]) {
			const panel = style(selector);
			expect(panel.backgroundColor, selector).toBe(tokenColor("glass-panel"));
			expect(panel.borderRadius, selector).toBe("0px");
			expect(panel.borderWidth, selector).toBe("0px");
		}
		expect(style("unlab-pane-area").backgroundColor).toBe("rgba(0, 0, 0, 0)");
	});

	it("keeps the rail at 216px or more on a narrow window", async () => {
		await page.viewport(800, 600);
		await mountApp();
		expect(box("unlab-rail").width).toBeGreaterThanOrEqual(216);
	});

	it.each([
		[1440, 3],
		[1680, 3],
		[1680, 5],
		[1680, 6],
	])("aligns the dock with the bottom row at %ipx with %i machines", async (width, count) => {
		await page.viewport(width, 900);
		await mountApp(lab(spawn(count), ready()));
		const last = box(`unlab-pane[machine=node${count}]`);
		const faceplate = box("unlab-switch[compact]");
		expect(faceplate.left).toBeCloseTo(last.left, 1);
		expect(faceplate.right).toBe(last.right);
		expect(faceplate.left - box("unlab-capture").right).toBe(8);
	});

	it("pads the rail header and machine details 14px left and right", async () => {
		await mountApp();
		for (const selector of ["unlab-rail .header", "unlab-machine-details"]) {
			expect(style(selector).paddingLeft, selector).toBe("14px");
			expect(style(selector).paddingRight, selector).toBe("14px");
		}
	});

	it("names its landmarks", async () => {
		await mountApp();
		await expect.element(page.getByRole("banner")).toBeVisible();
		await expect.element(page.getByRole("complementary", { name: "Machines" })).toBeVisible();
		await expect.element(page.getByRole("main")).toBeInTheDocument();
		await expect.element(page.getByRole("contentinfo")).toBeVisible();
	});

	it.each([
		["three ready machines", threeReady],
		["a machine in every state", everyState],
	])("passes axe with %s", async (_, build) => {
		const { element } = await mountApp(build());
		const results = await axe.run(element);
		const failures = results.violations.flatMap((violation) =>
			violation.nodes.map((node) => `${violation.id} at ${node.target.join(" ")}: ${node.failureSummary}`),
		);
		expect(failures).toEqual([]);
	});
});

describe("<unlab-app> top bar", () => {
	it("shows the two-tone unLAB wordmark beside the palette", async () => {
		await mountApp();
		const wordmark = style(".wordmark");
		expect([wordmark.height, wordmark.borderWidth, wordmark.fontSize]).toEqual(["36px", "0px", "17px"]);
		expect(wordmark.backgroundColor).toBe("rgba(0, 0, 0, 0)");
		expect(wordmark.color).toBe(tokenColor("text-2"));
		expect(style(".wordmark span").color).toBe(tokenColor("text"));
		expect(the(".wordmark").textContent?.trim()).toBe("unLAB");
		expect(box("unlab-command-bar").left).toBeGreaterThan(box(".wordmark").right);
	});

	it("rests the command field at 36px, as wide as 520px, with its label and shortcut", async () => {
		await mountApp();
		const field = box("unlab-command-bar");
		expect([field.height, field.width]).toEqual([36, 520]);
		const input = page.getByRole("combobox", { name: "Command" });
		await expect.element(input).toHaveAttribute("placeholder", "Command bar");
		await expect.element(input).toHaveAttribute("aria-keyshortcuts", "Control+/");
		expect(the("unlab-command-bar kbd").textContent).toBe("Ctrl+/");
	});

	it("never narrows the command field under 320px while it shares the bar", async () => {
		await page.viewport(1000, 700);
		await mountApp();
		const field = box("unlab-command-bar");
		expect(field.width).toBeGreaterThanOrEqual(320);
		expect(field.width).toBeLessThanOrEqual(520);
		expect(field.top + field.height / 2).toBeCloseTo(box(".top-bar").top + box(".top-bar").height / 2, 1);
	});

	it("places the borderless Add machines action at the far right", async () => {
		await mountApp();
		const add = page.getByRole("banner").getByRole("button", { name: "Add machines", exact: true });
		await expect.element(add).toBeVisible();
		const added = style(".add-machines");
		expect(box(".add-machines").right).toBe(box(".top-bar").right);
		expect(added.borderWidth).toBe("0px");
		expect(added.backgroundColor).toBe("rgba(0, 0, 0, 0)");
	});
});

describe("<unlab-app> views", () => {
	it("opens Add machines over the whole body, keeping the lab mounted", async () => {
		const { settle } = await mountApp();
		const rail = the("unlab-rail");
		await page.getByRole("banner").getByRole("button", { name: "Add machines", exact: true }).click();
		await settle();
		expect(the(".lab").hidden).toBe(true);
		expect(the(".spawn-view").hidden).toBe(false);
		expect(rail.isConnected).toBe(true);
		expect(the("unlab-rail")).toBe(rail);
	});

	it("returns to the lab from the wordmark", async () => {
		const { store, settle } = await mountApp();
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await settle();
		expect(the(".lab").hidden).toBe(true);
		await page.getByRole("button", { name: "unLAB, back to the lab" }).click();
		await settle();
		expect(store.state.view).toBe("lab");
		expect(the(".lab").hidden).toBe(false);
	});

	it("returns to the lab on Esc", async () => {
		const { store, settle } = await mountApp();
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await settle();
		await userEvent.keyboard("{Escape}");
		expect(store.state.view).toBe("lab");
	});

	it("opens and closes the agent panel from the footer, and closes it on Esc", async () => {
		const { store, settle } = await mountApp();
		const indicator = page.getByRole("contentinfo").getByRole("button", { name: /^webmcp:/ });
		await expect.element(indicator).toHaveAttribute("aria-expanded", "false");
		expect(the("#unlab-agent-panel").hidden).toBe(true);

		await indicator.click();
		await settle();
		await expect.element(indicator).toHaveAttribute("aria-expanded", "true");
		expect(the("#unlab-agent-panel").hidden).toBe(false);

		await indicator.click();
		await settle();
		expect(store.state.agentPanel).toBe(false);

		await indicator.click();
		await userEvent.keyboard("{Escape}");
		expect(store.state.agentPanel).toBe(false);
	});
});

describe("<unlab-app> panels", () => {
	const name = (panel: string) => page.getByRole("contentinfo").getByRole("button", { name: new RegExp(`^${panel}`) });

	it("gives a lone panel the whole width, and no panels gives the panes their height and gap", async () => {
		const { store, settle } = await mountApp();
		await expect.poll(() => store.state.panes.grid.cols).toBe(2);
		const open = box("unlab-pane-area").height;
		await name("switch0").click();
		await settle();
		expect(box("unlab-capture").width).toBe(box("main.centre").width);
		expect(document.querySelector("unlab-app unlab-switch")).toBeNull();
		expect(box("unlab-pane-area").height).toBeGreaterThanOrEqual(open);

		await name("capture").click();
		await settle();
		expect(the(".dock").hidden).toBe(true);
		expect(box("unlab-pane-area").bottom).toBe(box(".body").bottom);

		await page.getByRole("button", { name: "All panels" }).click();
		await settle();
		expect(box("unlab-pane-area").height).toBe(open);
	});

	it.each(["capture", "switch0"])(
		"parks %s from its own button, and its name in the bar takes the focus",
		async (panel) => {
			const { settle } = await mountApp();
			const park = page.getByRole("button", { name: `Park ${panel}` });
			the(`#unlab-dock [aria-label="Park ${panel}"]`).focus();
			await userEvent.keyboard("{Enter}");
			await settle();
			await expect.element(park).not.toBeInTheDocument();
			await expect.element(name(panel)).toHaveFocus();
			await userEvent.keyboard("{Enter}");
			await settle();
			await expect.element(park).toBeVisible();
		},
	);

	it("maximises one panel over the panes, beside the rail, and restores it on Esc", async () => {
		const { store, settle } = await mountApp();
		const pane = the("unlab-pane[machine=node2]");
		await page.getByRole("button", { name: "Maximise capture" }).click();
		await settle();
		expect(the(".panes").hidden).toBe(true);
		expect(document.querySelector("unlab-app unlab-switch")).toBeNull();
		expect(box("unlab-capture").height).toBe(box("main.centre").height);
		expect(box("unlab-rail").width).toBeGreaterThan(200);
		expect(the("unlab-capture unlab-frame-detail")).toBeTruthy();

		await userEvent.keyboard("{Escape}");
		await settle();
		expect(store.state.panels.maximised).toBeNull();
		expect(the(".panes").hidden).toBe(false);
		expect(the("unlab-pane[machine=node2]")).toBe(pane);
	});

	it("brings a machine's pane back from under a maximised panel when its rail row is chosen", async () => {
		const { store, runs } = await mountApp();
		store.dispatchUi({ type: "ui/panel-maximised", panel: "switch0" });
		await page
			.getByRole("complementary", { name: "Machines" })
			.getByRole("button", { name: /^node3/ })
			.click();
		expect(runs).toEqual([{ line: "focus node3", source: "button" }]);
	});

	it("keeps every panel header and the status line on one line", async () => {
		for (const width of [1280, 1462, 1920]) {
			unmountAll();
			await page.viewport(width, 827);
			await mountApp(lab(spawn(2), ready()));
			for (const toolbar of ["unlab-capture .toolbar", "unlab-switch .header"])
				expect(box(toolbar).height, `${toolbar} at ${width}`).toBe(35);
			expect(box("unlab-statusline").height, `status line at ${width}`).toBe(26);
		}
	});
});

describe("<unlab-app> announcements", () => {
	it("speaks through one polite live region", async () => {
		const { element } = await mountApp();
		const app: UnlabApp = element;
		app.announce("node4 ready");
		const region = page.getByRole("status");
		await expect.element(region).toHaveTextContent("node4 ready");
		expect(document.querySelectorAll("unlab-app [role=status], unlab-app [aria-live]")).toHaveLength(1);
		app.announce("node4 ready");
		expect(region.element().textContent).not.toBe("node4 ready");
		expect(region.element().textContent?.trim()).toBe("node4 ready");
	});
});

const shots: string | undefined = import.meta.env.VITE_UI_SHOTS;

describe.skipIf(!shots)("screenshots for comparing with the artboards", () => {
	async function shoot(name: string, state: LabState, target?: string, focused?: string): Promise<void> {
		await mountApp(state);
		if (focused) the(focused).focus();
		await document.fonts.ready;
		const path = `${shots}/${name}.png`;
		if (target) await page.elementLocator(the(target)).screenshot({ path });
		else await page.screenshot({ path });
	}

	it("the shell with three machines, node2 focused", () => shoot("shell-three", threeReady()));
	it("the shell with a machine in every state", () => shoot("shell-every-state", everyState()));
	it("the rail with a machine in every state", () => shoot("rail-every-state", everyState(), "unlab-rail"));
	it("the shell as the Panes artboard draws it", () => shoot("shell-panes", asPanesArtboard()));
	it("keyboard focus on a rail row and an action", async () => {
		await shoot("focus-row", threeReady(), "unlab-rail", "unlab-machine-row:nth-of-type(1) button");
		await shoot("focus-action", threeReady(), "unlab-rail", "unlab-machine-details .button.danger");
	});
	it("the empty lab", () => shoot("shell-empty", lab()));
});
