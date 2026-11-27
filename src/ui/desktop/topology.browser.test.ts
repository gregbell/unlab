import "./desktop.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { conditions } from "../../../test/support/conditions.ts";
import { unreadable } from "../../../test/support/topology.ts";
import {
	DEFAULT_SWITCH,
	type LabEvent,
	type LabState,
	type MachineName,
	type PortNo,
	type PortRef,
	type Store,
	type SwitchName,
	type VlanId,
} from "../../model/index.ts";
import {
	addSwitch,
	LONG_NAME,
	lab,
	link,
	mount,
	named,
	power,
	ready,
	type Step,
	spawn,
	spawnNamed,
	stopped,
	switchNamed,
	unmountAll,
} from "../base/testing.ts";

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

const SIZES = ["as it opens", "maximized", "in a narrow browser window"] as const;
const settled = () => new Promise((done) => setTimeout(done, 600));

/** The desktop on the lab, with its Topology window as it opens, maximized, or opened from the rack in a browser window 480 wide. */
async function topology(state: LabState, size: (typeof SIZES)[number] = "as it opens") {
	await page.viewport(size === "in a narrow browser window" ? 480 : 1440, 900);
	const mounted = await mount("unlab-desktop", { state });
	const map = document.querySelector<HTMLElement>('[aria-label="Topology"]');
	if (!map) throw new Error("no Topology window");
	if (size === "maximized") {
		await page.getByRole("button", { name: "Maximize Topology" }).click();
		await expect.poll(() => map.dataset.max).toBe("true");
		await settled();
	}
	if (size === "in a narrow browser window") {
		// A narrow desktop starts with the window closed.
		await page.getByRole("button", { name: "Topology ↗" }).click();
		await expect.poll(() => map.hidden).toBe(false);
		await settled();
	}
	await document.fonts.ready;
	await new Promise(requestAnimationFrame);
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
		/** What a pointer resting on the node shows. */
		titled: (name: string) => nodeOf(name).title,
		/** Each line's state, by the nodes whose pictures its two ends are in, as `switch0 node1 up`. An end in none is `nowhere`. */
		lines: () => {
			const pictures = [...map.querySelectorAll<HTMLElement>(".n-node")].map((el) => ({
				name: el.dataset.machine ?? el.dataset.switch,
				box: (el.querySelector(".n-art")?.parentElement ?? el).getBoundingClientRect(),
			}));
			const end = (path: SVGPathElement, at: number) => {
				const p = path.getPointAtLength(at).matrixTransform(path.getScreenCTM() ?? undefined);
				const inside = pictures.find(
					({ box }) => p.x > box.left - 1 && p.x < box.right + 1 && p.y > box.top - 1 && p.y < box.bottom + 1,
				);
				return inside?.name ?? "nowhere";
			};
			return [...map.querySelectorAll<SVGPathElement>(".wire")]
				.map((path) => `${end(path, 0)} ${end(path, path.getTotalLength())} ${path.dataset.state}`)
				.sort();
		},
	};
}

describe("the Topology window", () => {
	it("draws every switch, machine and cable, and says which NIC and which port each cable goes to", async () => {
		const { map, lines, note, described, titled } = await topology(wired());
		expect([...map.querySelectorAll(".n-node strong")].map((name) => name.textContent).sort()).toEqual([
			"lan",
			"node1",
			"node2",
			"node3",
			"node4",
			"switch0",
		]);
		expect(lines()).toEqual([
			"lan node3 up",
			"lan node4 up",
			"switch0 lan up",
			"switch0 node1 up",
			"switch0 node2 up",
			"switch0 node3 up",
		]);
		expect(note("node3")).toBe("alpine");
		expect(note("node1")).toBe("alpine");
		expect(note("switch0")).toBe("4 / 8 ports");
		expect(titled("node3")).toBe("eth0 · to switch0 port 3 · up\neth1 · to lan port 1 · up");
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
		const { element, store, settle, lines, note, described, titled } = await topology(wired());
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
		expect(note("node3")).toBe("alpine · impaired");
		await expect
			.element(described("node3"))
			.toHaveAccessibleDescription("eth0 · to switch0 port 3 · up · delay 50 ms, loss 10%. eth1 · to lan port 1 · up");

		await step(vlan(port(lan, 2), 10), trunk(port(lan, 8), 1, 10));
		expect(titled("node4")).toBe("eth0 · to lan port 2 · up · vlan 10");
		expect(titled("lan")).toContain("Port 2 · node4 · up · vlan 10");
		expect(note("node4")).toBe("alpine");
		expect(note("node3")).toBe("alpine · impaired");
		expect(note("lan")).toBe("4 / 8 ports");
		expect(note("switch0")).toBe("3 / 8 ports · impaired");
		await expect.element(described("node4")).toHaveAccessibleDescription("eth0 · to lan port 2 · up · vlan 10");
		await expect
			.element(described("lan"))
			.toHaveAccessibleDescription(
				expect.stringContaining("Port 8 · to switch0 port 8 · cut · trunk of 1 and 10, native 1"),
			);

		await step(vlan(port(lan, 1), 20));
		expect(titled("node3")).toContain("eth1 · to lan port 1 · up · vlan 20");
		expect(note("node3")).toBe("alpine · impaired");
		await expect
			.element(described("node3"))
			.toHaveAccessibleDescription(expect.stringContaining("eth1 · to lan port 1 · up · vlan 20"));

		await step(storm(lan, true));
		expect(note("lan")).toBe("4 / 8 ports · storming");
		await step(storm(lan, false), vlan(port(lan, 2), 1));
		expect(note("lan")).toBe("4 / 8 ports");
		expect(titled("node4")).toBe("eth0 · to lan port 2 · up");
		expect(note("node4")).toBe("alpine");
		await expect.element(described("node4")).toHaveAccessibleDescription("eth0 · to lan port 2 · up");

		await step({ type: "cmd/uncable", port: port(lan, 8), cause: "bar" });
		expect(lines()).not.toContain("switch0 lan cut");
		expect(document.querySelector("unlab-desktop")).toBe(element);
	});

	it("follows the spanning tree without a reload: a blocked port is in its node's words and on its line, and gone when the port carries", async () => {
		const { store, settle, lines, note, described, titled } = await topology(wired());
		const step = async (...steps: Step[]) => {
			send(store, ...steps);
			await settle();
		};
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
					{ port: 2, role: "designated", state: "forwarding" },
					{ port: 8, role: "alternate", state },
				],
			},
		});
		const before = [note("lan"), note("switch0")];

		await step({ type: "cmd/stp", switches: [DEFAULT_SWITCH, lan], on: true }, says("discarding"));
		expect(lines()).toContain("switch0 lan blocked");
		expect(titled("lan")).toContain("Port 8 · to switch0 port 8 · up · blocked");
		await expect
			.element(described("lan"))
			.toHaveAccessibleDescription(expect.stringContaining("Port 8 · to switch0 port 8 · up · blocked"));
		// The far end of the cable carries, and says only that its link is up. The lines to machines are as they were.
		expect(titled("switch0")).toContain("Port 8 · to lan port 8 · up");
		expect(titled("switch0")).not.toContain("blocked");
		expect(lines()).toContain("lan node4 up");
		expect(titled("node4")).toBe("eth0 · to lan port 2 · up");
		// A node's note says no more than it did.
		expect([note("lan"), note("switch0")]).toEqual(before);

		await step(says("learning"));
		expect(lines()).toContain("switch0 lan learning");
		expect(titled("lan")).toContain("Port 8 · to switch0 port 8 · up · learning");

		await step(says("forwarding"));
		expect(lines()).toContain("switch0 lan up");
		expect(titled("lan")).toContain("Port 8 · to switch0 port 8 · up");
		expect(titled("lan")).not.toMatch(/blocked|learning/);

		await step(says("discarding"), { type: "cmd/stp", switches: [lan], on: false });
		expect(lines()).toContain("switch0 lan up");
		expect(titled("lan")).not.toContain("blocked");
	});

	it("can be used by keyboard: Tab reaches every node in the order they are drawn, each shows that it has the focus, and Enter and Space select it", async () => {
		const { map } = await topology(wired());
		const pressed = () =>
			[...map.querySelectorAll<HTMLElement>('.n-node[aria-pressed="true"]')].map(
				(at) => at.querySelector("strong")?.textContent,
			);
		map.querySelector<HTMLElement>(".dt-title")?.focus();
		const reached: HTMLElement[] = [];
		for (let i = 0; i < 9; i++) {
			await userEvent.tab();
			const at = document.activeElement;
			if (!(at instanceof HTMLElement) || !map.contains(at)) break;
			if (!at.classList.contains("n-node")) continue;
			const ring = getComputedStyle(at);
			expect(ring.outlineStyle).not.toBe("none");
			expect(Number.parseFloat(ring.outlineWidth)).toBeGreaterThanOrEqual(2);
			reached.push(at);
		}
		// Left to right by column, and down each column.
		const drawn = [...map.querySelectorAll<HTMLElement>(".n-node")]
			.map((at) => ({ at, box: at.getBoundingClientRect() }))
			.sort((a, b) => a.box.left + a.box.width / 2 - (b.box.left + b.box.width / 2) || a.box.top - b.box.top)
			.map(({ at }) => at);
		expect(reached).toHaveLength(6);
		expect(reached.map((at) => at.querySelector("strong")?.textContent)).toEqual(
			drawn.map((at) => at.querySelector("strong")?.textContent),
		);

		map.querySelector<HTMLElement>('.n-node[data-machine="node3"]')?.focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("region", { name: "node3 · Configuration" })).toBeVisible();
		expect(pressed()).toEqual(["node3"]);
		map.querySelector<HTMLElement>('.n-node[data-switch="lan"]')?.focus();
		await userEvent.keyboard(" ");
		await expect.element(page.getByRole("region", { name: "lan · Switch details" })).toBeVisible();
		expect(pressed()).toEqual(["lan"]);
	});

	it("says a selected node and each line's state by more than its colour", async () => {
		const bridge = { priority: 32768, address: "02:00:00:00:00:02" };
		const { map, described } = await topology(
			lab(
				addSwitch(lan),
				cable(port(DEFAULT_SWITCH, 7), port(lan, 7)),
				cable(port(DEFAULT_SWITCH, 8), port(lan, 8)),
				spawn(4),
				ready(),
				link("down", node(2)),
				power("off", node(3)),
				stopped(node(3)),
				{ type: "cmd/stp", switches: [DEFAULT_SWITCH, lan], on: true },
				{
					type: "switch/tree",
					switch: lan,
					tree: {
						bridge,
						root: { ...bridge, address: "02:00:00:00:00:01" },
						cost: 20_000,
						ports: [
							{ port: 7, role: "alternate", state: "discarding" },
							{ port: 8, role: "root", state: "learning" },
						],
					},
				},
			),
		);
		// With every colour of the stylesheet the one grey, what still differs is not colour.
		const grey = new CSSStyleSheet();
		grey.replaceSync(
			`:root { ${[...document.documentElement.computedStyleMap()]
				.filter(([name, value]) => name.startsWith("--") && CSS.supports("color", String(value)))
				.map(([name]) => `${name}: rgb(128 128 128) !important;`)
				.join(" ")} }`,
		);
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, grey];
		try {
			const look = (el: Element | null, ...properties: string[]) => {
				if (!el) throw new Error("not drawn");
				return properties.map((property) => getComputedStyle(el).getPropertyValue(property)).join(" | ");
			};
			// A colour as it is painted, however its style spells it.
			const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
			const colours = (el: Element | null) =>
				["color", "background-color", "border-top-color", "stroke"].map((property) => {
					if (!paint) throw new Error("no canvas");
					paint.clearRect(0, 0, 1, 1);
					paint.fillStyle = look(el, property);
					paint.fillRect(0, 0, 1, 1);
					return paint.getImageData(0, 0, 1, 1).data.join(" ");
				});
			// The frame drawn round a node's art.
			const tile = (name: string) => map.querySelector(`.n-node[data-machine="${name}"] .n-art`)?.parentElement ?? null;
			const name = (name: string) => map.querySelector(`.n-node[data-machine="${name}"] strong`);
			const wire = (state: string, selected = false) =>
				map.querySelector(`.wire[data-state="${state}"][data-selected="${selected}"]`);

			// node1 is selected as the desktop opens, and node4 is not.
			await expect.element(described("node1")).toHaveAttribute("aria-pressed", "true");
			await expect.element(described("node4")).toHaveAttribute("aria-pressed", "false");
			expect(colours(tile("node1"))).toEqual(colours(tile("node4")));
			expect(colours(name("node1"))).toEqual(colours(name("node4")));
			expect(look(tile("node1"), "border-top-width", "box-shadow", "outline-style", "outline-width")).not.toBe(
				look(tile("node4"), "border-top-width", "box-shadow", "outline-style", "outline-width"),
			);
			expect(look(name("node1"), "font-weight")).not.toBe(look(name("node4"), "font-weight"));

			const STATES = ["up", "cut", "off", "blocked", "learning"];
			expect(new Set(STATES.map((state) => colours(wire(state)).join())).size).toBe(1);
			const dashes = STATES.map((state) => look(wire(state), "stroke-dasharray"));
			expect(dashes[0]).toBe("none");
			expect(new Set(dashes).size, dashes.join(" ; ")).toBe(STATES.length);
			expect(colours(wire("up", true))).toEqual(colours(wire("up")));
			expect(Number.parseFloat(look(wire("up", true), "stroke-width"))).toBeGreaterThan(
				Number.parseFloat(look(wire("up"), "stroke-width")),
			);
		} finally {
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== grey);
		}
		await expect.element(described("node2")).toHaveAccessibleDescription("eth0 · to switch0 port 2 · cut");
		await expect
			.element(described("lan"))
			.toHaveAccessibleDescription(
				"Port 7 · to switch0 port 7 · up · blocked. Port 8 · to switch0 port 8 · up · learning",
			);
	});
});

const [router, database, backup] = ["internal-router-east", "database-server-west", "backup-storage-south"].map(named);

/**
 * Eight switches, seven of them cabled to core, and sixteen machines: three with names that take two lines, one with
 * a NIC on each of switch0, lan and wan and a fourth on switch0, and one on two switches. edge and office are also
 * cabled to each other, and stand in one column. A cable with conditions and two storms give the nodes their longest
 * notes, ports in VLANs and a trunk their longest titles, and the spanning tree blocks a port.
 */
function crowd(): LabState {
	const leaves = [DEFAULT_SWITCH, lan, wan, dmz, edge, office, labs];
	const bridge = { priority: 32768, address: "02:00:00:00:00:06" };
	return lab(
		...[lan, wan, dmz, core, edge, office, labs].map(addSwitch),
		...leaves.map((leaf, i) => cable(port(core, i + 1), port(leaf, 8))),
		cable(port(edge, 7), port(office, 7)),
		spawnNamed(router, DEFAULT_SWITCH, lan),
		spawnNamed(database),
		spawnNamed(backup, DEFAULT_SWITCH, wan),
		spawn(1, DEFAULT_SWITCH, lan, wan, DEFAULT_SWITCH),
		spawn(2, lan),
		spawn(3, wan),
		...[dmz, edge, office].map((on) => spawn(2, on)),
		spawn(1, labs),
		ready(),
		vlan(port(lan, 1), 10),
		vlan(port(wan, 1), 20),
		vlan(port(dmz, 1), 30),
		trunk(port(core, 2), 1, 10, 20),
		trunk(port(lan, 8), 1, 10, 20),
		{ type: "cmd/conditions", changes: [{ port: port(core, 3), conditions: conditions({ delay: 20 }) }] },
		{ type: "cmd/stp", switches: [core, edge, office], on: true },
		{
			type: "switch/tree",
			switch: office,
			tree: {
				bridge,
				root: { ...bridge, address: "02:00:00:00:00:04" },
				cost: 20_000,
				ports: [
					{ port: 7, role: "alternate", state: "discarding" },
					{ port: 8, role: "root", state: "forwarding" },
				],
			},
		},
		storm(core, true),
		storm(lan, true),
	);
}

/** Names of 38, 35 and 20 characters and one as long as a name can be, one above the other, and cables past them. */
const wrapped = () =>
	lab(
		addSwitch(lan),
		spawnNamed(named("internal-router-east-building-two-rack"), DEFAULT_SWITCH, lan),
		spawnNamed(named("database-server-west-building-two-x")),
		spawnNamed(backup, DEFAULT_SWITCH, lan),
		spawnNamed(LONG_NAME),
		spawn(1, lan),
		ready(),
	);

/** lan cabled to itself twice, and to switch0. */
const looped = () =>
	lab(
		addSwitch(lan),
		cable(port(DEFAULT_SWITCH, 8), port(lan, 8)),
		cable(port(lan, 4), port(lan, 5)),
		cable(port(lan, 6), port(lan, 7)),
		spawn(2),
		spawn(1, lan),
		ready(),
	);

/** Four cables between switch0 and lan. */
const paired = () =>
	lab(
		addSwitch(lan),
		...[1, 2, 3, 4].map((n) => cable(port(DEFAULT_SWITCH, n), port(lan, n))),
		spawn(2),
		spawn(2, lan),
		ready(),
	);

/** Every node is drawn, every line ends at two of them, and nothing is over a name or a note, also with the map scrolled to its end. */
function expectReadable(map: HTMLElement, state: LabState, lines: () => string[]) {
	expect(map.querySelectorAll(".n-node")).toHaveLength(state.switches.length + state.rail.length);
	expect(lines().filter((line) => line.includes("nowhere"))).toEqual([]);
	expect(unreadable(map)).toEqual([]);
	const scroller = map.querySelector(".n-map-scroll");
	scroller?.scrollTo(scroller.scrollWidth, scroller.scrollHeight);
	expect(unreadable(map)).toEqual([]);
}

describe("every name and note in the Topology window can be read", () => {
	describe.each(SIZES)("%s", (size) => {
		it("with two cabled nodes in one column", async () => {
			const state = wired();
			const { map, lines } = await topology(state, size);
			expect(lines()).toContain("lan node3 up");
			expectReadable(map, state, lines);
		});

		it("with names that wrap to two, three and more lines", async () => {
			const state = wrapped();
			const { map, lines } = await topology(state, size);
			const height = (name: string) =>
				map.querySelector(`.n-node[data-machine="${name}"] strong`)?.getBoundingClientRect().height ?? 0;
			expect(height(backup)).toBeGreaterThan(1.5 * height("node5"));
			expect(height(LONG_NAME)).toBeGreaterThan(3.5 * height("node5"));
			expectReadable(map, state, lines);
		});

		it("with a switch cabled to itself twice, each cable a loop of its own", async () => {
			const state = looped();
			const { map, lines } = await topology(state, size);
			expect(lines().filter((line) => line === "lan lan up")).toHaveLength(2);
			expect(new Set([...map.querySelectorAll(".wire")].map((wire) => wire.getAttribute("d"))).size).toBe(6);
			expectReadable(map, state, lines);
		});

		it("with four cables between one pair of switches, each a line of its own", async () => {
			const state = paired();
			const { map, lines } = await topology(state, size);
			expect(lines().filter((line) => line === "switch0 lan up")).toHaveLength(4);
			expect(new Set([...map.querySelectorAll(".wire")].map((wire) => wire.getAttribute("d"))).size).toBe(8);
			expectReadable(map, state, lines);
		});

		it("with 16 machines and eight switches, long names, VLANs, a trunk, a delayed cable, storms and a blocked port", async () => {
			const state = crowd();
			expect([state.rail.length, state.switches.length]).toEqual([16, 8]);
			const { map, note, lines, titled } = await topology(state, size);
			expect([...map.querySelectorAll(".n-node strong")].map((name) => name.textContent).sort()).toEqual(
				[...state.switches, ...state.rail].sort(),
			);
			expect(note("node4")).toBe("alpine");
			expect(note(database)).toBe("alpine");
			expect(note("core")).toBe("7 / 8 ports · storming · impaired");
			expect(lines()).toContain("edge office blocked");
			expect(titled(router)).toBe("eth0 · to switch0 port 1 · up\neth1 · to lan port 1 · up · vlan 10");
			expectReadable(map, state, lines);
		});
	});
});

describe("the Topology window of machines with long names", () => {
	it("says no more in a note than the image and that a cable is impaired, and the rest in the title", async () => {
		const { note, titled } = await topology(
			lab(
				addSwitch(lan),
				addSwitch(wan),
				spawnNamed(router, DEFAULT_SWITCH, lan),
				spawnNamed(database),
				spawnNamed(backup, DEFAULT_SWITCH, wan),
				spawn(2),
				ready(),
				vlan(port(DEFAULT_SWITCH, 2), 10),
				vlan(port(lan, 1), 20),
				{
					type: "cmd/conditions",
					changes: [1, 2].map((n) => ({ port: port(DEFAULT_SWITCH, n), conditions: conditions({ delay: 30 }) })),
				},
			),
		);
		expect(note(router)).toBe("alpine · impaired");
		expect(note(database)).toBe("alpine · impaired");
		expect(titled(router)).toBe("eth0 · to switch0 port 1 · up · delay 30 ms\neth1 · to lan port 1 · up · vlan 20");
		expect(titled(database)).toBe("eth0 · to switch0 port 2 · up · vlan 10 · delay 30 ms");
	});
});
