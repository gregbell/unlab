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
	it("stacks a framed top bar, the body and a 26px status line over the full viewport", async () => {
		await mountApp();
		const top = box(".top-bar");
		const status = box("unlab-statusline");
		const body = box(".body");
		expect(top.top).toBeCloseTo(10.08, 1);
		expect(top.height).toBe(42);
		expect(top.width).toBeCloseTo(1440 - 2 * top.top, 1);
		expect(status.height).toBe(26);
		expect(status.bottom).toBeCloseTo(900 - top.top, 1);
		expect(status.width).toBe(top.width);
		expect(body.top).toBe(top.bottom + 6);
		expect(status.top).toBe(body.bottom + 6);
		expect(style(".top-bar").backgroundColor).toBe(tokenColor("glass-panel"));
	});

	it("splits the body into a 232px rail and the centre, with a wallpaper gutter", async () => {
		await mountApp();
		const rail = box("unlab-rail");
		const centre = box("main.centre");
		expect(Math.abs(rail.width - 232)).toBeLessThan(1);
		expect(centre.left).toBeCloseTo(rail.right + 6, 5);
		expect(centre.right).toBe(box(".top-bar").right);
		expect(style(".body").backgroundColor).toBe("rgba(0, 0, 0, 0)");
		expect(style("unlab-rail").backgroundColor).toBe(tokenColor("glass-panel"));
		expect(style("unlab-pane").backgroundColor).toBe(tokenColor("glass-terminal"));
		expect(style("unlab-pane-area").backgroundColor).toBe("rgba(0, 0, 0, 0)");
	});

	it("keeps the rail at 216px or more on a narrow window", async () => {
		await page.viewport(800, 600);
		await mountApp();
		expect(box("unlab-rail").width).toBeGreaterThanOrEqual(216);
	});

	it("pads every region 14px left and right", async () => {
		await mountApp();
		for (const selector of [".top-bar", "unlab-statusline", "unlab-rail .header", "unlab-machine-details"]) {
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
	it("sets the wordmark at 14px and 600 and the lab name in --text-3", async () => {
		await mountApp();
		const wordmark = style(".wordmark");
		expect([wordmark.fontSize, wordmark.fontWeight, wordmark.letterSpacing]).toEqual(["14px", "600", "-0.2px"]);
		expect(the(".lab-name").textContent).toBe("local lab");
		expect(style(".lab-name").color).toBe(tokenColor("text-3"));
	});

	it("rests the command field at 28px, as wide as 520px, with an example line and its shortcut", async () => {
		await mountApp();
		const field = box("unlab-command-bar");
		expect([field.height, field.width]).toEqual([28, 520]);
		const input = page.getByRole("combobox", { name: "Command" });
		await expect.element(input).toHaveAttribute("placeholder", "spawn 2 alpine --net switch0");
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

	it("makes Add machine the 28px primary button", async () => {
		await mountApp();
		const add = page.getByRole("banner").getByRole("button", { name: "Add machines" });
		const added = getComputedStyle(add.element());
		expect(add.element().getBoundingClientRect().height).toBe(28);
		expect([added.backgroundColor, added.color, added.fontWeight]).toEqual([
			tokenColor("text"),
			tokenColor("crust"),
			"600",
		]);
	});

	it("says no agent calls yet, then agent active beside a 6px blue square", async () => {
		const { store, settle } = await mountApp();
		const indicator = the(".agent-indicator");
		expect(indicator.textContent?.trim()).toBe("no agent calls yet");
		expect(getComputedStyle(indicator).color).toBe(tokenColor("text-3"));
		expect(indicator.querySelector(".square")).toBeNull();

		store.dispatchAgent(agentCall(1));
		await settle();
		expect(indicator.textContent?.trim()).toBe("agent active");
		expect(getComputedStyle(indicator).color).toBe(tokenColor("agent"));
		const square = indicator.querySelector(".square");
		expect(square?.getBoundingClientRect().width).toBe(6);
		expect(square?.getBoundingClientRect().height).toBe(6);
		expect(square && getComputedStyle(square).backgroundColor).toBe(tokenColor("agent"));
	});
});

describe("<unlab-app> views", () => {
	it("opens Add machines over the whole body, keeping the lab mounted", async () => {
		const { settle } = await mountApp();
		const rail = the("unlab-rail");
		await page.getByRole("banner").getByRole("button", { name: "Add machines" }).click();
		await settle();
		expect(the(".lab").hidden).toBe(true);
		expect(the(".spawn-view").hidden).toBe(false);
		expect(rail.isConnected).toBe(true);
		expect(the("unlab-rail")).toBe(rail);
	});

	it("returns to the lab from the wordmark", async () => {
		const { store, settle } = await mountApp();
		store.dispatchUi({ type: "ui/view", view: "wire" });
		await settle();
		expect(the(".lab").hidden).toBe(true);
		expect(the(".wire-view").hidden).toBe(false);
		await page.getByRole("button", { name: "unlab, back to the lab" }).click();
		await settle();
		expect(store.state.view).toBe("lab");
		expect(the(".lab").hidden).toBe(false);
		expect(the(".wire-view").hidden).toBe(true);
	});

	it("returns to the lab on Esc", async () => {
		const { store, settle } = await mountApp();
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await settle();
		await userEvent.keyboard("{Escape}");
		expect(store.state.view).toBe("lab");
	});

	it("opens and closes the agent panel from the indicator, and closes it on Esc", async () => {
		const { store, settle } = await mountApp();
		const indicator = page.getByRole("button", { name: "no agent calls yet" });
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

describe("<unlab-app> dock", () => {
	it("hides to one strip that gives the panes its height, and shows again, the focus staying on the toggle", async () => {
		const { settle } = await mountApp(lab(spawn(3), ready(), link("down", "node3")));
		const open = box("unlab-pane-area").height;
		const hide = page.getByRole("button", { name: "hide" });
		await expect.element(hide).toHaveAttribute("aria-expanded", "true");
		await expect.element(hide).toHaveAttribute("aria-controls", the(".dock").id);

		await hide.click();
		await settle();
		const show = page.getByRole("button", { name: "show" });
		await expect.element(show).toHaveFocus();
		await expect.element(show).toHaveAttribute("aria-expanded", "false");
		await expect.element(show).toHaveAttribute("aria-controls", the(".dock").id);
		expect(document.querySelector("unlab-app :is(unlab-capture, unlab-switch)")).toBeNull();
		expect(box(".dock").height).toBe(34);
		expect(box("unlab-pane-area").height).toBeGreaterThan(open + 150);

		await userEvent.keyboard("{Enter}");
		await settle();
		await expect.element(page.getByRole("button", { name: "hide" })).toHaveFocus();
		expect(box("unlab-pane-area").height).toBe(open);
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
