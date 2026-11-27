import "./switch.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { testCapture } from "../../../test/support/capture.ts";
import { ping } from "../../../test/support/frames.ts";
import type { PortNo } from "../../model/index.ts";
import { lab, link, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

/** node1 and node2 up, node3 cut. */
const cutThree = lab(spawn(3), ready(), link("down", "node3"));

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const colour = (element: Element) => getComputedStyle(element).color;

function part(element: Element, selector: string): HTMLElement {
	const found = element.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`no ${selector}`);
	return found;
}

describe("<unlab-mac-table>", () => {
	const table = [
		{ vlan: 1, mac: "52:54:00:88:00:0c", port: 2 as PortNo, seen: 92_000, flushed: false },
		{ vlan: 1, mac: "52:54:00:88:00:0b", port: 1 as PortNo, seen: 99_000, flushed: false },
		{ vlan: 1, mac: "52:54:00:88:00:0d", port: 3 as PortNo, seen: 60_000, flushed: true },
	];

	it("lists learned addresses by port with machine, port and age", async () => {
		const { element } = await mount("unlab-mac-table", {
			state: cutThree,
			switch: { macTable: () => table, now: () => 100_400 },
		});
		expect(text(part(element, ".count"))).toBe("2 learned");
		const rows = [...element.querySelectorAll("tbody tr")];
		expect(rows.map(text)).toEqual([
			"52:54:00:88:00:0b 1 node1 1 s ago",
			"52:54:00:88:00:0c 2 node2 8 s ago",
			"52:54:00:88:00:0d 3 node3 flushed, link down",
		]);
		const node1 = part(rows[0] ?? element, ".machine");
		expect(colour(node1)).toBe(tokenColor("hue-1"));
	});

	it("names the NIC of a machine with several", async () => {
		const { element } = await mount("unlab-mac-table", {
			state: lab(spawn(1), spawn(1, "switch0", "switch0"), ready()),
			switch: {
				macTable: () => [
					{ vlan: 1, mac: "52:54:00:88:00:0b", port: 1, seen: 0, flushed: false },
					{ vlan: 1, mac: "52:54:00:88:00:0c", port: 2, seen: 0, flushed: false },
					{ vlan: 1, mac: "52:54:00:88:01:0c", port: 3, seen: 0, flushed: false },
				],
				now: () => 0,
			},
		});
		expect([...element.querySelectorAll("tbody .machine")].map((m) => [text(m), colour(m)])).toEqual([
			["node1", tokenColor("hue-1")],
			["node2:eth0", tokenColor("hue-2")],
			["node2:eth1", tokenColor("hue-2")],
		]);
	});

	it("strikes a flushed entry through and says why in --down", async () => {
		const { element } = await mount("unlab-mac-table", {
			state: cutThree,
			switch: { macTable: () => table, now: () => 100_400 },
		});
		const flushed = part(element, "tr[data-flushed=true]");
		expect(getComputedStyle(part(flushed, ".mac")).textDecorationLine).toBe("line-through");
		expect(colour(part(flushed, ".seen"))).toBe(tokenColor("down"));
		expect(colour(part(flushed, ".machine"))).toBe(tokenColor("text-3"));
	});

	it("re-reads the table when frames arrive", async () => {
		const capture = testCapture();
		const learned = [...table];
		const { element, settle } = await mount("unlab-mac-table", {
			state: cutThree,
			capture: capture.log,
			switch: { macTable: () => learned, now: () => 100_400 },
		});
		learned.push({ vlan: 1, mac: "52:54:00:88:00:0e", port: 4, seen: 100_000, flushed: false });
		capture.frame(ping(4, 1), 4, [1]);
		await settle();
		expect(element.querySelectorAll("tbody tr")).toHaveLength(4);
	});
});

describe("the maximised switch", () => {
	it("passes axe", async () => {
		const { element } = await mount("unlab-switch", {
			state: cutThree,
			switch: {
				macTable: () => [
					{ vlan: 1, mac: "52:54:00:88:00:0b", port: 1, seen: 99_000, flushed: false },
					{ vlan: 1, mac: "52:54:00:88:00:0d", port: 3, seen: 60_000, flushed: true },
				],
				now: () => 100_000,
			},
		});
		const results = await axe.run(element);
		const failures = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} at ${n.target.join(" ")}`));
		expect(failures).toEqual([]);
	});
});
