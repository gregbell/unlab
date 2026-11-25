import "./rail.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import {
	fail,
	focus,
	LONG_NAME,
	lab,
	link,
	mount,
	park,
	power,
	ready,
	remove,
	type Step,
	spawn,
	spawnNamed,
	stopped,
	tick,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

function rowButton(name: string): HTMLButtonElement {
	const button = [...document.querySelectorAll<HTMLButtonElement>("unlab-machine-row button")].find(
		(candidate) => candidate.querySelector(".name")?.textContent === name,
	);
	if (!button) throw new Error(`no rail row for ${name}`);
	return button;
}

function part(button: HTMLElement, selector: string): HTMLElement {
	const found = button.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`no ${selector} in the row`);
	return found;
}

const colour = (element: Element): string => getComputedStyle(element).color;

describe("<unlab-machine-row> in each lifecycle and link state", () => {
	// node1 is the subject; node2 holds the keyboard so node1's row shows its resting colours.
	const cases: readonly {
		readonly state: string;
		readonly steps: readonly Step[];
		readonly word: string;
		readonly line2: string;
		readonly bar: string;
		readonly wordColour: string;
	}[] = [
		{
			state: "booting, cabled",
			steps: [spawn(2), tick(1400)],
			word: "booting 1.4 s",
			line2: "10.88.0.11",
			bar: "line-strong",
			wordColour: "text-2",
		},
		{
			state: "booting, unplugged",
			steps: [spawn(2, "none")],
			word: "booting 0.0 s",
			line2: "10.88.0.11",
			bar: "line-strong",
			wordColour: "text-2",
		},
		{ state: "ready, up", steps: [spawn(2), ready()], word: "up", line2: "10.88.0.11", bar: "hue-1", wordColour: "ok" },
		{
			state: "ready, cut",
			steps: [spawn(2), ready(), link("down", "node1")],
			word: "cut",
			line2: "10.88.0.11",
			bar: "hue-1",
			wordColour: "down",
		},
		{
			state: "ready, unplugged",
			steps: [spawn(2, "none"), ready()],
			word: "unplugged",
			line2: "10.88.0.11",
			bar: "hue-1",
			wordColour: "text-3",
		},
		{
			state: "powering off",
			steps: [spawn(2), ready(), power("off", "node1")],
			word: "powering off",
			line2: "10.88.0.11",
			bar: "line-strong",
			wordColour: "text-2",
		},
		{
			state: "rebooting",
			steps: [spawn(2), ready(), power("reboot", "node1")],
			word: "rebooting",
			line2: "10.88.0.11",
			bar: "line-strong",
			wordColour: "text-2",
		},
		{
			state: "off",
			steps: [spawn(2), ready(), power("off", "node1"), stopped("node1")],
			word: "off",
			line2: "10.88.0.11",
			bar: "line-strong",
			wordColour: "text-3",
		},
		{
			state: "failed",
			steps: [spawn(2), fail("node1")],
			word: "failed",
			line2: "did not boot",
			bar: "down",
			wordColour: "down",
		},
		{
			state: "removing, was up",
			steps: [spawn(2), ready(), remove("node1")],
			word: "removing",
			line2: "10.88.0.11",
			bar: "hue-1",
			wordColour: "text",
		},
		{
			state: "removing, was cut",
			steps: [spawn(2), ready(), link("down", "node1"), remove("node1")],
			word: "removing",
			line2: "10.88.0.11",
			bar: "hue-1",
			wordColour: "text",
		},
		{
			state: "removing, was unplugged",
			steps: [spawn(2, "none"), ready(), remove("node1")],
			word: "removing",
			line2: "10.88.0.11",
			bar: "hue-1",
			wordColour: "text",
		},
	];

	it.each(cases)("$state: says $word, with a $bar bar", async ({ steps, word, line2, bar, wordColour }) => {
		await mount("unlab-rail", { state: lab(...steps, focus("node2")) });
		const row = rowButton("node1");
		expect(row.hasAttribute("aria-current")).toBe(false);
		expect(part(row, ".word").textContent).toBe(word);
		expect(part(row, ".line2").textContent).toBe(line2);
		expect(getComputedStyle(row).borderLeftColor).toBe(tokenColor(bar));
		expect(colour(part(row, ".word"))).toBe(tokenColor(wordColour));
		expect(colour(part(row, ".name"))).toBe(tokenColor("hue-1"));
		expect(getComputedStyle(part(row, ".name")).fontWeight).toBe("500");
	});

	it("is 46px high with a 3px bar, the second line and word at 11px", async () => {
		await mount("unlab-rail", { state: lab(spawn(1), ready()) });
		const row = rowButton("node1");
		expect(row.getBoundingClientRect().height).toBe(46);
		expect(getComputedStyle(row).borderLeftWidth).toBe("3px");
		expect(getComputedStyle(part(row, ".line2")).fontSize).toBe("11px");
		expect(getComputedStyle(part(row, ".word")).fontSize).toBe("11px");
	});

	it("shows a leaving machine at half strength and runs nothing when clicked", async () => {
		const { runs } = await mount("unlab-rail", { state: lab(spawn(1), ready(), remove("node1")) });
		const row = rowButton("node1");
		expect(getComputedStyle(row).opacity).toBe("0.5");
		expect(row.disabled).toBe(true);
		row.click();
		expect(runs).toEqual([]);
	});

	it("fills the row with the keyboard with --line and marks it current", async () => {
		await mount("unlab-rail", { state: lab(spawn(2), ready(), focus("node2")) });
		expect(getComputedStyle(rowButton("node2")).backgroundColor).toBe(tokenColor("line"));
		expect(rowButton("node2").getAttribute("aria-current")).toBe("true");
		expect(getComputedStyle(rowButton("node1")).backgroundColor).toBe("rgba(0, 0, 0, 0)");
	});

	it("lifts the greys on the row with the keyboard, where --text-3 on --line falls under 4.5:1", async () => {
		await mount("unlab-rail", { state: lab(spawn(1, "none"), ready(), focus("node1")) });
		const row = rowButton("node1");
		expect(colour(part(row, ".line2"))).toBe(tokenColor("text-2"));
		expect(colour(part(row, ".word"))).toBe(tokenColor("text-2"));
	});

	it("keeps a leaving row in full text even with the keyboard", async () => {
		await mount("unlab-rail", { state: lab(spawn(1), ready(), focus("node1"), remove("node1")) });
		expect(colour(part(rowButton("node1"), ".word"))).toBe(tokenColor("text"));
		expect(colour(part(rowButton("node1"), ".line2"))).toBe(tokenColor("text"));
	});

	it("says parked on the second line of a parked machine", async () => {
		await mount("unlab-rail", { state: lab(spawn(2), ready(), park("node1")) });
		expect(part(rowButton("node1"), ".line2").textContent).toBe("10.88.0.11 · parked");
		expect(part(rowButton("node2"), ".line2").textContent).toBe("10.88.0.12");
	});

	it("runs `focus <name>` as a button when clicked", async () => {
		const { runs } = await mount("unlab-rail", { state: lab(spawn(3), ready()) });
		await page.getByRole("button", { name: /^node2/ }).click();
		expect(runs).toEqual([{ line: "focus node2", source: "button" }]);
	});

	it("follows the store: a booting row turns ready in place", async () => {
		const { store, settle } = await mount("unlab-rail", { state: lab(spawn(1)) });
		const before = rowButton("node1");
		store.dispatchRuntime({ type: "vm/ready", machine: "node1", attempt: 1, bootMs: 3582 });
		await settle();
		expect(rowButton("node1")).toBe(before);
		expect(part(before, ".word").textContent).toBe("up");
	});
});

describe("<unlab-rail>", () => {
	it("heads the list with the machine count and names each row by what it shows", async () => {
		await mount("unlab-rail", { state: lab(spawn(3), ready()) });
		await expect.element(page.getByRole("heading", { name: "machines 3" })).toBeVisible();
		expect(page.getByRole("list").getByRole("listitem").all()).toHaveLength(3);
		await expect.element(page.getByRole("button", { name: "node1 10.88.0.11 up" })).toBeVisible();
	});

	it("says nothing has booted in an empty lab", async () => {
		await mount("unlab-rail");
		await expect.element(page.getByRole("heading", { name: "machines 0" })).toBeVisible();
		await expect.element(page.getByText("Nothing booted yet.")).toBeVisible();
		expect(document.querySelector("unlab-machine-details")?.hidden).toBe(true);
	});

	it("lists machines in spawn order", async () => {
		await mount("unlab-rail", { state: lab(spawn(3), ready()) });
		const names = [...document.querySelectorAll("unlab-machine-row .name")].map((name) => name.textContent);
		expect(names).toEqual(["node1", "node2", "node3"]);
	});
});

describe("the empty rail", () => {
	it("names switch0 at its foot while there is no dock, and drops it once a machine exists", async () => {
		const empty = await mount("unlab-rail");
		const lines = [...empty.element.querySelectorAll(".switch span, .switch p:last-child")].map((n) => n.textContent);
		expect(lines).toEqual(["switch0", "0 of 8 ports", "L2 · 10.88.0.0/24"]);
		unmountAll();

		const one = await mount("unlab-rail", { state: lab(spawn(1)) });
		expect(one.element.querySelector(".switch")).toBeNull();
	});
});

describe("a machine with a long name", () => {
	it("is cut short in its row, with the whole name at hand, and the details show all of it", async () => {
		const { element } = await mount("unlab-rail", {
			state: lab(spawnNamed(LONG_NAME), ready()),
			prepare: (el) => {
				el.style.width = "232px";
			},
		});
		const row = rowButton(LONG_NAME);
		const name = part(row, ".name");
		expect(name.title).toBe(LONG_NAME);
		expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(part(row, ".word").getBoundingClientRect().left);
		expect(row.getBoundingClientRect().height).toBe(46);
		expect(element.scrollWidth).toBe(element.clientWidth);
		const heading = document.querySelector("unlab-machine-details .name");
		expect(heading?.textContent).toBe(LONG_NAME);
		expect(heading?.scrollWidth).toBeLessThanOrEqual(heading?.clientWidth ?? 0);
	});
});
