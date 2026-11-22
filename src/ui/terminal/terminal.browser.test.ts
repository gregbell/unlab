import "./terminal.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { lab, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";
import type { TerminalService } from "../services.ts";
import type { UnlabTerminal } from "./terminal.ts";
import { fakeTerminals } from "./testing.ts";

beforeEach(() => page.viewport(1200, 800));
afterEach(unmountAll);

async function mountTerminal(terminals: TerminalService, visible = true) {
	return mount("unlab-terminal", {
		state: lab(spawn(1), ready()),
		terminals,
		prepare: (element) => {
			element.session = "node1:console";
			element.visible = visible;
			element.style.height = "300px";
		},
	});
}

function rules(terminal: UnlabTerminal) {
	const top = terminal.getBoundingClientRect().top;
	const left = terminal.getBoundingClientRect().left;
	return [...terminal.querySelectorAll<HTMLElement>(".rule")].map((rule) => {
		const box = rule.getBoundingClientRect();
		return {
			top: box.top - top,
			left: box.left - left,
			width: box.width,
			height: box.height,
			colour: getComputedStyle(rule).backgroundColor,
		};
	});
}

describe("<unlab-terminal>", () => {
	it("mounts its session's screen once, inside itself, and keeps it through renders", async () => {
		const terminals = fakeTerminals();
		const { element, settle } = await mountTerminal(terminals.service);
		const host = terminals.host("node1:console");
		expect(host.mounts).toHaveLength(1);
		expect(element.contains(host.mounts[0] ?? null)).toBe(true);
		host.render([{ fromRow: 0, toRow: 0, source: "bar" }]);
		await settle();
		element.visible = false;
		await settle();
		expect(host.mounts).toHaveLength(1);
		expect(element.contains(host.input)).toBe(true);
	});

	it("tells the screen only when it is shown, hidden, focused or let go", async () => {
		const terminals = fakeTerminals();
		const { element, settle } = await mountTerminal(terminals.service);
		const host = terminals.host("node1:console");
		expect([host.visible, host.focused]).toEqual([[true], [false]]);
		host.render([]);
		await settle();
		element.focused = true;
		await settle();
		element.visible = false;
		element.focused = false;
		await settle();
		expect([host.visible, host.focused]).toEqual([
			[true, false],
			[false, true, false],
		]);
	});

	it("waits for a screen that does not exist yet and mounts it on a later render", async () => {
		const terminals = fakeTerminals();
		let ready = false;
		const { element, settle } = await mountTerminal({ host: (session) => (ready ? terminals.host(session) : null) });
		ready = true;
		element.focused = true;
		await settle();
		const host = terminals.host("node1:console");
		expect(host.mounts).toHaveLength(1);
		expect([host.visible, host.focused]).toEqual([[true], [true]]);
	});

	it("draws a 2px rule at the left edge over each mark's rows: --text-3 from the bar, --agent from the agent", async () => {
		const terminals = fakeTerminals();
		const { element, settle } = await mountTerminal(terminals.service);
		const host = terminals.host("node1:console");
		expect(rules(element)).toEqual([]);

		// Rows are 20px under 10px of padding: rows 2 and 3 are y 50 to 90, row 5 is y 110 to 130.
		host.render([
			{ fromRow: 2, toRow: 3, source: "bar" },
			{ fromRow: 5, toRow: 5, source: "agent" },
		]);
		await settle();
		expect(rules(element)).toEqual([
			{ top: 50, left: 0, width: 2, height: 40, colour: tokenColor("text-3") },
			{ top: 110, left: 0, width: 2, height: 20, colour: tokenColor("agent") },
		]);

		host.render([{ fromRow: -0.5, toRow: 0.5, source: "bar" }]);
		await settle();
		expect(rules(element)).toEqual([{ top: 0, left: 0, width: 2, height: 40, colour: tokenColor("text-3") }]);

		host.render([]);
		await settle();
		expect(rules(element)).toEqual([]);
	});

	it("stops redrawing the gutter once it leaves the document", async () => {
		const terminals = fakeTerminals();
		const { element } = await mountTerminal(terminals.service);
		element.remove();
		terminals.host("node1:console").render([{ fromRow: 0, toRow: 0, source: "bar" }]);
		expect(element.isUpdatePending).toBe(false);
	});
});
