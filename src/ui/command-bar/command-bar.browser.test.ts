import "./command-bar.ts";
import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
	type CommandService,
	createRegistry,
	type ExecOutcome,
	isLineError,
	parseLine,
	VERBS,
} from "../../commands/index.ts";
import type { LabEvent, LabState, Source, Store } from "../../model/index.ts";
import { focus, lab, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";
import type { AppServices } from "../services.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(() => {
	unmountAll();
	for (const extra of document.querySelectorAll("textarea.outside")) extra.remove();
});

const MINUTE = 60_000;
const NOW = 40 * MINUTE;
const PING = "ping -c 1 -W 1 10.88.0.13";
const LOSS = "1 packets transmitted, 0 packets received, 100% packet loss";
const OK = "1 packets transmitted, 1 packets received, 0% packet loss";

const logged = (line: string, source: Source, at: number): LabEvent => ({
	type: "cmd/logged",
	line,
	source,
	at,
	outcome: "ok",
});

const threeReady = (...more: LabEvent[]): LabState =>
	lab(spawn(3), ready(), focus("node2"), { type: "tick", now: NOW }, ...more);

/** The CmdOpen lab: three machines, the last three lines run by you, the agent and you. */
const withHistory = (): LabState =>
	threeReady(
		logged("spawn 3 alpine --net switch0", "bar", NOW - 31 * MINUTE),
		logged(`exec node1 -- ping -c 2 -W 1 10.88.0.13`, "agent", NOW - 2 * MINUTE),
		logged("link down node3", "bar", NOW - 2 * MINUTE),
	);

/** A shell's answers to the CmdFanout line, as the runtime's exec port reports them. */
const RECORDED: Record<string, ExecOutcome> = {
	"node1:console": { exitCode: 1, output: LOSS, truncated: false, lastLine: LOSS, ms: 1000 },
	"node2:console": { exitCode: 1, output: LOSS, truncated: false, lastLine: LOSS, ms: 1000 },
	"node3:console": { exitCode: 0, output: OK, truncated: false, lastLine: OK, ms: 400 },
};

/** Safe lines run on the real verbs, with the recorded exec answers and a clock one second on, and are still recorded. */
function recordedRun(services: AppServices): CommandService["run"] {
	const record = services.commands.run;
	let clock = 0;
	const registry = createRegistry(
		{
			state: () => services.store.state,
			dispatch: () => {},
			until: (predicate, signal) => services.store.until(predicate, signal),
			now: () => clock,
			exec: {
				inject: async (session) => {
					clock = 1000;
					const outcome = RECORDED[session];
					if (!outcome) throw new Error(`no recording for ${session}`);
					return outcome;
				},
			},
		},
		VERBS,
	);
	return async (line, source, signal = new AbortController().signal) => {
		await record(line, source, signal);
		const parsed = parseLine(registry, line, services.store.state);
		if (isLineError(parsed)) return parsed;
		if (parsed.danger) throw new Error(`${line} needs an approval`);
		return parsed.run({ source, signal });
	};
}

/** What the engine does once rm's event lands: the machine stops and is gone. */
function removedByTheRuntime(store: Store, machine: "node3"): void {
	store.dispatchCommand({ type: "cmd/remove", machines: [machine], cause: "bar" });
	store.dispatchRuntime({ type: "vm/stopped", machine, attempt: 1 });
}

async function mountBar(state: LabState = threeReady(), options: { recorded?: boolean } = {}) {
	return mount("unlab-command-bar", {
		state,
		prepare: (_element, services) => {
			if (options.recorded) services.commands.run = recordedRun(services);
		},
	});
}

function the<E extends Element = HTMLElement>(selector: string): E {
	const found = document.querySelector<E>(`unlab-command-bar ${selector}`);
	if (!found) throw new Error(`no ${selector} in the bar`);
	return found;
}

const input = (): HTMLInputElement => the<HTMLInputElement>("input");
const texts = (selector: string): string[] =>
	[...document.querySelectorAll(`unlab-command-bar ${selector}`)].map((e) =>
		(e.textContent ?? "").replace(/\s+/g, " ").trim(),
	);
const text = (selector: string): string => (the(selector).textContent ?? "").replace(/\s+/g, " ").trim();
const box = (selector: string): DOMRect => the(selector).getBoundingClientRect();
const style = (selector: string): CSSStyleDeclaration => getComputedStyle(the(selector));
const isOpen = (): boolean => document.querySelector("unlab-command-bar")?.hasAttribute("open") ?? false;

async function openByClick(): Promise<void> {
	await userEvent.click(input());
}

async function typeLine(line: string): Promise<void> {
	await openByClick();
	await userEvent.keyboard(line);
}

async function axeViolations(): Promise<string[]> {
	const { violations } = await axe.run(the(".panel"));
	return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

describe("<unlab-command-bar> at rest", () => {
	it("is the 36px palette in an empty lab and the shortcut hint", async () => {
		await mountBar(lab());
		expect(box(".panel").height).toBe(36);
		expect(input().placeholder).toBe("Command bar");
		expect(input().getAttribute("role")).toBe("combobox");
		expect(input().getAttribute("aria-expanded")).toBe("false");
		expect(text(".hint")).toBe("Ctrl+/");
		expect(isOpen()).toBe(false);
	});

	it("shows the last line run as its placeholder", async () => {
		await mountBar(withHistory());
		expect(input().placeholder).toBe("link down node3");
	});
});

describe("<unlab-command-bar> CmdOpen: just opened", () => {
	it("opens on a click into a 720px panel on the field's top-left corner", async () => {
		const { store } = await mountBar(withHistory());
		const field = box(".panel");
		await openByClick();
		const panel = box(".panel");
		expect([panel.left, panel.top, panel.width]).toEqual([field.left, field.top, 720]);
		expect(style(".panel").backgroundColor).toBe(tokenColor("mantle"));
		expect(style(".panel").borderTopColor).toBe(tokenColor("line-strong"));
		expect(style(".panel").borderTopLeftRadius).toBe("0px");
		expect(box(".input-row").height).toBe(44);
		expect(style(".prompt").color).toBe(tokenColor("ok"));
		expect(style("input").fontSize).toBe("14px");
		expect(document.activeElement).toBe(input());
		expect(store.state.keyboard.kind).toBe("bar");
	});

	it("lists the last three lines under recent, the agent's with a blue rule, then the verbs", async () => {
		await mountBar(withHistory());
		await openByClick();
		expect(texts(".group-label")).toEqual(["recent", "verbs"]);
		expect(texts('[data-kind="recent"] .line')).toEqual([
			"link down node3",
			"exec node1 -- ping -c 2 -W 1 10.88.0.13",
			"spawn 3 alpine --net switch0",
		]);
		expect(texts('[data-kind="recent"] .who')).toEqual(["you · 2 min ago", "agent · 2 min ago", "you · 31 min ago"]);
		const agent = the('[data-source="agent"]');
		expect(getComputedStyle(agent).borderLeftColor).toBe(tokenColor("agent"));
		expect(getComputedStyle(agent).borderLeftWidth).toBe("2px");
		expect(getComputedStyle(the('[data-kind="recent"] .machine')).color).toBe(tokenColor("hue-3"));
		expect(texts('[data-kind="verb"] .verb')).toEqual([
			"spawn",
			"rm",
			"ls",
			"exec",
			"sh",
			"link",
			"capture",
			"focus",
			"boot",
		]);
		const listbox = the('[role="listbox"]');
		expect(listbox.offsetHeight).toBe(8 * 32 + 2 * 28);
		expect(listbox.scrollHeight).toBeGreaterThan(listbox.clientHeight);
		expect(text('[aria-selected="true"]')).toMatch(/^spawn <count> <image>/);
		expect(input().getAttribute("aria-activedescendant")).toBe(the('[aria-selected="true"]').id);
		expect(style('[aria-selected="true"]').backgroundColor).toBe(tokenColor("line"));
		expect(box('[role="option"]').height).toBe(32);
		expect(text(".hint")).toBe("tab → spawn");
		expect(texts(".keys span")).toEqual(["tab complete", "↑↓ choose", "↵ run", "esc close"]);
		expect(box(".keys").height).toBe(28);
		expect(style(".keys").backgroundColor).toBe(tokenColor("crust"));
		expect(style(".keys").fontSize).toBe("11px");
	});

	it("dims nothing behind it", async () => {
		await mountBar();
		await openByClick();
		expect(document.querySelectorAll("unlab-command-bar ~ *, .backdrop, dialog").length).toBe(0);
	});
});

describe("<unlab-command-bar> CmdComplete: completing", () => {
	it("chooses the first image, names Tab in the hint, underlines <image> and previews the line", async () => {
		await mountBar();
		await typeLine("spawn 2 alp");
		expect(text(".hint")).toBe("tab → alpine");
		expect(text(".signature")).toBe(
			"spawn <count> <image> [--mem MiB] [--cpus CPUs] [--disk 4 | 8 | 16 | 32 | 64] [--name name] [--nics NICs] [--net network,... | --no-net] [--addr address,...] [--no-gateway]",
		);
		expect(text(".signature .current")).toBe("<image>");
		expect(style(".signature .current").textDecorationLine).toBe("underline");
		expect(style(".signature .current").color).toBe(tokenColor("text"));
		expect(texts('[role="option"]')).toEqual(["alpine alpine 3.24"]);
		expect(the('[role="option"]').getAttribute("aria-selected")).toBe("true");
		expect(text('[role="status"] .preview .label')).toBe("will");
		expect(text('[role="status"] .will')).toBe(
			"boot node4 and node5 · alpine 3.24 · 256 MiB each · 2 CPUs · 4 GiB disk · plugged into switch0 on ports 4 and 5",
		);
		expect(text('[role="status"] .assumed')).toBe(
			"Left out, so assumed: --mem 256 --cpus 2 --disk 4 --nics 1 --net switch0",
		);
		expect(box(".assumed").left).toBe(box(".will").left);
	});

	it("takes the suggestion on Tab and adds a space", async () => {
		await mountBar();
		await typeLine("spawn 2 alp");
		await userEvent.keyboard("{Tab}");
		expect(input().value).toBe("spawn 2 alpine ");
		expect(input().selectionStart).toBe("spawn 2 alpine ".length);
		expect(document.activeElement).toBe(input());
	});

	it("colours machines in their hue with address and link state, and the arrows move the choice", async () => {
		await mountBar();
		await typeLine("link down ");
		expect(texts('[role="option"] .value')).toEqual(["node1", "node2", "node3", "all"]);
		expect(getComputedStyle(the('[role="option"] .value')).color).toBe(tokenColor("hue-1"));
		expect(text('[role="option"] .note')).toBe("10.88.0.11 · up");
		await userEvent.keyboard("{ArrowDown}");
		expect(text(".hint")).toBe("tab → node2");
	});
});

describe("<unlab-command-bar> CmdError: a typo", () => {
	it("shows nothing wrong while typing, then the line with carets under the token on Enter", async () => {
		await mountBar();
		await typeLine("link dwon node3");
		expect(document.querySelector('unlab-command-bar [role="alert"]')).toBeNull();
		await userEvent.keyboard("{Enter}");
		expect(texts(".echo > div")).toEqual(["link dwon node3", "^^^^"]);
		expect(the(".echo .carets").textContent).toBe("     ^^^^");
		expect(text(".echo .bad")).toBe("dwon");
		expect(style(".echo .bad").color).toBe(tokenColor("down"));
		expect(text('[role="alert"] .sentence')).toBe("link wants up or down here, not dwon.");
		expect(text('[role="alert"] .unchanged')).toBe("Nothing was changed.");
		expect(text(".signature .current")).toBe("<up | down>");
		expect(texts(".group-label")).toEqual(["did you mean"]);
		expect(text('[data-kind="fix"]')).toBe("link down node3 cut the cable to node3 on port 3");
		expect(text(".hint")).toBe("tab → fix it");
		expect(texts(".keys span")).toEqual(["tab take the fix", "↵ take it and run", "esc close"]);
		const alert = the('[role="alert"]').getBoundingClientRect();
		expect(box('[role="listbox"]').top).toBeGreaterThan(alert.top);
	});

	it("takes the fix on Tab, then runs it on Enter and closes", async () => {
		const { runs } = await mountBar();
		await typeLine("link dwon node3");
		await userEvent.keyboard("{Enter}{Tab}");
		expect(input().value).toBe("link down node3");
		expect(runs).toEqual([]);
		await userEvent.keyboard("{Enter}");
		expect(runs).toEqual([{ line: "link down node3", source: "bar" }]);
		await expect.poll(isOpen).toBe(false);
	});

	it("takes the fix and runs on Enter straight from the error", async () => {
		const { runs } = await mountBar();
		await typeLine("link dwon node3");
		await userEvent.keyboard("{Enter}{Enter}");
		expect(runs).toEqual([{ line: "link down node3", source: "bar" }]);
	});
});

describe("<unlab-command-bar> CmdConfirm: rm asks first", () => {
	it("shows the yellow block on the first Enter and runs nothing", async () => {
		const { runs } = await mountBar();
		await typeLine("rm node3");
		await userEvent.keyboard("{Enter}");
		const confirm = the("unlab-confirm .block");
		expect(getComputedStyle(confirm).borderTopColor).toBe(tokenColor("warn"));
		expect(getComputedStyle(confirm).backgroundColor).toBe(tokenColor("base"));
		expect(getComputedStyle(confirm).borderTopLeftRadius).toBe("4px");
		expect(text("unlab-confirm .heading")).toBe("Remove node3?");
		expect(getComputedStyle(the("unlab-confirm .heading .machine")).color).toBe(tokenColor("hue-3"));
		expect(text("unlab-confirm .detail")).toBe(
			"Its console closes and everything on its disk is gone. There is no undo. Port 3 on switch0 frees up. node1 and node2 will stop getting answers from 10.88.0.13.",
		);
		expect(page.getByRole("button", { name: "Remove node3", exact: true }).element()).toBeTruthy();
		expect(texts("unlab-confirm button")).toEqual(["Remove node3↵", "Keep itesc"]);
		expect(page.getByRole("button", { name: "Keep it", exact: true }).element()).toBeTruthy();
		expect(text(".hint")).toBe("↵ again to remove");
		expect(style(".hint").color).toBe(tokenColor("warn"));
		expect(texts(".keys span")).toEqual(["↵ remove", "esc keep it"]);
		expect(runs).toEqual([]);
	});

	it("never takes a held Enter's repeat as the second Enter", async () => {
		const { store } = await mountBar();
		await typeLine("rm node3");
		await userEvent.keyboard("{Enter}");
		input().dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }),
		);
		await new Promise((resolve) => requestAnimationFrame(resolve));
		expect(document.querySelector("unlab-command-bar unlab-confirm")).not.toBeNull();
		expect(store.state.machines.node3?.life.phase).toBe("ready");
	});

	it("cancels on Esc and keeps the bar open on the line", async () => {
		const { store } = await mountBar();
		await typeLine("rm node3");
		await userEvent.keyboard("{Enter}{Escape}");
		expect(document.querySelector("unlab-command-bar unlab-confirm")).toBeNull();
		expect(isOpen()).toBe(true);
		expect(input().value).toBe("rm node3");
		expect(store.state.machines.node3?.life.phase).toBe("ready");
	});

	it("cancels on Keep it and on any edit", async () => {
		await mountBar();
		await typeLine("rm node3");
		await userEvent.keyboard("{Enter}");
		await userEvent.click(page.getByRole("button", { name: "Keep it" }));
		expect(document.querySelector("unlab-command-bar unlab-confirm")).toBeNull();
		expect(document.activeElement).toBe(input());
		await userEvent.keyboard("{Enter}");
		expect(document.querySelector("unlab-command-bar unlab-confirm")).not.toBeNull();
		await userEvent.keyboard("{Backspace}");
		expect(document.querySelector("unlab-command-bar unlab-confirm")).toBeNull();
	});

	it("runs on the second Enter with the approval, and closes once node3 is gone", async () => {
		const { store } = await mountBar();
		await typeLine("rm node3");
		await userEvent.keyboard("{Enter}{Enter}");
		expect(document.querySelector("unlab-command-bar unlab-confirm")).toBeNull();
		expect(texts('[role="status"] .running span')).toEqual(["running", "rm node3"]);
		removedByTheRuntime(store, "node3");
		await expect.poll(isOpen).toBe(false);
		expect(store.state.machines.node3).toBeUndefined();
	});

	it("runs from the Remove button too", async () => {
		const { store } = await mountBar();
		await typeLine("rm node3");
		await userEvent.keyboard("{Enter}");
		await userEvent.click(page.getByRole("button", { name: "Remove node3" }));
		expect(texts('[role="status"] .running span')).toEqual(["running", "rm node3"]);
		removedByTheRuntime(store, "node3");
		await expect.poll(isOpen).toBe(false);
	});

	it("opens already confirming when a button asks the app to confirm in the bar", async () => {
		const { element } = await mount("unlab-app", {
			state: threeReady(),
			prepare: (app, services) => {
				app.services = services;
			},
		});
		const remove = page.getByRole("button", { name: "remove", exact: true }).element();
		remove.focus();
		element.dispatchEvent(new CustomEvent("unlab-open-bar", { detail: "rm node2" }));
		await expect
			.poll(() => document.querySelector("unlab-command-bar unlab-confirm .heading")?.textContent)
			.toBe("Remove node2?");
		expect(input().value).toBe("rm node2");
		expect(document.activeElement).toBe(input());
		await userEvent.keyboard("{Escape}{Escape}");
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(remove);
	});
});

describe("<unlab-command-bar> CmdFanout: exec results", () => {
	it("shows one block per machine with its exit, last line and a console link, then the footnote", async () => {
		await mountBar(threeReady(), { recorded: true });
		await typeLine(`exec all -- ${PING}`);
		await userEvent.keyboard("{Enter}");
		await expect.poll(() => document.querySelector("unlab-command-bar .result")).not.toBeNull();
		expect(isOpen()).toBe(true);
		expect(input().value).toBe(`exec all -- ${PING}`);
		expect(text(".hint")).toBe("↵ run again");
		expect(text(".summary .expansion")).toBe("all = node1 node2 node3");
		expect(text(".summary .header")).toBe("ran in 3 consoles in 1.0 s · 2 failed");
		expect(style(".summary .failed").color).toBe(tokenColor("down"));
		expect(texts(".machine-result .name")).toEqual(["node1", "node2", "node3"]);
		expect(texts(".machine-result .status")).toEqual(["exit 1", "exit 1", "exit 0"]);
		const statuses = [...document.querySelectorAll("unlab-command-bar .machine-result .status")];
		expect(statuses.map((s) => getComputedStyle(s).color)).toEqual([
			tokenColor("down"),
			tokenColor("down"),
			tokenColor("ok"),
		]);
		expect(texts(".machine-result .last")).toEqual([LOSS, LOSS, OK]);
		const bars = [...document.querySelectorAll("unlab-command-bar .machine-result")].map(
			(b) => getComputedStyle(b).borderLeftColor,
		);
		expect(bars).toEqual([tokenColor("hue-1"), tokenColor("hue-2"), tokenColor("hue-3")]);
		expect(texts(".machine-result .open-console")).toEqual(["open console", "open console", "open console"]);
		expect(text(".footnote")).toBe(
			"Showing the last line from each. The full output is in each console, marked as sent from here.",
		);
		expect(texts(".keys span")).toEqual(["↵ run again", "↑ edit the line", "esc close"]);
	});

	it("lists skipped machines after the results with the reason", async () => {
		await mountBar(lab(spawn(3), ready("node1", "node2", "node3"), spawn(1), focus("node1")), { recorded: true });
		await typeLine(`exec all -- ${PING}`);
		await userEvent.keyboard("{Enter}");
		await expect.poll(() => document.querySelector("unlab-command-bar .skipped")).not.toBeNull();
		expect(text(".skipped")).toBe("skipped node4 still booting");
	});

	it("focuses a console from its link and closes", async () => {
		const { runs } = await mountBar(threeReady(), { recorded: true });
		await typeLine(`exec all -- ${PING}`);
		await userEvent.keyboard("{Enter}");
		await expect.poll(() => document.querySelector("unlab-command-bar .result")).not.toBeNull();
		await userEvent.click(page.getByRole("link", { name: "open console, node2" }));
		await expect.poll(() => runs.at(-1)).toEqual({ line: "focus node2:console", source: "button" });
		await expect.poll(isOpen).toBe(false);
	});

	it("shows ls as a block per machine with its state", async () => {
		await mountBar(threeReady(), { recorded: true });
		await typeLine("ls");
		await userEvent.keyboard("{Enter}");
		await expect.poll(() => document.querySelector("unlab-command-bar .result")).not.toBeNull();
		expect(text(".summary")).toBe("3 machines · 3 ready");
		expect(texts(".machine-result .status")).toEqual(["ready", "ready", "ready"]);
		expect(text(".machine-result .last")).toBe("10.88.0.11/24 · 52:54:00:88:00:0b · up on port 1 · console");
		expect(document.querySelector("unlab-command-bar .footnote")).toBeNull();
	});
});

describe("<unlab-command-bar> keys", () => {
	it("opens on the shortcut from inside a focused textarea, which gets no key, and Esc gives focus back", async () => {
		const { store } = await mountBar();
		const textarea = document.createElement("textarea");
		textarea.className = "outside";
		textarea.setAttribute("aria-label", "terminal stand-in");
		document.body.append(textarea);
		textarea.focus();
		await userEvent.keyboard("{Control>}/{/Control}");
		expect(isOpen()).toBe(true);
		expect(document.activeElement).toBe(input());
		expect(textarea.value).toBe("");
		expect(store.state.keyboard.kind).toBe("bar");
		await userEvent.keyboard("{Escape}");
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(textarea);
		expect(store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	it("focuses a machine by rail order on a digit, and closes", async () => {
		const { runs } = await mountBar();
		await openByClick();
		await userEvent.keyboard("2");
		expect(runs).toEqual([{ line: "focus node2", source: "button" }]);
		await expect.poll(isOpen).toBe(false);
	});

	it("walks back through lines typed in the bar with the up arrow", async () => {
		await mountBar(withHistory());
		await openByClick();
		await userEvent.keyboard("{ArrowUp}");
		expect(input().value).toBe("link down node3");
		await userEvent.keyboard("{ArrowUp}");
		expect(input().value).toBe("spawn 3 alpine --net switch0");
		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		expect(input().value).toBe("");
	});

	it("runs and stays open with an empty input on Ctrl+Enter", async () => {
		const { runs } = await mountBar();
		await typeLine("link down node3");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		expect(runs).toEqual([{ line: "link down node3", source: "bar" }]);
		await expect.poll(() => input().value).toBe("");
		expect(isOpen()).toBe(true);
	});

	it("closes on a click outside, leaving focus where the click put it", async () => {
		const { store } = await mountBar();
		const textarea = document.createElement("textarea");
		textarea.className = "outside";
		textarea.setAttribute("aria-label", "elsewhere");
		textarea.style.cssText = "position: fixed; right: 0; bottom: 0";
		document.body.append(textarea);
		await openByClick();
		await userEvent.click(textarea);
		expect(isOpen()).toBe(false);
		expect(document.activeElement).toBe(textarea);
		expect(store.state.keyboard.kind).not.toBe("bar");
	});

	it("passes Tab on when there is nothing to take, and closes behind it", async () => {
		await mountBar();
		const next = document.createElement("textarea");
		next.className = "outside";
		next.setAttribute("aria-label", "next");
		document.body.append(next);
		await typeLine("ls ");
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(next);
		expect(isOpen()).toBe(false);
	});
});

describe("<unlab-command-bar> accessibility", () => {
	it("is a combobox over a listbox of options, with the preview polite and the error an alert", async () => {
		await mountBar();
		await typeLine("link down no");
		const combobox = page.getByRole("combobox", { name: "Command" }).element();
		expect(combobox.getAttribute("aria-expanded")).toBe("true");
		const listbox = document.getElementById(combobox.getAttribute("aria-controls") ?? "");
		expect(listbox?.getAttribute("role")).toBe("listbox");
		expect(listbox?.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
		expect(document.getElementById(combobox.getAttribute("aria-activedescendant") ?? "")?.textContent).toContain(
			"node1",
		);
		expect(the('[role="status"]').textContent).toContain("will");
	});

	it("passes axe while open, in each block", async () => {
		await mountBar(withHistory(), { recorded: true });
		await openByClick();
		expect(await axeViolations()).toEqual([]);
		await userEvent.keyboard("link dwon node3{Enter}");
		expect(await axeViolations()).toEqual([]);
		await userEvent.keyboard("{Escape}");
		await typeLine("rm node3{Enter}");
		expect(await axeViolations()).toEqual([]);
		await userEvent.keyboard("{Escape}{Control>}a{/Control}{Backspace}");
		await userEvent.keyboard(`exec all -- ${PING}{Enter}`);
		await expect.poll(() => document.querySelector("unlab-command-bar .result")).not.toBeNull();
		expect(await axeViolations()).toEqual([]);
	});
});
