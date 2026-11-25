import "./panel-bar.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { LabState } from "../../model/index.ts";
import { addSwitch, lab, link, mount, ready, spawn, switchNamed, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

async function mountBar(state: LabState = lab(spawn(2), ready())) {
	const mounted = await mount("unlab-panel-bar", { state });
	const park = async (...panels: ("capture" | "switch0")[]) => {
		for (const panel of panels) mounted.store.dispatchUi({ type: "ui/panel-parked", panel });
		await mounted.settle();
	};
	return { ...mounted, park };
}

const names = (): (string | undefined)[] =>
	[...document.querySelectorAll<HTMLElement>("unlab-panel-bar button")].map((button) => button.dataset.panel);

function word(panel: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(`[data-panel="${panel}"] .word`);
	if (!found) throw new Error(`no word for ${panel}`);
	return found;
}

describe("<unlab-panel-bar>", () => {
	it("names only the parked panels, each with its state, in the order the panels have", async () => {
		const { park } = await mountBar();
		expect(names()).toEqual([]);
		await park("switch0");
		expect(names()).toEqual(["switch0"]);
		await park("capture");
		expect(names()).toEqual(["capture", "switch0"]);
		await expect.element(page.getByRole("button", { name: "capture live" })).toBeVisible();
		await expect.element(page.getByRole("button", { name: "switch0 2 of 2 up" })).toBeVisible();
		expect(getComputedStyle(word("capture")).color).toBe(tokenColor("ok"));
		expect(getComputedStyle(word("switch0")).color).toBe(tokenColor("text-2"));
	});

	it("brings a panel back by its name, which leaves the bar", async () => {
		const { store, park, settle } = await mountBar();
		await park("capture", "switch0");
		await page.getByRole("button", { name: /^switch0/ }).click();
		await settle();
		expect(store.state.panels.open).toEqual(["switch0"]);
		expect(names()).toEqual(["capture"]);
	});

	it("leaves out a panel that a maximised one covers", async () => {
		const { store, settle } = await mountBar();
		store.dispatchUi({ type: "ui/panel-maximised", panel: "switch0" });
		await settle();
		expect(names()).toEqual([]);
	});

	it("counts the links of every switch under one name when there are several", async () => {
		const lan = switchNamed("lan");
		const { park } = await mountBar(lab(addSwitch(lan), spawn(2), spawn(1, lan), ready(), link("down", "node3")));
		await park("switch0");
		await expect.element(page.getByRole("button", { name: "switches 2 of 3 up" })).toBeVisible();
		expect(getComputedStyle(word("switch0")).color).toBe(tokenColor("down"));
	});

	it("says when a parked capture is paused and a cable is cut", async () => {
		const { store, park } = await mountBar(lab(spawn(3), ready(), link("down", "node2")));
		store.dispatchUi({ type: "ui/capture-pause", paused: true });
		await park("capture", "switch0");
		expect([word("capture").textContent, getComputedStyle(word("capture")).color]).toEqual([
			"paused",
			tokenColor("warn"),
		]);
		expect([word("switch0").textContent, getComputedStyle(word("switch0")).color]).toEqual([
			"2 of 3 up",
			tokenColor("down"),
		]);
	});
});
