import "./panel-bar.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { LabState } from "../../model/index.ts";
import { lab, link, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

const mountBar = (state: LabState = lab(spawn(2), ready())) => mount("unlab-panel-bar", { state });
const all = page.getByRole("button", { name: "All panels" });
const capture = page.getByRole("button", { name: "capture live" });
const faceplate = page.getByRole("button", { name: /^switch0/ });

function word(panel: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(`[data-panel="${panel}"] .word`);
	if (!found) throw new Error(`no word for ${panel}`);
	return found;
}

describe("<unlab-panel-bar>", () => {
	it("names every panel with its state, pressed while it is on show", async () => {
		await mountBar();
		await expect.element(capture).toHaveAttribute("aria-pressed", "true");
		await expect
			.element(page.getByRole("button", { name: "switch0 2 of 2 up" }))
			.toHaveAttribute("aria-pressed", "true");
		expect(getComputedStyle(word("capture")).color).toBe(tokenColor("ok"));
		expect(getComputedStyle(word("switch0")).color).toBe(tokenColor("text-2"));
	});

	it("parks a panel and shows it again by its name", async () => {
		const { store } = await mountBar();
		await faceplate.click();
		await expect.element(faceplate).toHaveAttribute("aria-pressed", "false");
		await expect.element(capture).toHaveAttribute("aria-pressed", "true");
		expect(store.state.panels.open).toEqual(["capture"]);
		await faceplate.click();
		expect(store.state.panels.open).toEqual(["capture", "switch0"]);
	});

	it("parks every panel from the arrow, and brings them back", async () => {
		const { store } = await mountBar();
		await expect.element(all).toHaveAttribute("aria-expanded", "true");
		await all.click();
		await expect.element(all).toHaveAttribute("aria-expanded", "false");
		expect(store.state.panels.open).toEqual([]);
		await all.click();
		expect(store.state.panels.open).toEqual(["capture", "switch0"]);
	});

	it("presses only the maximised panel", async () => {
		const { store, settle } = await mountBar();
		store.dispatchUi({ type: "ui/panel-maximised", panel: "switch0" });
		await settle();
		await expect.element(capture).toHaveAttribute("aria-pressed", "false");
		await expect.element(faceplate).toHaveAttribute("aria-pressed", "true");
	});

	it("says when the capture is paused and a cable is cut", async () => {
		const { store, settle } = await mountBar(lab(spawn(3), ready(), link("down", "node2")));
		store.dispatchUi({ type: "ui/capture-pause", paused: true });
		await settle();
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
