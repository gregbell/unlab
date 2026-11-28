import "./app.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { focus, lab, mount, ready, spawn, unmountAll } from "../base/testing.ts";
import type { UnlabApp } from "./app.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

function mountApp() {
	return mount("unlab-app", {
		state: lab(spawn(3), ready(), focus("node2")),
		prepare: (element, services) => {
			element.services = services;
		},
	});
}

describe("<unlab-app>", () => {
	it("holds the desktop", async () => {
		await mountApp();
		await expect.element(page.getByRole("main", { name: "Lab desktop" })).toBeVisible();
	});

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
