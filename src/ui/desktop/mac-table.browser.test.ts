import "./desktop.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { testCapture } from "../../../test/support/capture.ts";
import { ping } from "../../../test/support/frames.ts";
import type { LearnedMac, PortNo, SwitchTotals } from "../../model/index.ts";
import { lab, link, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(() => {
	unmountAll();
	localStorage.clear();
});

const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";

/** node1 and node2 up, node3 cut. */
const cutThree = lab(spawn(3), ready(), link("down", "node3"));

const learnedThree = (): LearnedMac[] => [
	{ vlan: 1, mac: "52:54:00:88:00:0c", port: 2 as PortNo, seen: 92_000, flushed: false },
	{ vlan: 1, mac: "52:54:00:88:00:0b", port: 1 as PortNo, seen: 99_000, flushed: false },
	{ vlan: 1, mac: "52:54:00:88:00:0d", port: 3 as PortNo, seen: 60_000, flushed: true },
];

/** The desktop on the lab, with switch0's details window opened by keyboard from its node in the Topology window. */
async function details(options: { macs: LearnedMac[]; totals: SwitchTotals; state?: typeof cutThree }) {
	const capture = testCapture();
	const mounted = await mount("unlab-desktop", {
		state: options.state ?? cutThree,
		capture: capture.log,
		switch: { macTable: () => options.macs, totals: () => options.totals, now: () => 100_400 },
	});
	document.querySelector<HTMLElement>('.n-node[data-switch="switch0"]')?.focus();
	await userEvent.keyboard(" ");
	const window = page.getByRole("region", { name: "switch0 · Switch details" });
	await expect.element(window).toBeVisible();
	const table = window.getByRole("table", { name: "MAC address table on switch0" });
	return {
		...mounted,
		capture,
		window,
		table,
		rows: () =>
			[...table.element().querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) =>
				[...row.cells].map(text).join(" "),
			),
		frames: () => text(window.getByText(/ in · /).element()),
	};
}

describe("a switch's details window", () => {
	it("shows the switch's counters, and its MAC table by port with machine and age, in the words of macs", async () => {
		const { table, rows, frames, window } = await details({
			macs: learnedThree(),
			totals: { in: 120, delivered: 80, flooded: 12 },
		});
		expect(frames()).toBe("120 in · 80 delivered · 12 flooded");
		const learned = window.getByText("Addresses learned").element().parentElement?.querySelector("dd");
		expect(learned && text(learned)).toBe("2");
		expect(table.getByRole("columnheader").elements().map(text)).toEqual(["MAC", "Port", "Machine", "Seen"]);
		expect(rows()).toEqual([
			"52:54:00:88:00:0b 1 node1 1 s ago",
			"52:54:00:88:00:0c 2 node2 8 s ago",
			"52:54:00:88:00:0d 3 node3 flushed, link down",
		]);
		const flushed = table.getByRole("cell", { name: "flushed, link down" }).element();
		expect(getComputedStyle(flushed).color).toBe(tokenColor("down"));
	});

	it("names the NIC of a machine with several", async () => {
		const { rows } = await details({
			state: lab(spawn(1), spawn(1, "switch0", "switch0"), ready()),
			macs: [
				{ vlan: 1, mac: "52:54:00:88:00:0b", port: 1 as PortNo, seen: 100_000, flushed: false },
				{ vlan: 1, mac: "52:54:00:88:00:0c", port: 2 as PortNo, seen: 100_000, flushed: false },
				{ vlan: 1, mac: "52:54:00:88:01:0c", port: 3 as PortNo, seen: 100_000, flushed: false },
			],
			totals: { in: 3, delivered: 3, flooded: 0 },
		});
		expect(rows()).toEqual([
			"52:54:00:88:00:0b 1 node1 0 s ago",
			"52:54:00:88:00:0c 2 node2:eth0 0 s ago",
			"52:54:00:88:01:0c 3 node2:eth1 0 s ago",
		]);
	});

	it("says a switch that has seen nothing has learned nothing", async () => {
		const { window, frames, rows } = await details({ macs: [], totals: { in: 0, delivered: 0, flooded: 0 } });
		expect(frames()).toBe("0 in · 0 delivered · 0 flooded");
		expect(rows()).toEqual([]);
		await expect.element(window.getByText("Nothing learned yet.")).toBeVisible();
	});

	it("follows the switch as frames arrive, without a store change", async () => {
		const macs = learnedThree();
		const totals = { in: 120, delivered: 80, flooded: 12 };
		const { capture, rows, frames, settle } = await details({ macs, totals });
		macs.push({ vlan: 1, mac: "52:54:00:88:00:0e", port: 4 as PortNo, seen: 100_000, flushed: false });
		Object.assign(totals, { in: 121, delivered: 81 });
		capture.frame(ping(4, 1), 4, [1]);
		await settle();
		expect(rows()).toHaveLength(4);
		expect(frames()).toBe("121 in · 81 delivered · 12 flooded");
	});

	it("passes axe", async () => {
		const { window } = await details({ macs: learnedThree(), totals: { in: 120, delivered: 80, flooded: 12 } });
		const results = await axe.run(window.element());
		const failures = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} at ${n.target.join(" ")}`));
		expect(failures).toEqual([]);
	});
});
