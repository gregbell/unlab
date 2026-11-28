import "./whats-new.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { isLineError } from "../../commands/index.ts";
import { lab, mount, ready, spawn, unmountAll } from "../base/testing.ts";
import { SEEN_KEY } from "./seen.ts";
import { UPDATES } from "./updates.ts";

beforeEach(async () => {
	localStorage.removeItem(SEEN_KEY);
	await page.viewport(1440, 900);
});
afterEach(() => {
	unmountAll();
	localStorage.removeItem(SEEN_KEY);
});

const mountList = () => mount("unlab-whats-new", { state: lab(spawn(1), ready()) });

const opener = page.getByText("What’s new", { exact: true });
const dot = (): Element | null => document.querySelector("unlab-whats-new .dot");
const fresh = (): number => document.querySelectorAll("unlab-whats-new .fresh").length;

describe("<unlab-whats-new>", () => {
	it("opens the updates, newest first, and links to the rest", async () => {
		const { element } = await mountList();
		const details = element.querySelector("details");
		expect(details?.open).toBe(false);
		await opener.click();
		expect(details?.open).toBe(true);
		const titles = [...document.querySelectorAll("unlab-whats-new .title")].map((title) => title.textContent);
		expect(titles).toHaveLength(UPDATES.length);
		expect(titles[0]).toContain(UPDATES[0]?.title);
		await expect
			.element(page.getByRole("link", { name: "Every change on GitHub" }))
			.toHaveAttribute("href", "https://github.com/gregbell/unlab/commits/main");
		await expect.element(page.getByRole("link", { name: "Pull request 19" })).toBeVisible();
		const { violations } = await axe.run(element);
		expect(violations.map(({ id, nodes }) => [id, nodes.map((node) => node.failureSummary)])).toEqual([]);
	});

	it("has a dot until the updates have been opened, and remembers that they were", async () => {
		const { settle } = await mountList();
		expect(dot()).not.toBeNull();
		await opener.click();
		await settle();
		expect(dot()).toBeNull();
		expect(fresh()).toBe(0);
		unmountAll();
		await mountList();
		expect(dot()).toBeNull();
	});

	it("marks what came after the last one this browser was shown", async () => {
		localStorage.setItem(SEEN_KEY, UPDATES[2]?.title ?? "");
		const { settle } = await mountList();
		expect(dot()).not.toBeNull();
		await opener.click();
		await settle();
		expect(fresh()).toBe(2);
	});
});

describe("the updates", () => {
	it("are newest first, each with a title of its own", () => {
		const dates = UPDATES.map(({ date }) => date);
		expect(dates).toEqual([...dates].sort().reverse());
		expect(new Set(UPDATES.map(({ title }) => title)).size).toBe(UPDATES.length);
	});

	it("show only lines the command bar takes", async () => {
		const images = [
			{ name: "alpine", label: "alpine 3.24" },
			{ name: "lab", label: "lab" },
		];
		const { services } = await mount("unlab-whats-new", { state: { ...lab(spawn(1), ready()), images } });
		for (const { example } of UPDATES) {
			if (example) expect(isLineError(services.commands.parse(example)), example).toBe(false);
		}
	});
});
