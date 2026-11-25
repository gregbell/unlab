import "./switch.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import {
	LONG_NAME,
	lab,
	link,
	mount,
	power,
	ready,
	remove,
	spawn,
	spawnNamed,
	stopped,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

/** node1 up, node2 cut, node3 booting, node4 being removed, ports 5 to 8 empty. */
const mixed = lab(spawn(4), ready("node1", "node2", "node4"), link("down", "node2"), remove("node4"));

function column(n: number): HTMLElement {
	const found = document.querySelector<HTMLElement>(`unlab-switch [data-port="${n}"]`);
	if (!found) throw new Error(`no column for port ${n}`);
	return found;
}

function part(element: HTMLElement, selector: string): HTMLElement {
	const found = element.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`no ${selector}`);
	return found;
}

const style = (element: Element) => getComputedStyle(element);

describe("<unlab-switch>", () => {
	it("reads switch0, its subnet and the link count in its header", async () => {
		const { element } = await mount("unlab-switch", { state: mixed, prepare: (el) => el.setAttribute("compact", "") });
		const header = part(element, ".header");
		expect(header.textContent?.replace(/\s+/g, " ").trim()).toBe("switch0 L2 · 10.88.0.0/24 1 of 3 links up");
		expect(style(part(header, ".links")).color).toBe(tokenColor("down"));
	});

	it("keeps the link count grey while no cable is cut", async () => {
		const { element } = await mount("unlab-switch", { state: lab(spawn(2), ready()) });
		const links = part(element, ".links");
		expect(links.textContent).toBe("2 of 2 links up");
		expect(style(links).color).toBe(tokenColor("text-3"));
	});

	it("draws eight equal columns, one per port", async () => {
		const { element } = await mount("unlab-switch", { state: mixed });
		const widths = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => column(n).getBoundingClientRect().width);
		expect(new Set(widths.map((w) => Math.round(w))).size).toBe(1);
		expect(element.querySelectorAll("[data-port]")).toHaveLength(8);
	});

	it("is one button per live column, named by what its click will do", async () => {
		await mount("unlab-switch", { state: mixed });
		const buttons = page.getByRole("button", { name: /cable/ });
		await expect.element(buttons.nth(0)).toHaveAccessibleName("Cut the cable from node1 to port 1");
		await expect.element(buttons.nth(1)).toHaveAccessibleName("Reconnect the cable from node2 to port 2");
		expect(document.querySelectorAll("unlab-switch .ports button")).toHaveLength(2);
	});

	it("cuts an up cable through the command service as a button", async () => {
		const { runs } = await mount("unlab-switch", { state: mixed });
		part(column(1), "button").click();
		expect(runs).toEqual([{ line: "link down node1", source: "button" }]);
	});

	it("reconnects a cut cable through the command service as a button", async () => {
		const { runs } = await mount("unlab-switch", { state: mixed });
		part(column(2), "button").click();
		expect(runs).toEqual([{ line: "link up node2", source: "button" }]);
	});

	it("tags each cable of a machine with several NICs, and cuts the one clicked", async () => {
		const { runs } = await mount("unlab-switch", { state: lab(spawn(1), spawn(1, "switch0", "switch0"), ready()) });
		expect(column(1).querySelector(".nic")).toBeNull();
		for (const [port, nic] of [
			[2, "eth0"],
			[3, "eth1"],
		] as const) {
			expect(part(column(port), ".name").textContent).toBe("node2");
			const tag = part(column(port), ".nic");
			expect(tag.textContent).toBe(nic);
			const [cable, at] = [part(column(port), ".cable"), tag].map((e) => e.getBoundingClientRect());
			expect(at.top).toBeGreaterThan(cable.top);
			expect(at.bottom).toBeLessThan(cable.bottom);
			expect(tag.scrollWidth).toBeLessThanOrEqual(column(port).clientWidth);
		}
		await expect
			.element(page.getByRole("button", { name: /cable/ }).nth(2))
			.toHaveAccessibleName("Cut the cable from node2:eth1 to port 3");
		part(column(3), "button").click();
		expect(runs).toEqual([{ line: "link down node2:eth1", source: "button" }]);
	});

	it("does nothing for a booting, removing or empty port", async () => {
		const { runs } = await mount("unlab-switch", { state: mixed });
		for (const n of [3, 4, 5]) {
			expect(column(n).querySelector("button")).toBeNull();
			column(n).click();
		}
		expect(runs).toEqual([]);
	});

	it("draws each state by its word, cable, light and colour", async () => {
		await mount("unlab-switch", { state: mixed });
		const cases = [
			{ port: 1, word: "up", wordColour: "ok", cable: "solid", cableColour: "hue-1", light: "ok" },
			{ port: 2, word: "cut", wordColour: "down", cable: "dashed", cableColour: "down", light: "line-strong" },
			{ port: 3, word: "boot", wordColour: "text-2", cable: "dotted", cableColour: "hue-3", light: "line-strong" },
			{ port: 4, word: "down", wordColour: "text-3", cable: "solid", cableColour: "hue-4", light: "line-strong" },
		] as const;
		for (const c of cases) {
			const col = column(c.port);
			expect(part(col, ".word").textContent, `port ${c.port}`).toBe(c.word);
			expect(style(part(col, ".word")).color, `port ${c.port} word`).toBe(tokenColor(c.wordColour));
			const cable = style(part(col, ".cable"));
			expect(cable.borderLeftStyle, `port ${c.port} cable`).toBe(c.cable);
			expect(cable.borderLeftWidth).toBe("2px");
			expect(cable.borderLeftColor, `port ${c.port} cable colour`).toBe(tokenColor(c.cableColour));
			expect(cable.height).toBe("40px");
			expect(style(part(col, ".light")).backgroundColor, `port ${c.port} light`).toBe(tokenColor(c.light));
			expect(style(part(col, ".name")).color, `port ${c.port} name`).toBe(tokenColor(`hue-${c.port}`));
		}
	});

	it("draws a machine that is off and one that is stopping, and cuts an off machine's cable", async () => {
		const { runs } = await mount("unlab-switch", {
			state: lab(spawn(2), ready(), power("off", "node1", "node2"), stopped("node1")),
		});
		const cases = [
			{ port: 1, word: "off", wordColour: "text-3", cable: "solid" },
			{ port: 2, word: "stop", wordColour: "text-2", cable: "dotted" },
		] as const;
		for (const c of cases) {
			const col = column(c.port);
			expect(part(col, ".word").textContent).toBe(c.word);
			expect(style(part(col, ".word")).color).toBe(tokenColor(c.wordColour));
			expect(style(part(col, ".cable")).borderLeftStyle).toBe(c.cable);
			expect(style(part(col, ".light")).backgroundColor).toBe(tokenColor("line-strong"));
		}
		expect(column(2).querySelector("button")).toBeNull();
		await page.getByRole("button", { name: "Cut the cable from node1 to port 1" }).click();
		expect(runs).toEqual([{ line: "link down node1", source: "button" }]);
	});

	it("shows an empty port as its number alone in a --line socket", async () => {
		await mount("unlab-switch", { state: mixed });
		const empty = column(5);
		expect(empty.textContent?.trim()).toBe("5");
		expect(empty.querySelector(".cable, .light, .word, .name")).toBeNull();
		expect(style(part(empty, ".socket")).borderTopColor).toBe(tokenColor("line"));
	});

	it("maximises and parks itself alone", async () => {
		const { store } = await mount("unlab-switch", { state: mixed });
		await page.getByRole("button", { name: "Maximise switch0" }).click();
		expect(store.state.panels).toMatchObject({ open: ["capture", "switch0"], maximised: "switch0" });
		await page.getByRole("button", { name: "Park switch0" }).click();
		expect(store.state.panels).toMatchObject({ open: ["capture"], maximised: null });
	});

	it("is 6px between columns in the dock, and 10px maximised, with the MAC table beside them", async () => {
		const { element, settle } = await mount("unlab-switch", {
			state: mixed,
			prepare: (el) => el.setAttribute("compact", ""),
		});
		const gap = () => column(2).getBoundingClientRect().left - column(1).getBoundingClientRect().right;
		expect(Math.round(gap())).toBe(6);
		expect(element.querySelector("unlab-mac-table")).toBeNull();
		expect(element.textContent).toContain("Click a cable to cut or reconnect it.");
		expect(part(column(1), ".socket").getBoundingClientRect().height).toBe(26);

		element.removeAttribute("compact");
		await settle();
		expect(Math.round(gap())).toBe(10);
		expect(element.textContent).toContain("Click a cable");
		const table = part(element, "unlab-mac-table").getBoundingClientRect();
		expect(table.left).toBeGreaterThan(column(8).getBoundingClientRect().right);
	});
});

describe("a narrow faceplate", () => {
	it.each([420, 240, 180])("keeps its header on one line at %ipx, with its buttons in it", async (width) => {
		const { element } = await mount("unlab-switch", {
			state: lab(spawn(8), ready()),
			prepare: (el) => {
				el.setAttribute("compact", "");
				el.style.width = `${width}px`;
			},
		});
		const header = part(element, ".header");
		expect(header.getBoundingClientRect().height).toBe(35);
		for (const button of header.querySelectorAll("button"))
			expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(header.getBoundingClientRect().right);
	});

	it("keeps every machine name whole and scrolls sideways instead", async () => {
		const { element } = await mount("unlab-switch", {
			state: lab(spawn(8), ready()),
			prepare: (el) => {
				el.setAttribute("compact", "");
				el.style.width = "300px";
			},
		});
		for (let n = 1; n <= 8; n++) {
			const name = part(column(n), ".name");
			expect(name.scrollWidth, `node${n} is not cut short`).toBeLessThanOrEqual(name.clientWidth);
		}
		const ports = part(element, ".ports");
		expect(ports.scrollWidth).toBeGreaterThan(ports.clientWidth);
		expect(getComputedStyle(ports).overflowX).toBe("auto");
	});
});

describe("a machine with a long name", () => {
	it("is cut short over its port, with the whole name at hand, and the columns stay equal", async () => {
		await mount("unlab-switch", {
			state: lab(spawnNamed(LONG_NAME), spawn(1), ready()),
			prepare: (el) => {
				el.setAttribute("compact", "");
				el.style.width = "420px";
			},
		});
		const name = part(column(1), ".name");
		expect(name.textContent).toBe(LONG_NAME);
		expect(column(1).title).toBe(LONG_NAME);
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		const widths = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => Math.round(column(n).getBoundingClientRect().width));
		expect(new Set(widths)).toEqual(new Set([44]));
	});
});
