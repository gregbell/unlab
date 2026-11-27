import "./switch.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { isLineError, parseLine, type Result, type SwitchMacs } from "../../commands/index.ts";
import type { PortNo } from "../../model/index.ts";
import { addSwitch, lab, mount, ready, spawn, switchNamed, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function part(element: Element, selector: string): HTMLElement {
	const found = element.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`no ${selector}`);
	return found;
}

describe("macs, beside the switch panel", () => {
	const lan = switchNamed("lan");
	/** node1 on switch0, and node2 with eth0 on switch0 and eth1 on lan. */
	const two = lab(addSwitch(lan), spawn(1), spawn(1, "switch0", lan), ready());
	const learned = [
		{ vlan: 10, mac: "02:00:00:00:00:01", port: 2 as PortNo, seen: 97_000, flushed: false },
		{ vlan: 1, mac: "52:54:00:88:01:0c", port: 1 as PortNo, seen: 99_000, flushed: false },
		{ vlan: 1, mac: "52:54:00:88:00:0b", port: 3 as PortNo, seen: 40_000, flushed: true },
	];
	const readout = {
		macTable: (of: string) => (of === lan ? learned : []),
		totals: (of: string) => (of === lan ? { in: 7, delivered: 9, flooded: 3 } : { in: 0, delivered: 0, flooded: 0 }),
		now: () => 100_400,
	};

	/** The maximised switch panel showing lan, and what `macs lan` reports, from one reading of the switches. */
	async function shown() {
		const mounted = await mount("unlab-switch", { state: two, switch: readout });
		mounted.store.dispatchUi({ type: "ui/switch-shown", switch: lan });
		await mounted.settle();
		const { element, services, store } = mounted;
		const cells = [...element.querySelectorAll("unlab-mac-table tbody tr")].map((row) =>
			[...row.querySelectorAll("td")].map(text),
		);
		const panel = { cells, count: text(part(element, ".count")), counters: text(part(element, ".counters")) };
		const parsed = parseLine(services.commands.registry, "macs lan", store.state);
		if (isLineError(parsed) || parsed.danger) throw new Error("macs lan does not run");
		const result: Result = await parsed.run({ source: "bar", signal: new AbortController().signal });
		if (result.kind !== "report") throw new Error(`macs lan gave ${result.kind}`);
		return { panel, result };
	}

	it("says each row and the counters as the panel shows them", async () => {
		const { panel, result } = await shown();
		expect(panel.cells).toEqual([
			["52:54:00:88:01:0c", "1", "node2:eth1", "1 s ago"],
			["02:00:00:00:00:01", "2", "", "3 s ago"],
			["52:54:00:88:00:0b", "3", "node1", "flushed, link down"],
		]);
		expect(panel.counters).toBe("7 in · 9 delivered · 3 flooded");
		expect(result.header).toBe(`lan · ${panel.count}`);
		const vlan = (mac: string) => (mac === "02:00:00:00:00:01" ? ["vlan 10"] : []);
		const said = (result.rows ?? []).map(({ term, text }) => [term, text.split("\n")]);
		expect(said).toEqual([
			[
				"lan",
				[
					panel.counters,
					...panel.cells.map(([mac, port, machine, seen]) =>
						[mac, `port ${port}`, ...(machine === "" ? [] : [machine]), ...vlan(mac), seen].join(" · "),
					),
				],
			],
		]);
	});

	it("gives an agent the panel's rows and counters as data", async () => {
		const { panel, result } = await shown();
		const data = result.data as readonly SwitchMacs[];
		expect(data).toEqual([
			{
				switch: "lan",
				counters: { in: 7, delivered: 9, flooded: 3 },
				macs: [
					{ mac: "52:54:00:88:01:0c", port: 1, vlan: 1, machine: "node2", nic: "eth1", age: 1, flushed: false },
					{ mac: "02:00:00:00:00:01", port: 2, vlan: 10, age: 3, flushed: false },
					{ mac: "52:54:00:88:00:0b", port: 3, vlan: 1, machine: "node1", nic: "eth0", age: 60, flushed: true },
				],
			},
		]);
		const [{ counters, macs }] = data;
		expect(`${counters.in} in · ${counters.delivered} delivered · ${counters.flooded} flooded`).toBe(panel.counters);
		expect(macs.map(({ mac, port }) => [mac, String(port)])).toEqual(panel.cells.map(([mac, port]) => [mac, port]));
		expect(panel.count).toBe(`${macs.filter(({ flushed }) => !flushed).length} learned`);
	});
});
