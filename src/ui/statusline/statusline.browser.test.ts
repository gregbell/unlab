import "./statusline.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { StatusSegment } from "../../model/index.ts";
import { agentCall, fail, lab, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

function segment(key: StatusSegment["key"] | "engine"): HTMLElement {
	const found = document.querySelector<HTMLElement>(`unlab-statusline [data-key="${key}"]`);
	if (!found) throw new Error(`no ${key} segment`);
	return found;
}

const colour = (key: StatusSegment["key"] | "engine"): string => getComputedStyle(segment(key)).color;

describe("<unlab-statusline>", () => {
	it("is a 26px line of 11px segments, quiet while all is well", async () => {
		const { element } = await mount("unlab-statusline", { state: lab(spawn(3), ready()) });
		expect(element.getBoundingClientRect().height).toBe(26);
		expect(getComputedStyle(element).fontSize).toBe("11px");
		expect(getComputedStyle(element).backgroundColor).toBe("rgba(0, 0, 0, 0)");
		for (const key of ["machines", "sessions", "webmcp", "engine"] as const)
			expect(colour(key)).toBe(tokenColor("text-2"));
		expect(segment("machines").textContent).toBe("3 of 3 ready");
		expect(segment("engine").textContent).toBe("Built with unkernel.dev");
		await expect
			.element(page.getByRole("link", { name: "GitHub", exact: true }))
			.toHaveAttribute("href", "https://github.com/gregbell/unlab");
		const credit = page.getByRole("link", { name: "unkernel.dev", exact: true });
		await expect.element(credit).toHaveAttribute("href", "https://unkernel.dev/");
		await expect.element(credit).toHaveAttribute("target", "_blank");
	});

	it("puts machines and sessions on the left, WebMCP and the engine on the right", async () => {
		const { element } = await mount("unlab-statusline", { state: lab(spawn(3), ready()) });
		const right = segment("webmcp").getBoundingClientRect().left;
		for (const key of ["machines", "sessions"] as const) {
			expect(segment(key).getBoundingClientRect().right).toBeLessThan(right);
		}
		expect(segment("machines").getBoundingClientRect().left).toBe(element.getBoundingClientRect().left);
		expect(segment("engine").getBoundingClientRect().right).toBe(element.getBoundingClientRect().right);
	});

	it("turns the machines segment red while a machine has failed", async () => {
		await mount("unlab-statusline", { state: lab(spawn(2), ready("node1"), fail("node2")) });
		expect(segment("machines").textContent).toBe("1 of 2 ready, 1 failed");
		expect(colour("machines")).toBe(tokenColor("down"));
	});

	it("turns the WebMCP segment yellow while a call waits for a yes", async () => {
		const { store, settle } = await mount("unlab-statusline", { state: lab(spawn(3), ready()) });
		store.dispatchAgent(agentCall(1, "waiting"));
		await settle();
		expect(segment("webmcp").textContent).toBe("webmcp: 1 call waiting for you");
		expect(colour("webmcp")).toBe(tokenColor("warn"));
	});

	it("starts the panel bar where the panels start, and has none with nothing parked or over another view", async () => {
		const { element, store, settle } = await mount("unlab-statusline", { state: lab(spawn(2), ready()) });
		expect(document.querySelector("unlab-panel-bar")).toBeNull();
		store.dispatchUi({ type: "ui/panel-parked", panel: "capture" });
		await settle();
		const bar = document.querySelector("unlab-panel-bar");
		expect(bar?.getBoundingClientRect().left).toBe(element.getBoundingClientRect().left + 232 + 8);
		expect(element.getBoundingClientRect().height).toBe(26);
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await settle();
		expect(document.querySelector("unlab-panel-bar")).toBeNull();
		unmountAll();
		const empty = await mount("unlab-statusline", { state: lab() });
		empty.store.dispatchUi({ type: "ui/panel-parked", panel: "capture" });
		await empty.settle();
		expect(document.querySelector("unlab-panel-bar")).toBeNull();
	});
});
