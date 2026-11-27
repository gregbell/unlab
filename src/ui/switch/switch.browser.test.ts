import "./switch.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { testCapture } from "../../../test/support/capture.ts";
import { conditions } from "../../../test/support/conditions.ts";
import { ping } from "../../../test/support/frames.ts";
import type {
	BridgePriority,
	ConditionValues,
	LabEvent,
	PathCost,
	PortRef,
	PortVlan,
	VlanId,
} from "../../model/index.ts";
import {
	addSwitch,
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
	switchNamed,
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

/** The lines of words under the ports. */
const lines = (): string[] =>
	[...document.querySelectorAll("unlab-switch .faceplate > p")].map((p) =>
		(p.textContent ?? "").replace(/\s+/g, " ").trim(),
	);

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

describe("a lab with several switches", () => {
	const lan = switchNamed("lan");
	/** node1 on switch0, node2 on lan with its cable cut, and nothing on wan. */
	const several = () =>
		lab(addSwitch(lan), addSwitch(switchNamed("wan")), spawn(1), spawn(1, lan), ready(), link("down", "node2"));
	const chooser = () => page.getByRole("combobox", { name: "Switch" });
	const held = () =>
		[...document.querySelectorAll("unlab-switch .port:has(.face)")].map(
			(port) => `${(port as HTMLElement).dataset.port} ${port.querySelector(".name")?.textContent}`,
		);

	it("chooses in its title which one it shows, by keyboard", async () => {
		const { element, store, settle } = await mount("unlab-switch", {
			state: several(),
			prepare: (el) => el.setAttribute("compact", ""),
		});
		await expect.element(chooser()).toHaveValue("switch0");
		expect(held()).toEqual(["1 node1"]);
		expect(part(element, ".links").textContent).toBe("1 of 1 links up");

		await userEvent.tab();
		await expect.element(chooser()).toHaveFocus();
		await userEvent.keyboard("{ArrowDown}");
		await settle();
		expect(store.state.shownSwitch).toBe("lan");
		expect(held()).toEqual(["1 node2"]);
		expect(part(element, ".links").textContent).toBe("0 of 1 links up");
		await expect
			.element(page.getByRole("button", { name: /cable/ }))
			.toHaveAccessibleName("Reconnect the cable from node2 to lan port 1");
		await expect.element(chooser()).toHaveFocus();

		await userEvent.selectOptions(chooser(), "wan");
		await settle();
		expect(held()).toEqual([]);
		expect(part(element, ".subnet").textContent).toBe("L2 · no addresses");
	});

	it("counts the frames of the one it shows, and has its MAC table beside it", async () => {
		const capture = testCapture();
		const totals = new Map([
			["switch0", { in: 3, delivered: 5, flooded: 2 }],
			["lan", { in: 1, delivered: 0, flooded: 1 }],
		]);
		const { element, store, settle } = await mount("unlab-switch", {
			state: several(),
			capture: capture.log,
			switch: {
				totals: (of) => totals.get(of) ?? { in: 0, delivered: 0, flooded: 0 },
				macTable: (of) => (of === lan ? [{ vlan: 1, mac: "52:54:00:88:00:0c", port: 1, seen: 0, flushed: false }] : []),
			},
		});
		const counters = () => part(element, ".counters").textContent;
		expect(counters()).toBe("3 in · 5 delivered · 2 flooded");
		expect(element.textContent).toContain("switch0 mac address table");
		expect(element.textContent).toContain("Nothing learned yet.");
		store.dispatchUi({ type: "ui/switch-shown", switch: lan });
		await settle();
		expect(counters()).toBe("1 in · 0 delivered · 1 flooded");
		expect(element.textContent).toContain("lan mac address table");
		expect(part(element, "tbody").textContent).toContain("52:54:00:88:00:0c");

		totals.set("lan", { in: 2, delivered: 0, flooded: 2 });
		capture.frame(ping(1, 2), 1);
		await expect.poll(counters).toBe("2 in · 0 delivered · 2 flooded");
	});

	it("names its buttons for the panel, whichever it shows", async () => {
		await mount("unlab-switch", { state: several() });
		for (const name of ["Maximise switches", "Park switches"]) {
			await expect.element(page.getByRole("button", { name })).toBeVisible();
		}
	});

	it("shows switch0 again when the one it showed is removed, and is as it was when no other is left", async () => {
		const { element, store, settle } = await mount("unlab-switch", { state: several() });
		store.dispatchUi({ type: "ui/switch-shown", switch: lan });
		store.dispatchCommand({ type: "cmd/switch-remove", switch: lan, cause: "bar" });
		await settle();
		await expect.element(chooser()).toHaveValue("switch0");
		store.dispatchCommand({ type: "cmd/switch-remove", switch: switchNamed("wan"), cause: "bar" });
		await settle();
		expect(element.querySelector("select, .counters")).toBeNull();
		expect(part(element, ".title").textContent).toBe("switch0");
		await expect.element(page.getByRole("button", { name: "Park switch0" })).toBeVisible();
	});

	it.each([420, 240])("keeps its header on one line at %ipx, with a long name in it", async (width) => {
		const { element, store, settle } = await mount("unlab-switch", {
			state: lab(addSwitch(switchNamed(LONG_NAME)), spawn(2), ready()),
			prepare: (el) => {
				el.setAttribute("compact", "");
				el.style.width = `${width}px`;
			},
		});
		store.dispatchUi({ type: "ui/switch-shown", switch: switchNamed(LONG_NAME) });
		await settle();
		const header = part(element, ".header");
		expect(header.getBoundingClientRect().height).toBe(35);
		for (const button of header.querySelectorAll("button"))
			expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(header.getBoundingClientRect().right);
	});

	it("passes axe", async () => {
		const { element } = await mount("unlab-switch", { state: several() });
		const results = await axe.run(element);
		expect(results.violations.map((v) => v.id)).toEqual([]);
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

describe("cables between switches", () => {
	const lan = switchNamed("lan");
	const wan = switchNamed("wan");
	const ends = [
		{ switch: lan, port: 8 },
		{ switch: wan, port: 7 },
	] as const;
	/** node1 on port 1 of lan, which is the one shown, and a cable from its port 8 to wan's port 7. */
	const cabled = (...more: readonly LabEvent[]) =>
		lab(
			addSwitch(lan),
			addSwitch(wan),
			spawn(1, lan),
			ready(),
			{ type: "cmd/cable", plan: { ends }, cause: "bar" },
			{ type: "ui/switch-shown", switch: lan },
			...more,
		);
	const storm = (name: typeof lan, rate: number, dropped: number) =>
		({ type: "switch/storm", switch: name, storm: { since: 0, rate, dropped } }) as const;

	it("draws one under the name of the switch it goes to, with that port on its tag, and cuts it by its own port", async () => {
		const { element, runs } = await mount("unlab-switch", { state: cabled() });
		const port = column(8);
		expect([".name", ".nic", ".word"].map((part) => port.querySelector(part)?.textContent)).toEqual([
			"wan",
			"port 7",
			"up",
		]);
		expect(port.dataset.state).toBe("up");
		expect(port.title).toBe("to wan port 7");
		expect(style(part(port, ".light")).backgroundColor).toBe(tokenColor("ok"));
		// It has no machine's hue, and its name is not the grey of a port's number.
		expect(port.dataset.hue).toBeUndefined();
		expect(style(part(port, ".name")).color).toBe(tokenColor("text-2"));
		expect(part(element, ".links").textContent).toBe("2 of 2 links up");

		await page.getByRole("button", { name: "Cut the cable from lan port 8 to wan port 7" }).click();
		expect(runs).toEqual([{ line: "link down lan:8", source: "button" }]);
	});

	it("puts a port's VLAN on its cable's tag, beside a NIC's name or a cable's far port, and says it in full in its title", async () => {
		const vlan = (port: PortRef, setting: PortVlan): LabEvent => ({
			type: "cmd/vlan",
			port,
			vlan: setting,
		});
		const { store, settle } = await mount("unlab-switch", {
			state: cabled(
				vlan({ switch: lan, port: 1 }, { mode: "access", vlan: 10 as VlanId }),
				vlan(ends[0], { mode: "trunk", allowed: [10, 20] as VlanId[], native: 1 as VlanId }),
			),
		});
		expect([".nic", ".word"].map((part) => column(1).querySelector(part)?.textContent)).toEqual(["v10", "up"]);
		expect(column(1).title).toBe("node1 · vlan 10");
		expect(part(column(8), ".nic").textContent).toBe("port 7 trunk");
		expect(column(8).title).toBe("to wan port 7 · trunk of 10 and 20, native 1");

		store.dispatchUi({ type: "ui/switch-shown", switch: wan });
		await settle();
		expect(part(column(7), ".nic").textContent).toBe("port 8");
		expect(column(7).title).toBe("to lan port 8");
	});

	it("marks a cable that has conditions on its tag, a NIC's or one between switches, and says them and what it carried in its title", async () => {
		const impair = (port: PortRef, values: ConditionValues) =>
			({ type: "cmd/conditions", changes: [{ port, conditions: conditions(values) }] }) as const;
		const { store, carried, settle } = await mount("unlab-switch", {
			state: cabled(impair({ switch: lan, port: 1 }, { delay: 100, loss: 20 }), impair(ends[1], { rate: 1_000_000 })),
		});
		expect([".nic", ".word"].map((part) => column(1).querySelector(part)?.textContent)).toEqual(["impaired", "up"]);
		expect(column(1).title).toBe("node1 · delay 100 ms, loss 20% · 0 delivered · 0 dropped");
		expect(part(column(8), ".nic").textContent).toBe("port 7 impaired");
		expect(column(8).title).toBe("to wan port 7 · rate 1 Mbit/s · 0 delivered · 0 dropped");

		carried.set("lan:1", { delivered: 804, dropped: { loss: 196, rate: 0, mtu: 0 } });
		store.dispatchCommand(impair({ switch: lan, port: 1 }, { delay: 100, loss: 20, mtu: 1400 }));
		await settle();
		expect(column(1).title).toBe(
			"node1 · delay 100 ms, loss 20%, mtu 1400 · 804 delivered · 196 dropped (196 by loss)",
		);

		store.dispatchCommand(impair({ switch: lan, port: 1 }, {}));
		store.dispatchCommand(impair(ends[0], {}));
		await settle();
		expect(column(1).querySelector(".nic")).toBeNull();
		expect([column(1).title, column(8).title]).toEqual(["node1", "to wan port 7"]);
		expect(part(column(8), ".nic").textContent).toBe("port 7");
	});

	it("says on its tag that the spanning tree has blocked a port, and in each port's title what it is in the tree, and is drawn as before for one that carries", async () => {
		const stp = { type: "cmd/stp", switches: [lan], on: true } as const;
		const bridge = { priority: 32768, address: "02:00:00:00:00:02" };
		const says = (state: "discarding" | "learning" | "forwarding"): LabEvent => ({
			type: "switch/tree",
			switch: lan,
			tree: {
				bridge,
				root: { ...bridge, address: "02:00:00:00:00:01" },
				cost: 20_000,
				ports: [
					{ port: 1, role: "designated", state: "forwarding" },
					{ port: 8, role: "alternate", state },
				],
			},
		});
		const { store, settle } = await mount("unlab-switch", { state: cabled(stp, says("discarding")) });
		expect([".nic", ".word"].map((part) => column(8).querySelector(part)?.textContent)).toEqual([
			"port 7 blocked",
			"up",
		]);
		expect(column(8).title).toBe("to wan port 7 · alternate port · blocked by spanning tree");
		// The cable is whole, so it is drawn as one that is up, and the button still cuts it.
		expect(column(8).dataset.state).toBe("up");
		await expect
			.element(page.getByRole("button", { name: "Cut the cable from lan port 8 to wan port 7" }))
			.toBeVisible();
		// A port that carries has no tag for the tree, and its title says its role.
		expect(column(1).querySelector(".nic")).toBeNull();
		expect(column(1).title).toBe("node1 · designated port");
		// Under the ports, the switch says its bridge ID and its root.
		expect(lines()).toContain(
			"spanning tree on · bridge 32768.02:00:00:00:00:02 · root 32768.02:00:00:00:00:01 at cost 20000",
		);

		(store.dispatchRuntime as (event: LabEvent) => void)(says("learning"));
		await settle();
		expect(part(column(8), ".nic").textContent).toBe("port 7 learning");
		expect(column(8).title).toBe("to wan port 7 · alternate port · learning");

		(store.dispatchRuntime as (event: LabEvent) => void)(says("forwarding"));
		await settle();
		expect(part(column(8), ".nic").textContent).toBe("port 7");
		expect(column(8).title).toBe("to wan port 7 · alternate port");

		// A cost that is set is in the title, and a priority under the ports while spanning tree is off.
		store.dispatchCommand({ type: "cmd/cost", port: ends[0], cost: 200_000 as PathCost });
		await settle();
		expect(column(8).title).toBe("to wan port 7 · alternate port · cost 200000");
		(store.dispatchRuntime as (event: LabEvent) => void)(says("discarding"));
		store.dispatchCommand({ type: "cmd/stp", switches: [lan], on: false });
		await settle();
		expect(part(column(8), ".nic").textContent).toBe("port 7");
		expect(lines().filter((line) => line.startsWith("spanning tree"))).toEqual([]);
		store.dispatchCommand({ type: "cmd/priority", switches: [lan], priority: 4096 as BridgePriority });
		await settle();
		expect(lines()).toContain("spanning tree off · priority 4096");
	});

	it("draws a cut one dashed and red, and reconnects it, from either switch", async () => {
		const cut = { type: "cmd/cable-link", changes: [{ port: ends[1], up: false }], cause: "bar" } as const;
		const { element, store, runs, settle } = await mount("unlab-switch", { state: cabled(cut) });
		const port = column(8);
		expect(part(port, ".word").textContent).toBe("cut");
		expect(style(part(port, ".word")).color).toBe(tokenColor("down"));
		expect(style(part(port, ".cable")).borderLeftStyle).toBe("dashed");
		expect(part(element, ".links").textContent).toBe("1 of 2 links up");
		await page.getByRole("button", { name: "Reconnect the cable from lan port 8 to wan port 7" }).click();

		store.dispatchUi({ type: "ui/switch-shown", switch: wan });
		await settle();
		expect([".name", ".nic"].map((part) => column(7).querySelector(part)?.textContent)).toEqual(["lan", "port 8"]);
		await page.getByRole("button", { name: "Reconnect the cable from wan port 7 to lan port 8" }).click();
		expect(runs.map((run) => run.line)).toEqual(["link up lan:8", "link up wan:7"]);
	});

	it("says above its ports that it storms, how fast and what it has dropped, and marks each storming switch where one is chosen", async () => {
		const { element, store, settle } = await mount("unlab-switch", {
			state: cabled(storm(lan, 1980, 4321), storm(wan, 990, 0)),
		});
		const line = part(element, ".storm");
		expect(line.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"storming · 1980 looped frames a second · 4321 dropped · cut a cable of the loop to end it",
		);
		expect(style(line).color).toBe(tokenColor("down"));
		const options = [...element.querySelectorAll("option")].map((option) => option.textContent?.trim());
		expect(options).toEqual(["switch0", "lan · storming", "wan · storming"]);

		store.dispatchUi({ type: "ui/switch-shown", switch: "switch0" });
		await settle();
		expect(element.querySelector(".storm")).toBeNull();
	});

	it("draws a cable from a switch to itself at both its ports, in a lab of one switch", async () => {
		const self = lab(spawn(1), ready(), {
			type: "cmd/cable",
			plan: {
				ends: [
					{ switch: "switch0", port: 7 },
					{ switch: "switch0", port: 8 },
				],
			},
			cause: "bar",
		});
		const { element } = await mount("unlab-switch", { state: self });
		expect([".name", ".nic"].map((part) => column(7).querySelector(part)?.textContent)).toEqual(["switch0", "port 8"]);
		expect([".name", ".nic"].map((part) => column(8).querySelector(part)?.textContent)).toEqual(["switch0", "port 7"]);
		expect(part(element, ".links").textContent).toBe("3 of 3 links up");
	});

	it("passes axe with a cable between switches and a storm", async () => {
		const { element } = await mount("unlab-switch", { state: cabled(storm(lan, 1980, 4321)) });
		const results = await axe.run(element);
		expect(results.violations.map((v) => v.id)).toEqual([]);
	});
});
