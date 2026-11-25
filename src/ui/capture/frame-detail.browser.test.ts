import "./capture.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { testCapture } from "../../../test/support/capture.ts";
import { arpRequest, ping } from "../../../test/support/frames.ts";
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

describe("<unlab-frame-detail>", () => {
	async function selectArp() {
		const capture = testCapture();
		capture.at(1618_520);
		capture.frame(arpRequest(1, 3), 1, [2], "group");
		const mounted = await mount("unlab-frame-detail", { state: cutThree, capture: capture.log });
		const [seq] = [...capture.log.frames()].map((f) => f.seq);
		mounted.store.dispatchUi({ type: "ui/frame-selected", seq: seq ?? null });
		await mounted.settle();
		return { ...mounted, capture, seq };
	}

	it("says nothing is selected until a frame is", async () => {
		const { element } = await mount("unlab-frame-detail", { state: cutThree, capture: testCapture().log });
		expect(text(element)).toContain("Nothing selected");
	});

	it("heads the selected frame with its number, size, time and ingress port", async () => {
		const { element, seq } = await selectArp();
		expect(text(part(element, ".head"))).toBe(`frame ${seq} 42 bytes · 1618.52 s · in on port 1`);
	});

	it("decodes ethernet II and the protocol above it, naming machines in their hues", async () => {
		const { element } = await selectArp();
		const titles = [...element.querySelectorAll("h3")].map(text);
		expect(titles).toEqual(["ethernet II", "arp request", "what switch0 did", "bytes"]);
		const source = [...element.querySelectorAll(".pair")].find((f) => text(f.querySelector("dt")) === "source");
		expect(text(source?.querySelector("dd"))).toBe("52:54:00:88:00:0b node1");
		expect(colour(part(source ?? element, ".machine"))).toBe(tokenColor("hue-1"));
	});

	it("says in plain sentences what switch0 did, with machine names in their hues", async () => {
		const { element } = await selectArp();
		const did = part(element, ".did");
		expect(text(did)).toBe(
			"Broadcast, so sent out every live port: delivered to node2 on port 2. Port 3 was down, so node3 never saw it.",
		);
		expect([...did.querySelectorAll(".machine")].map((m) => [m.textContent, colour(m)])).toEqual([
			["node2", tokenColor("hue-2")],
			["node3", tokenColor("hue-3")],
		]);
	});

	it("dumps the bytes 16 to a row, painting a machine's MAC and IP bytes in its hue", async () => {
		const { element } = await selectArp();
		const lines = [...element.querySelectorAll(".dump .line")];
		expect(lines.map((l) => l.textContent)).toEqual([
			"0000  ff ff ff ff ff ff 52 54 00 88 00 0b 08 06 00 01",
			"0010  08 00 06 04 00 01 52 54 00 88 00 0b 0a 58 00 0b",
			"0020  00 00 00 00 00 00 0a 58 00 0d",
		]);
		const painted = [...element.querySelectorAll(".dump .machine")].map((m) => [m.textContent, colour(m)]);
		expect(painted).toEqual([
			["52 54 00 88 00 0b", tokenColor("hue-1")],
			["52 54 00 88 00 0b", tokenColor("hue-1")],
			["0a 58 00 0b", tokenColor("hue-1")],
			["0a 58 00 0d", tokenColor("hue-3")],
		]);
	});

	it("goes back to nothing selected when the capture is cleared", async () => {
		const { element, capture, settle } = await selectArp();
		capture.log.clear();
		await settle();
		expect(text(element)).toContain("Nothing selected");
	});
});

/** node3's cable cut mid-ping, then node1 asking for node3 unanswered. */
function cutMidPing() {
	const capture = testCapture();
	const at = (s: number) => capture.at(Math.round(s * 1000));
	at(1612.4);
	capture.frame(ping(1, 3, 4), 1, [3]);
	capture.frame(ping(3, 1, 4, 0), 3, [1]);
	at(1612.87);
	capture.link(3, "node3", false, "runtime");
	for (const [t, seq] of [
		[1613.4, 5],
		[1614.4, 6],
		[1615.4, 7],
	] as const) {
		at(t);
		capture.frame(ping(1, 3, seq), 1, [2], "unknown");
	}
	for (const t of [1618.52, 1619.52, 1620.52]) {
		at(t);
		capture.frame(arpRequest(1, 3), 1, [2], "group");
	}
	capture.log.sweep(1622_000);
	return capture;
}

describe("the maximised capture", () => {
	const mountFull = (capture: ReturnType<typeof testCapture>) =>
		mount("unlab-capture", {
			state: cutThree,
			capture: capture.log,
			prepare: (el) => el.setAttribute("mode", "full"),
		});

	it("shows the frame the arrow keys select in the detail beside the list", async () => {
		const capture = testCapture();
		capture.frame(ping(1, 2, 1), 1, [2]);
		capture.frame(ping(2, 1, 1, 0), 2, [1]);
		const { element, settle } = await mountFull(capture);
		const list = page.getByRole("listbox", { name: "Captured frames" });
		(list.element() as HTMLElement).focus();
		await userEvent.keyboard("{ArrowUp}");
		await settle();
		expect(text(part(element, "unlab-frame-detail h3:nth-of-type(1)"))).toBe("ethernet II");
		expect(text(part(element, "unlab-frame-detail .did"))).toBe(
			"switch0 had learned node1 on port 1, so it forwarded the frame there only.",
		);
	});

	it("passes axe with a frame selected", async () => {
		const { element, store, settle } = await mountFull(cutMidPing());
		store.dispatchUi({ type: "ui/frame-selected", seq: 1 });
		await settle();
		const results = await axe.run(element);
		const failures = results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} at ${n.target.join(" ")}`));
		expect(failures).toEqual([]);
	});
});
