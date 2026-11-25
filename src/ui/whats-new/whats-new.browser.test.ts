import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { isLineError } from "../../commands/index.ts";
import { agentCall, lab, mount, ready, spawn, unmountAll } from "../base/testing.ts";
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

const mountApp = () =>
	mount("unlab-app", {
		state: lab(spawn(1), ready()),
		prepare: (element, services) => {
			element.services = services;
		},
	});

const opener = page.getByRole("contentinfo").getByRole("button", { name: /^What’s new/ });
const list = page.getByRole("dialog", { name: "What’s new" });
const dot = (): Element | null => document.querySelector("unlab-whats-new .dot");
const fresh = (): number => document.querySelectorAll("unlab-whats-new .fresh").length;

describe("<unlab-whats-new>", () => {
	it("opens the updates over the lab, newest first, and links to the rest", async () => {
		const { element } = await mountApp();
		await expect.element(list).not.toBeInTheDocument();
		await opener.click();
		await expect.element(list).toBeVisible();
		const titles = [...document.querySelectorAll("unlab-whats-new .title")].map((title) => title.textContent);
		expect(titles).toHaveLength(UPDATES.length);
		expect(titles[0]).toContain(UPDATES[0]?.title);
		await expect
			.element(list.getByRole("link", { name: "Every change on GitHub" }))
			.toHaveAttribute("href", "https://github.com/gregbell/unlab/commits/main");
		await expect.element(list.getByRole("link", { name: "Pull request 19" })).toBeVisible();
		const { violations } = await axe.run(element);
		expect(violations.map(({ id, nodes }) => [id, nodes.map((node) => node.failureSummary)])).toEqual([]);
	});

	it("has a dot until the updates have been opened, and remembers that they were", async () => {
		const { settle } = await mountApp();
		expect(dot()).not.toBeNull();
		await opener.click();
		await settle();
		expect(dot()).toBeNull();
		expect(fresh()).toBe(0);
		unmountAll();
		await mountApp();
		expect(dot()).toBeNull();
	});

	it("marks what came after the last one this browser was shown", async () => {
		localStorage.setItem(SEEN_KEY, UPDATES[2]?.title ?? "");
		const { settle } = await mountApp();
		expect(dot()).not.toBeNull();
		await opener.click();
		await settle();
		expect(fresh()).toBe(2);
	});

	it("closes on Esc alone, from anywhere in it, and gives the focus back", async () => {
		const { store } = await mountApp();
		store.dispatchUi({ type: "ui/panel-maximised", panel: "capture" });
		await opener.click();
		// A click on plain text leaves the focus on nothing.
		await list.getByText(UPDATES[0]?.detail ?? "").click();
		await userEvent.keyboard("{Escape}");
		await expect.element(list).not.toBeInTheDocument();
		expect(store.state.panels.maximised).toBe("capture");
		await expect.element(opener).toHaveFocus();
	});

	it("closes on its button and on a press beside it", async () => {
		await mountApp();
		await opener.click();
		await list.getByRole("button", { name: "Close" }).click();
		await expect.element(list).not.toBeInTheDocument();
		await opener.click();
		await userEvent.click(document.querySelector("unlab-whats-new dialog") as Element, { position: { x: -40, y: 20 } });
		await expect.element(list).not.toBeInTheDocument();
	});

	it("makes way for an agent's call that waits for a yes", async () => {
		const { store, settle } = await mountApp();
		await opener.click();
		store.dispatchAgent(agentCall(1, "waiting"));
		await settle();
		await expect.element(list).not.toBeInTheDocument();
		// Opened again, it stays open over a call it has made way for.
		await opener.click();
		await settle();
		await expect.element(list).toBeVisible();
	});

	it("leaves the command bar shut while it is open", async () => {
		await mountApp();
		await opener.click();
		await userEvent.keyboard("{Control>}/{/Control}");
		expect(document.querySelector("unlab-command-bar")?.hasAttribute("open")).toBe(false);
		await expect.element(list).toBeVisible();
	});

	it("fits a narrow, short window", async () => {
		await page.viewport(360, 480);
		await mountApp();
		await opener.click();
		const box = document.querySelector("unlab-whats-new dialog")?.getBoundingClientRect();
		expect(box?.left).toBeGreaterThanOrEqual(0);
		expect(box?.right).toBeLessThanOrEqual(360);
		expect(box?.top).toBeGreaterThanOrEqual(0);
		expect(box?.bottom).toBeLessThanOrEqual(480);
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
		const { services } = await mount("unlab-app", {
			state: { ...lab(spawn(1), ready()), images },
			prepare: (element, services) => {
				element.services = services;
			},
		});
		for (const { example } of UPDATES) {
			if (example) expect(isLineError(services.commands.parse(example)), example).toBe(false);
		}
	});
});
