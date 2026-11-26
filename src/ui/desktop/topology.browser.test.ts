import "./desktop.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { conditions } from "../../../test/support/conditions.ts";
import {
	DEFAULT_SWITCH,
	isPlanError,
	type LabEvent,
	type LabState,
	type MachineName,
	type PortNo,
	type PortRef,
	planSpawn,
	type Store,
	type SwitchName,
	update,
	type VlanId,
} from "../../model/index.ts";
import { addSwitch, lab, link, mount, ready, type Step, spawn, switchNamed, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(() => {
	unmountAll();
	localStorage.clear();
});

const [lan, wan, dmz, core, edge, office, labs] = ["lan", "wan", "dmz", "core", "edge", "office", "labs"].map(
	switchNamed,
);
const port = (on: SwitchName, n: number): PortRef => ({ switch: on, port: n as PortNo });
const node = (n: number) => `node${n}` as MachineName;
const cable = (a: PortRef, b: PortRef): LabEvent => ({ type: "cmd/cable", plan: { ends: [a, b] }, cause: "bar" });
const vlan = (at: PortRef, id: number): LabEvent => ({
	type: "cmd/vlan",
	port: at,
	vlan: { mode: "access", vlan: id as VlanId },
});
const trunk = (at: PortRef, ...allowed: number[]): LabEvent => ({
	type: "cmd/vlan",
	port: at,
	vlan: { mode: "trunk", allowed: allowed as VlanId[], native: 1 as VlanId },
});
const storm = (on: SwitchName, going: boolean): LabEvent => ({
	type: "switch/storm",
	switch: on,
	storm: going ? { since: 0, rate: 1980, dropped: 0 } : null,
});

/** Each step as the commands and the runtime send it, into the lab that the window is showing. */
function send(store: Store, ...steps: Step[]) {
	for (const step of steps)
		for (const event of typeof step === "function" ? step(store.state) : [step])
			(store.dispatchRuntime as (event: LabEvent) => void)(event);
}

/** switch0 and lan cabled at their eighth ports, node1 and node2 on switch0, node3 with eth0 there and eth1 on lan, node4 on lan. */
const wired = () =>
	lab(
		addSwitch(lan),
		cable(port(DEFAULT_SWITCH, 8), port(lan, 8)),
		spawn(2),
		spawn(1, DEFAULT_SWITCH, lan),
		spawn(1, lan),
		ready(),
	);

async function topology(state: LabState) {
	const mounted = await mount("unlab-desktop", { state });
	const map = document.querySelector<HTMLElement>('[aria-label="Topology"]');
	if (!map) throw new Error("no Topology window");
	const nodeOf = (name: string) => {
		const found = map.querySelector<HTMLElement>(`.n-node[data-machine="${name}"], .n-node[data-switch="${name}"]`);
		if (!found) throw new Error(`${name} is not drawn`);
		return found;
	};
	return {
		...mounted,
		map,
		note: (name: string) => nodeOf(name).querySelector("small")?.textContent?.replaceAll("\u00a0", " "),
		/** The node, for what it says to a screen reader. */
		described: (name: string) => page.elementLocator(nodeOf(name)),
		/** Each line's state, by the nodes its ends are on, as `switch0 node1 up`. */
		lines: () => {
			const centre = (el: Element) => {
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			};
			const nodes = [...map.querySelectorAll<HTMLElement>(".n-node")].map((el) => ({
				name: el.dataset.machine ?? el.dataset.switch,
				...centre(el),
			}));
			const matrix = map.querySelector<SVGSVGElement>("svg.n-wires")?.getScreenCTM() ?? undefined;
			const nearest = (path: SVGPathElement, at: number) => {
				const p = path.getPointAtLength(at).matrixTransform(matrix);
				return nodes.reduce((a, b) => (Math.hypot(a.x - p.x, a.y - p.y) <= Math.hypot(b.x - p.x, b.y - p.y) ? a : b))
					.name;
			};
			return [...map.querySelectorAll<SVGPathElement>(".wire")]
				.map((path) => `${nearest(path, 0)} ${nearest(path, path.getTotalLength())} ${path.dataset.state}`)
				.sort();
		},
	};
}

describe("the Topology window", () => {
	it("draws every switch, machine and cable, and says which NIC and which port each cable goes to", async () => {
		const { map, lines, note, described } = await topology(wired());
		expect([...map.querySelectorAll(".n-node strong")].map((name) => name.textContent)).toEqual([
			"switch0",
			"lan",
			"node1",
			"node2",
			"node3",
			"node4",
		]);
		expect(lines()).toEqual([
			"lan node3 up",
			"lan node4 up",
			"switch0 lan up",
			"switch0 node1 up",
			"switch0 node2 up",
			"switch0 node3 up",
		]);
		expect(note("node3")).toBe("alpine · 2 NICs");
		expect(note("node1")).toBe("alpine");
		// node3 shares a column with lan, which it is cabled to, so a line crosses its name, as on main.
		expect(unreadable(map).filter((what) => what.includes(" under "))).toEqual([]);
		await expect
			.element(described("node3"))
			.toHaveAccessibleDescription("eth0 · to switch0 port 3 · up. eth1 · to lan port 1 · up");
		await expect.element(described("node1")).toHaveAccessibleDescription("eth0 · to switch0 port 1 · up");
		await expect
			.element(described("switch0"))
			.toHaveAccessibleDescription(
				"Port 1 · node1 · up. Port 2 · node2 · up. Port 3 · node3:eth0 · up. Port 8 · to lan port 8 · up",
			);
		await expect
			.element(described("lan"))
			.toHaveAccessibleDescription("Port 1 · node3:eth1 · up. Port 2 · node4 · up. Port 8 · to switch0 port 8 · up");
	});

	it("follows each command without a reload: a moved, cut and impaired cable, a VLAN, a trunk and a storm", async () => {
		const { element, store, settle, lines, note, described } = await topology(wired());
		const step = async (...steps: Step[]) => {
			send(store, ...steps);
			await settle();
		};

		await step({ type: "cmd/plug", plan: { machine: node(1), nic: 0, to: port(lan, 3) }, cause: "bar" });
		expect(lines()).toContain("lan node1 up");
		expect(lines()).not.toContain("switch0 node1 up");
		await expect.element(described("node1")).toHaveAccessibleDescription("eth0 · to lan port 3 · up");

		await step(link("down", node(2)), {
			type: "cmd/cable-link",
			changes: [{ port: port(lan, 8), up: false }],
			cause: "bar",
		});
		expect(lines()).toContain("switch0 node2 cut");
		expect(lines()).toContain("switch0 lan cut");
		await expect.element(described("node2")).toHaveAccessibleDescription("eth0 · to switch0 port 2 · cut");
		await expect
			.element(described("lan"))
			.toHaveAccessibleDescription(expect.stringContaining("Port 8 · to switch0 port 8 · cut"));

		await step({
			type: "cmd/conditions",
			changes: [{ port: port(DEFAULT_SWITCH, 3), conditions: conditions({ delay: 50, loss: 10 }) }],
		});
		expect(note("node3")).toBe("alpine · 2 NICs · impaired");
		await expect
			.element(described("node3"))
			.toHaveAccessibleDescription("eth0 · to switch0 port 3 · up · delay 50 ms, loss 10%. eth1 · to lan port 1 · up");

		await step(vlan(port(lan, 2), 10), trunk(port(lan, 8), 1, 10));
		expect(note("node4")).toBe("alpine · v10");
		expect(note("node3")).toBe("alpine · 2 NICs · impaired");
		expect(note("lan")).toBe("4 / 8 ports");
		expect(note("switch0")).toBe("3 / 8 ports · impaired");
		await expect.element(described("node4")).toHaveAccessibleDescription("eth0 · to lan port 2 · up · vlan 10");
		await expect
			.element(described("lan"))
			.toHaveAccessibleDescription(
				expect.stringContaining("Port 8 · to switch0 port 8 · cut · trunk of 1 and 10, native 1"),
			);

		await step(vlan(port(lan, 1), 20));
		expect(note("node3")).toBe("alpine · 2 NICs · impaired");
		await expect
			.element(described("node3"))
			.toHaveAccessibleDescription(expect.stringContaining("eth1 · to lan port 1 · up · vlan 20"));

		await step(storm(lan, true));
		expect(note("lan")).toBe("4 / 8 ports · storming");
		await step(storm(lan, false), vlan(port(lan, 2), 1));
		expect(note("lan")).toBe("4 / 8 ports");
		expect(note("node4")).toBe("alpine");
		await expect.element(described("node4")).toHaveAccessibleDescription("eth0 · to lan port 2 · up");

		await step({ type: "cmd/uncable", port: port(lan, 8), cause: "bar" });
		expect(lines()).not.toContain("switch0 lan cut");
		expect(document.querySelector("unlab-desktop")).toBe(element);
	});

	it("can be used by keyboard, and says in words what a line shows by its colour", async () => {
		const { map, store, settle, described } = await topology(wired());
		send(store, link("down", node(2)));
		await settle();
		const title = map.querySelector<HTMLElement>(".dt-title");
		title?.focus();
		const reached: string[] = [];
		for (let i = 0; i < 9; i++) {
			await userEvent.tab();
			const at = document.activeElement;
			if (!(at instanceof HTMLElement) || !map.contains(at)) break;
			if (at.classList.contains("n-node")) {
				expect(getComputedStyle(at).outlineStyle).not.toBe("none");
				reached.push(at.querySelector("strong")?.textContent ?? "");
			}
		}
		expect(reached).toEqual(["switch0", "lan", "node1", "node2", "node3", "node4"]);

		const cut = map.querySelector<SVGPathElement>('.wire[data-state="cut"]');
		const up = map.querySelector<SVGPathElement>('.wire[data-state="up"]');
		if (!cut || !up) throw new Error("no cut line beside an up one");
		expect(getComputedStyle(up).strokeDasharray).toBe("none");
		expect(getComputedStyle(cut).strokeDasharray).not.toBe("none");
		await expect.element(described("node2")).toHaveAccessibleDescription("eth0 · to switch0 port 2 · cut");

		map.querySelector<HTMLElement>('.n-node[data-machine="node3"]')?.focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("region", { name: "node3 · Configuration" })).toBeVisible();
	});
});

/**
 * Eight switches, seven of them cabled to core, and sixteen machines, one of them with a NIC on each of switch0, lan
 * and wan and a fourth on switch0. A lab holds eight machines until story 6.1, so the eight past that are spawned into
 * the lab as if it had none yet, on switches where no machine is, and the two are put together. Ports in VLANs, a
 * trunk, a cable with conditions and two storms give the nodes their longest notes.
 */
function crowd(): LabState {
	const leaves = [DEFAULT_SWITCH, lan, wan, dmz, edge, office, labs];
	const eight = lab(
		...[lan, wan, dmz, core, edge, office, labs].map(addSwitch),
		...leaves.map((leaf, i) => cable(port(core, i + 1), port(leaf, 8))),
		spawn(2),
		spawn(1, DEFAULT_SWITCH, lan, wan, DEFAULT_SWITCH),
		spawn(2, lan),
		spawn(3, wan),
	);
	const more = [dmz, dmz, edge, edge, office, office, labs, labs].reduce<LabState>(
		(state, on) => {
			const plan = planSpawn(state, 1, {
				image: "alpine",
				memMiB: 256,
				disks: { root: "4", extra: [] },
				gateway: false,
				nics: [{ net: on, address: null }],
			});
			if (isPlanError(plan)) throw new Error(`cannot spawn on ${on}: ${plan.kind}`);
			return update(state, { type: "cmd/spawn", plan, at: state.now }).state;
		},
		{ ...eight, rail: [], machines: {} },
	);
	const sixteen = { ...more, rail: [...eight.rail, ...more.rail], machines: { ...eight.machines, ...more.machines } };
	return [
		vlan(port(lan, 1), 10),
		vlan(port(wan, 1), 20),
		vlan(port(dmz, 1), 30),
		trunk(port(core, 2), 1, 10, 20),
		trunk(port(lan, 8), 1, 10, 20),
		{ type: "cmd/conditions", changes: [{ port: port(core, 3), conditions: conditions({ delay: 20 }) }] },
		storm(core, true),
		storm(lan, true),
	].reduce<LabState>((state, event) => update(state, event as LabEvent).state, sixteen);
}

/** What makes a name or a note hard to read: another node over it, another node's name or note over a name, or a line across a name. */
function unreadable(map: Element): string[] {
	const parts = [...map.querySelectorAll<HTMLElement>(".n-node")].flatMap((node) => {
		const who = node.dataset.machine ?? node.dataset.switch ?? "?";
		return [
			{ who, what: "node", rect: node.getBoundingClientRect() },
			{ who, what: "name", rect: node.querySelector("strong")?.getBoundingClientRect() },
			{ who, what: "note", rect: node.querySelector("small")?.getBoundingClientRect() },
		];
	});
	const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
	const matrix = map.querySelector<SVGSVGElement>("svg.n-wires")?.getScreenCTM() ?? undefined;
	const lines = [...map.querySelectorAll<SVGPathElement>(".wire")].map((wire) =>
		Array.from({ length: 200 }, (_, i) =>
			wire.getPointAtLength((i / 199) * wire.getTotalLength()).matrixTransform(matrix),
		),
	);
	const names = parts.filter((p) => p.what === "name");
	const notes = parts.filter((p) => p.what === "note");
	return [
		...notes.flatMap((note) =>
			parts
				.filter(
					(other) =>
						other.who !== note.who && other.what === "node" && note.rect && other.rect && meet(note.rect, other.rect),
				)
				.map((other) => `${note.who}'s note under ${other.who}'s node`),
		),
		...names.flatMap((name) =>
			parts
				.filter((other) => other.who !== name.who && name.rect && other.rect && meet(name.rect, other.rect))
				.map((other) => `${name.who}'s name under ${other.who}'s ${other.what}`),
		),
		...names.flatMap(({ who, rect }) =>
			lines.some((points) =>
				points.some((p) => rect && p.x > rect.left && p.x < rect.right && p.y > rect.top && p.y < rect.bottom),
			)
				? [`a line across ${who}'s name`]
				: [],
		),
	];
}

describe("the Topology window of a machine with several NICs", () => {
	it("keeps its note clear of the machine drawn below it, as the window opens and maximized", async () => {
		const { map, note } = await topology(
			lab(
				addSwitch(lan),
				addSwitch(wan),
				spawn(1),
				spawn(1, DEFAULT_SWITCH, lan, wan),
				spawn(2),
				ready(),
				vlan(port(DEFAULT_SWITCH, 2), 10),
				vlan(port(lan, 1), 20),
				vlan(port(wan, 1), 30),
				{ type: "cmd/conditions", changes: [{ port: port(DEFAULT_SWITCH, 2), conditions: conditions({ delay: 30 }) }] },
			),
		);
		expect(note("node2")).toBe("alpine · 3 NICs · impaired");
		expect(unreadable(map).filter((what) => what.includes(" under "))).toEqual([]);
		await page.getByRole("button", { name: "Maximize Topology" }).click();
		await expect.poll(() => map.dataset.max).toBe("true");
		await new Promise((done) => setTimeout(done, 600));
		expect(unreadable(map).filter((what) => what.includes(" under "))).toEqual([]);
	});
});

describe("the Topology window of a full lab", () => {
	it("with 16 machines and eight switches, every name can be read, in the window as it opens and maximized", async () => {
		const state = crowd();
		expect([state.rail.length, state.switches.length]).toEqual([16, 8]);
		const { map, note } = await topology(state);
		expect(note("node3")).toBe("alpine · 4 NICs");
		expect(note("core")).toBe("7 / 8 ports · storming · impaired");
		const drawing = map.querySelector(".n-drawing")?.getBoundingClientRect();
		const names = [...map.querySelectorAll(".n-node strong")];
		expect(names.map((n) => n.textContent)).toEqual([...state.switches, ...state.rail]);
		expect(unreadable(map)).toEqual([]);
		for (const name of names) {
			const r = name.getBoundingClientRect();
			expect(drawing && r.left >= drawing.left && r.right <= drawing.right && r.bottom <= drawing.bottom).toBe(true);
		}
		await page.getByRole("button", { name: "Maximize Topology" }).click();
		await expect.poll(() => map.dataset.max).toBe("true");
		await new Promise((done) => setTimeout(done, 600));
		expect(unreadable(map)).toEqual([]);
	});
});
