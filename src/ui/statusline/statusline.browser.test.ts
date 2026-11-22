import "./statusline.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { StatusSegment } from "../../model/index.ts";
import { agentCall, fail, lab, link, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

function segment(key: StatusSegment["key"]): HTMLElement {
	const found = document.querySelector<HTMLElement>(`unlab-statusline [data-key="${key}"]`);
	if (!found) throw new Error(`no ${key} segment`);
	return found;
}

const colour = (key: StatusSegment["key"]): string => getComputedStyle(segment(key)).color;

describe("<unlab-statusline>", () => {
	it("is a 26px line of 11px segments, quiet while all is well", async () => {
		const { element } = await mount("unlab-statusline", { state: lab(spawn(3), ready()) });
		expect(element.getBoundingClientRect().height).toBe(26);
		expect(getComputedStyle(element).fontSize).toBe("11px");
		expect(getComputedStyle(element).backgroundColor).toBe(tokenColor("crust"));
		expect(getComputedStyle(element).paddingInline).toBe("14px");
		for (const key of ["machines", "links", "webmcp", "engine"] as const)
			expect(colour(key)).toBe(tokenColor("text-3"));
		expect(segment("machines").textContent).toBe("3 of 3 machines ready");
		expect(segment("links").textContent).toBe("switch0: 3 of 3 links up");
		expect(segment("engine").textContent).toBe("unkernel / WebAssembly");
	});

	it("puts machines, sessions and links on the left, WebMCP and the engine on the right", async () => {
		const { element } = await mount("unlab-statusline", { state: lab(spawn(3), ready()) });
		const right = segment("webmcp").getBoundingClientRect().left;
		for (const key of ["machines", "sessions", "links"] as const) {
			expect(segment(key).getBoundingClientRect().right).toBeLessThan(right);
		}
		expect(segment("engine").getBoundingClientRect().right).toBe(element.getBoundingClientRect().right - 14);
	});

	it("turns the machines segment red while a machine has failed", async () => {
		await mount("unlab-statusline", { state: lab(spawn(2), ready("node1"), fail("node2")) });
		expect(segment("machines").textContent).toBe("1 of 2 machines ready, 1 failed");
		expect(colour("machines")).toBe(tokenColor("down"));
	});

	it("turns the links segment red while a cable is cut", async () => {
		await mount("unlab-statusline", { state: lab(spawn(3), ready(), link("down", "node2")) });
		expect(segment("links").textContent).toBe("switch0: 2 of 3 links up");
		expect(colour("links")).toBe(tokenColor("down"));
	});

	it("turns the WebMCP segment yellow while a call waits for a yes", async () => {
		const { store, settle } = await mount("unlab-statusline", { state: lab(spawn(3), ready()) });
		store.dispatchAgent(agentCall(1, "waiting"));
		await settle();
		expect(segment("webmcp").textContent).toBe("webmcp: 1 call waiting for you");
		expect(colour("webmcp")).toBe(tokenColor("warn"));
	});
});
