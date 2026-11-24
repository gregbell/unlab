import "./parked-strip.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { focus, lab, mount, park, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1200, 800));
afterEach(unmountAll);

const chips = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>("unlab-parked-strip .chip")];

describe("<unlab-parked-strip>", () => {
	it("is absent while nothing is parked", async () => {
		const { element } = await mount("unlab-parked-strip", { state: lab(spawn(3), ready()) });
		expect(element.hidden).toBe(true);
		expect(element.getBoundingClientRect().height).toBe(0);
	});

	it("is 32px of --mantle with the label, one chip per parked pane in pane order, and the note", async () => {
		const { element } = await mount("unlab-parked-strip", {
			state: lab(spawn(4), ready(), park("node3"), park("node1")),
		});
		expect(element.hidden).toBe(false);
		expect(element.getBoundingClientRect().height).toBe(32);
		expect(getComputedStyle(element).backgroundColor).toBe(tokenColor("glass-panel"));
		expect(element.querySelector(".label")?.textContent).toBe("parked");
		expect(chips().map((chip) => chip.textContent?.trim())).toEqual(["node1", "node3"]);
		expect(element.querySelector(".note")?.textContent).toBe("Still running. Click to bring it back.");
		await expect
			.element(page.getByRole("button", { name: "node3" }))
			.toHaveAccessibleDescription("Still running. Click to bring it back.");
	});

	it("edges each chip with a 3px rule in its machine's hue and names it in the hue", async () => {
		await mount("unlab-parked-strip", { state: lab(spawn(3), ready(), park("node2")) });
		const [chip] = chips();
		if (!chip) throw new Error("no chip");
		const style = getComputedStyle(chip);
		expect([style.borderLeftWidth, style.borderLeftColor, style.color]).toEqual([
			"3px",
			tokenColor("hue-2"),
			tokenColor("hue-2"),
		]);
		expect(chip.getBoundingClientRect().height).toBe(24);
	});

	it("brings a pane back and gives it the keyboard when its chip is clicked, then goes away", async () => {
		const { element, store, settle } = await mount("unlab-parked-strip", {
			state: lab(spawn(2), ready(), focus("node1"), park("node2")),
		});
		await page.getByRole("button", { name: "node2" }).click();
		await settle();
		expect(store.state.panes.parked.node2).toBeUndefined();
		expect(store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
		expect(element.hidden).toBe(true);
	});
});
