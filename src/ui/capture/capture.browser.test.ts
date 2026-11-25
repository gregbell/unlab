import "./capture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { testCapture } from "../../../test/support/capture.ts";
import { arpReply, arpRequest, mac, ping, routedPing } from "../../../test/support/frames.ts";
import { selectNames } from "../../model/index.ts";
import {
	LONG_NAME,
	lab,
	mount,
	named,
	ready,
	remove,
	spawn,
	spawnNamed,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";
import type { CaptureMode } from "./capture.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(() => {
	unmountAll();
	vi.restoreAllMocks();
});

const threeUp = lab(spawn(3), ready());

async function mountCapture(mode: CaptureMode, fill: (c: ReturnType<typeof testCapture>) => void = () => {}) {
	const capture = testCapture();
	fill(capture);
	const mounted = await mount("unlab-capture", {
		state: threeUp,
		capture: capture.log,
		onEffect: capture.onEffect,
		prepare: (el) => el.setAttribute("mode", mode),
	});
	capture.follow(mounted.store);
	return { ...mounted, capture };
}

/** Twelve pings from node1 to node2, a second apart, seq 1 to 12. */
function twelvePings(c: ReturnType<typeof testCapture>): void {
	for (let seq = 1; seq <= 12; seq++) {
		c.at(seq * 1000);
		c.frame(ping(1, 2, seq), 1, [2]);
	}
}

const rows = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(".row:not(.heading)")];
const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const colour = (element: Element | null) => (element ? getComputedStyle(element).color : "missing");

function part(element: Element, selector: string): HTMLElement {
	const found = element.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`no ${selector}`);
	return found;
}

describe("<unlab-capture mode=dock>", () => {
	it("shows the last eight rows, oldest first", async () => {
		const { element } = await mountCapture("dock", twelvePings);
		const shown = rows(element);
		expect(shown).toHaveLength(8);
		expect(text(shown[0])).toBe("5.00 ICMP node1 → node2 echo request seq 5, 64 bytes");
		expect(text(shown[7])).toBe("12.00 ICMP node1 → node2 echo request seq 12, 64 bytes");
		for (const row of shown) expect(row.getBoundingClientRect().height).toBe(22);
	});

	it("names a machine's NIC in its hue, for a NIC past eth0", async () => {
		const { element } = await mountCapture("dock", (c) => c.frame(routedPing(mac(2, 1), mac(3), 1, 3), 2, [3]));
		expect(text(rows(element)[0])).toContain("node2:eth1 → node3");
		expect(colour(part(element, ".route .machine"))).toBe(tokenColor("hue-2"));
	});

	it("adds new rows as they arrive", async () => {
		const { element, capture, settle } = await mountCapture("dock", twelvePings);
		capture.at(13_000);
		capture.frame(ping(2, 1, 12, 0), 2, [1]);
		await settle();
		expect(text(rows(element).at(-1))).toBe("13.00 ICMP node2 → node1 echo reply seq 12, 64 bytes");
	});

	it("paints machine names in their hues and broadcast as everyone in --text-3", async () => {
		const { element } = await mountCapture("dock", (c) => c.frame(arpRequest(1, 3), 1, [2, 3], "group"));
		const [row] = rows(element);
		if (!row) throw new Error("no row");
		expect(colour(part(row, ".machine"))).toBe(tokenColor("hue-1"));
		expect(text(part(row, ".everyone"))).toBe("everyone");
		expect(colour(part(row, ".everyone"))).toBe(tokenColor("text-3"));
		expect(colour(part(row, ".time"))).toBe(tokenColor("text-3"));
		expect(colour(part(row, ".info"))).toBe(tokenColor("text-2"));
	});

	it("follows the info with the switch's annotation after a middle dot, in --warn", async () => {
		const { element } = await mountCapture("dock", (c) => c.frame(ping(1, 3, 5), 1, [2], "unknown"));
		const note = part(element, ".note");
		expect(note.textContent).toBe(" · unknown destination, flooded to port 2");
		expect(colour(note)).toBe(tokenColor("warn"));
	});

	it("writes link changes as event rows between dashed rules, red down and green up", async () => {
		const { element } = await mountCapture("dock", (c) => {
			c.at(1612_870);
			c.link(2, "node2", false, "agent");
			c.at(1613_000);
			c.link(2, "node2", true, "button");
		});
		const [down, up] = [...element.querySelectorAll(".row.event")];
		expect(text(down)).toBe("1612.87 port 2 link down. Cable to node2 cut by the agent.");
		expect(text(up)).toBe("1613.00 port 2 link up. Cable to node2 reconnected by you.");
		expect(colour(down ?? null)).toBe(tokenColor("down"));
		expect(colour(up ?? null)).toBe(tokenColor("ok"));
		if (!down) throw new Error("no event row");
		const style = getComputedStyle(down);
		expect([style.borderTopStyle, style.borderBottomStyle]).toEqual(["dashed", "dashed"]);
		expect(style.borderTopColor).toBe(tokenColor("down"));
	});

	it("filters the list by what is typed", async () => {
		const { element, capture, store, settle } = await mountCapture("dock", (c) => {
			c.frame(arpRequest(1, 2), 1, [2, 3], "group");
			c.frame(arpReply(2, 1), 2, [1]);
			c.frame(ping(1, 2), 1, [2]);
		});
		await userEvent.fill(page.getByRole("textbox", { name: "filter" }), "icmp");
		await settle();
		expect(store.state.capture.filter).toBe("icmp");
		expect(capture.log.matchedFrames).toBe(1);
		expect(rows(element).map((r) => text(part(r, ".proto")))).toEqual(["ICMP"]);
	});

	it("turns the field border red on a term it cannot read and leaves the list alone", async () => {
		const { element, settle } = await mountCapture("dock", twelvePings);
		const before = rows(element).map(text);
		const field = page.getByRole("textbox", { name: "filter" });
		await userEvent.fill(field, "icmp nodez");
		await settle();
		await expect.element(field).toHaveAttribute("aria-invalid", "true");
		await expect.element(field).toHaveAccessibleDescription("Capture cannot read nodez.");
		expect(getComputedStyle(part(element, ".filter")).borderTopColor).toBe(tokenColor("down"));
		expect(rows(element).map(text)).toEqual(before);

		await userEvent.fill(field, "icmp");
		await settle();
		await expect.element(field).toHaveAttribute("aria-invalid", "false");
		expect(getComputedStyle(part(element, ".filter")).borderTopColor).not.toBe(tokenColor("down"));
	});

	it("pauses: the button reads resume, live becomes paused in --warn, and no rows are added", async () => {
		const { element, capture, settle } = await mountCapture("dock", twelvePings);
		const status = part(element, ".status");
		expect([status.textContent, colour(status)]).toEqual(["live", tokenColor("ok")]);

		await userEvent.click(page.getByRole("button", { name: "pause" }));
		await settle();
		expect([status.textContent, colour(status)]).toEqual(["paused", tokenColor("warn")]);
		await expect.element(page.getByRole("button", { name: "resume" })).toBeVisible();

		const before = rows(element).map(text);
		capture.frame(ping(2, 1, 1, 0), 2, [1]);
		await settle();
		expect(rows(element).map(text)).toEqual(before);
		expect(text(part(element, ".counters"))).toBe("13 in · 13 delivered · 0 flooded");

		await userEvent.click(page.getByRole("button", { name: "resume" }));
		await settle();
		expect(status.textContent).toBe("live");
	});

	it("clears the list and keeps the counters running", async () => {
		const { element, capture, settle } = await mountCapture("dock", (c) => {
			twelvePings(c);
			c.frame(arpRequest(1, 3), 1, [2, 3], "group");
		});
		expect(text(part(element, ".counters"))).toBe("13 in · 14 delivered · 1 flooded");
		await userEvent.click(page.getByRole("button", { name: "clear" }));
		await settle();
		expect(rows(element)).toHaveLength(0);
		expect(text(part(element, ".counters"))).toBe("13 in · 14 delivered · 1 flooded");
		capture.frame(ping(1, 2), 1, [2]);
		await settle();
		expect(rows(element)).toHaveLength(1);
		expect(text(part(element, ".counters"))).toBe("14 in · 15 delivered · 1 flooded");
	});

	it("maximises and parks itself alone", async () => {
		const { store } = await mountCapture("dock");
		await userEvent.click(page.getByRole("button", { name: "Maximise capture" }));
		expect(store.state.panels).toMatchObject({ open: ["capture", "switch0"], maximised: "capture" });
		await userEvent.click(page.getByRole("button", { name: "Park capture" }));
		expect(store.state.panels).toMatchObject({ open: ["switch0"], maximised: null });
	});

	it.each([1200, 585, 390, 330])("keeps its toolbar on one line at %ipx, every button in it", async (width) => {
		const { element, settle } = await mountCapture("dock", twelvePings);
		element.style.width = `${width}px`;
		await settle();
		const toolbar = part(element, ".toolbar");
		expect(toolbar.getBoundingClientRect().height).toBe(35);
		expect(toolbar.scrollWidth).toBe(toolbar.clientWidth);
		for (const name of ["pause", "clear", "Maximise capture", "Park capture"])
			await expect.element(page.getByRole("button", { name })).toBeVisible();
	});

	it("cuts a long row short instead of growing a scrollbar, with the whole text at hand", async () => {
		const { element, settle } = await mountCapture("dock", (c) => c.frame(arpRequest(1, 3), 1, [2, 3], "group"));
		element.style.width = "400px";
		await settle();
		const info = part(element, ".info");
		expect(info.scrollWidth).toBeGreaterThan(info.clientWidth);
		expect(info.title).toBe("who has 10.88.0.13? tell 10.88.0.11 · flooded to ports 2 and 3");
		expect(getComputedStyle(part(element, ".rows")).overflowX).toBe("hidden");
	});

	it("is never a live region", async () => {
		const { element } = await mountCapture("dock", twelvePings);
		expect(element.querySelector("[aria-live], [role=log], [role=status], [role=alert]")).toBeNull();
	});
});

describe("<unlab-capture mode=full>", () => {
	it("counts matches beside the filter and shows the length column", async () => {
		const { element, settle } = await mountCapture("full", (c) => {
			twelvePings(c);
			c.frame(arpRequest(1, 3), 1, [2, 3], "group");
		});
		expect(text(part(element, ".matches"))).toBe("13 of 13 frames");
		await userEvent.fill(page.getByRole("textbox", { name: "filter" }), "arp");
		await settle();
		expect(text(part(element, ".matches"))).toBe("1 of 13 frames");
		const [row] = rows(element);
		expect(text(row)).toBe(
			"12.00 ARP node1 → everyone 42 who has 10.88.0.13? tell 10.88.0.11 · flooded to ports 2 and 3",
		);
		expect(row?.getBoundingClientRect().height).toBe(26);
	});

	it("renders only the rows near the viewport, however many there are", async () => {
		const { element } = await mountCapture("full", (c) => {
			for (let seq = 1; seq <= 3000; seq++) c.frame(ping(1, 2, seq), 1, [2]);
		});
		expect(rows(element).length).toBeLessThan(80);
		await expect.element(page.getByRole("option", { name: /seq 3000,/ })).toBeVisible();
	});

	it("follows new rows at the bottom and stops following once scrolled up", async () => {
		const { element, capture, settle } = await mountCapture("full", (c) => {
			for (let seq = 1; seq <= 500; seq++) c.frame(ping(1, 2, seq), 1, [2]);
		});
		const scroller = part(element, ".rows");
		capture.frame(ping(1, 2, 501), 1, [2]);
		await settle();
		await expect.element(page.getByRole("option", { name: /seq 501,/ })).toBeVisible();

		scroller.scrollTop = 0;
		scroller.dispatchEvent(new Event("scroll"));
		await settle();
		capture.frame(ping(1, 2, 502), 1, [2]);
		await settle();
		expect(scroller.scrollTop).toBe(0);
		await expect.element(page.getByRole("option", { name: /seq 1,/ })).toBeVisible();
	});

	it("moves the selection with the arrow keys, skipping event rows, and fills the selected row", async () => {
		const { element, store, settle } = await mountCapture("full", (c) => {
			c.frame(ping(1, 2, 1), 1, [2]);
			c.link(2, "node2", false);
			c.frame(ping(3, 1, 2), 3, [1]);
		});
		const list = page.getByRole("listbox", { name: "Captured frames" });
		await userEvent.click(page.getByRole("option", { name: /seq 1,/ }));
		await settle();
		const first = store.state.capture.selected;
		expect(first).not.toBeNull();

		await userEvent.keyboard("{ArrowDown}");
		await settle();
		const selected = part(element, "[aria-selected=true]");
		expect(text(part(selected, ".route"))).toBe("node3 → node1");
		await expect.element(list).toHaveAttribute("aria-activedescendant", selected.id);
		const style = getComputedStyle(selected);
		expect(style.backgroundColor).toBe(tokenColor("line"));
		expect([style.borderLeftWidth, style.borderLeftColor]).toEqual(["3px", tokenColor("hue-3")]);

		await userEvent.keyboard("{ArrowUp}");
		await settle();
		expect(store.state.capture.selected).toBe(first);
		expect(element.querySelectorAll("[aria-selected=true]")).toHaveLength(1);
	});

	it("saves every frame in the buffer as a pcap file, ignoring the filter", async () => {
		const blobs: Blob[] = [];
		vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
			if (blob instanceof Blob) blobs.push(blob);
			return "blob:unlab-test";
		});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const { settle } = await mountCapture("full", twelvePings);
		await userEvent.fill(page.getByRole("textbox", { name: "filter" }), "arp");
		await settle();
		await userEvent.click(page.getByRole("button", { name: "save .pcap" }));

		expect(blobs).toHaveLength(1);
		const bytes = new Uint8Array(await (blobs[0] ?? new Blob()).arrayBuffer());
		expect([...bytes.subarray(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
		const frameBytes = ping(1, 2, 1).length;
		expect(bytes.length).toBe(24 + 12 * (16 + frameBytes));
	});
});

describe("<unlab-capture> maximised and restored", () => {
	it("follows the newest row each time, whatever it was scrolled to before", async () => {
		const { element, capture, settle } = await mountCapture("dock", (c) => {
			for (let seq = 1; seq <= 500; seq++) c.frame(ping(1, 2, seq), 1, [2]);
		});
		element.setAttribute("mode", "full");
		await settle();
		await expect.element(page.getByRole("option", { name: /seq 500,/ })).toBeVisible();
		part(element, ".rows").scrollTop = 0;
		await expect.element(page.getByRole("option", { name: /seq 1,/ })).toBeVisible();

		element.setAttribute("mode", "dock");
		await settle();
		expect(rows(element)).toHaveLength(8);
		capture.frame(ping(1, 2, 501), 1, [2]);
		element.setAttribute("mode", "full");
		await settle();
		await expect.element(page.getByRole("option", { name: /seq 501,/ })).toBeVisible();
	});

	it("keeps the focus on the button that maximised it", async () => {
		const { element, settle } = await mountCapture("dock");
		await userEvent.click(page.getByRole("button", { name: "Maximise capture" }));
		element.setAttribute("mode", "full");
		await settle();
		await expect.element(page.getByRole("button", { name: "Maximise capture" })).toHaveFocus();
		await expect
			.element(page.getByRole("button", { name: "Maximise capture" }))
			.toHaveAttribute("aria-pressed", "true");
	});
});

describe("a machine with a long name", () => {
	it.each(["dock", "full"] as const)("is cut short in a %s row, which still shows both ends", async (mode) => {
		const capture = testCapture();
		const state = lab(spawnNamed(LONG_NAME), spawnNamed(named("b".repeat(40))), ready());
		capture.names(selectNames(state));
		capture.frame(ping(1, 2), 1, [2]);
		capture.frame(ping(1, 4), 1, [4]);
		capture.frame(ping(3, 4), 3, [4]);
		const { element } = await mount("unlab-capture", {
			state,
			capture: capture.log,
			prepare: (el) => el.setAttribute("mode", mode),
		});
		const [long, between, short] = rows(element);
		const route = part(long, ".route");
		expect(route.title).toBe(`${LONG_NAME} → ${"b".repeat(40)}`);
		for (const end of route.querySelectorAll<HTMLElement>(".machine")) {
			expect(end.scrollWidth).toBeGreaterThan(end.clientWidth);
			expect(end.clientWidth).toBeGreaterThan(40);
			expect(end.getBoundingClientRect().right).toBeLessThanOrEqual(route.getBoundingClientRect().right);
		}
		const mixed = part(between, ".route").querySelectorAll<HTMLElement>(".machine");
		expect([...mixed].map((end) => end.scrollWidth > end.clientWidth)).toEqual([true, false]);
		expect(part(long, ".info").getBoundingClientRect().left).toBe(part(short, ".info").getBoundingClientRect().left);
		expect(text(part(short, ".route"))).toBe("node3 → node4");
		const [from, to] = part(short, ".route").querySelectorAll(".machine");
		expect(to.getBoundingClientRect().left - from.getBoundingClientRect().right).toBeLessThan(30);
	});

	it("is not painted in the hue of the next machine of its name", async () => {
		const web = named("web");
		const capture = testCapture();
		const first = lab(spawnNamed(web), ready());
		const next = lab(
			spawnNamed(web),
			ready(),
			remove(web),
			{ type: "vm/stopped", machine: web, attempt: 1, clean: true, at: 0 },
			spawnNamed(web),
		);
		capture.names(selectNames(first));
		capture.frame(ping(1, 8), 1, []);
		capture.names(selectNames(next));
		capture.frame(ping(2, 8), 1, []);
		const { element } = await mount("unlab-capture", {
			state: next,
			capture: capture.log,
			prepare: (el) => el.setAttribute("mode", "dock"),
		});
		expect(rows(element).map((row) => [text(part(row, ".route")), row.dataset.hue])).toEqual([
			["web → node8", undefined],
			["web → node8", "1"],
		]);
	});
});
