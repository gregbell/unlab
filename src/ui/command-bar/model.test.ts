import { describe, expect, it } from "vitest";
import { grantApproval } from "../../commands/approval.ts";
import {
	type CommandDeps,
	createRegistry,
	type ExecOutcome,
	isLineError,
	type ParsedLine,
	parseLine,
	VERBS,
} from "../../commands/index.ts";
import { createStore, initialState, type SessionId, type Source } from "../../model/index.ts";
import { type BarEffect, type BarInput, type BarState, barStep, barView, type OpenBar, RESTING } from "./model.ts";

const PING = "ping -c 1 -W 1 10.88.0.13";
const LOSS = "1 packets transmitted, 0 packets received, 100% packet loss";
const OK = "1 packets transmitted, 1 packets received, 0% packet loss";
const TYPING_FOOTER = ["tab complete", "↑↓ choose", "↵ run", "esc close"];

interface Inject {
	readonly session: SessionId;
	readonly resolve: (outcome: ExecOutcome) => void;
}

/** The real store and verbs, with a runtime that finishes removals and an exec port the test settles by hand. */
function labOf() {
	const calls: Inject[] = [];
	let clock = 0;
	const images = [{ name: "alpine", label: "alpine 3.24" }];
	const store = createStore(initialState(images, { width: 1300, height: 500 }), (effect) => {
		if (effect.type === "vm/stop") {
			store.dispatchRuntime({ type: "vm/stopped", machine: effect.machine, attempt: effect.attempt });
		}
	});
	const deps: CommandDeps = {
		state: () => store.state,
		dispatch: store.dispatchCommand,
		until: store.until,
		now: () => clock,
		exec: {
			inject: (session, _line, _source, signal) =>
				new Promise((resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
					calls.push({ session, resolve });
				}),
		},
	};
	const registry = createRegistry(deps, VERBS);
	const signal = new AbortController().signal;
	const parsed = (line: string): ParsedLine => {
		const result = parseLine(registry, line, store.state);
		if (isLineError(result)) throw new Error(`expected ${line} to parse: ${result.message}`);
		return result;
	};
	return {
		store,
		registry,
		signal,
		calls,
		parsed,
		advance(ms: number) {
			clock += ms;
		},
		run(line: string, source: Source = "bar") {
			const p = parsed(line);
			if (p.danger) throw new Error(`${line} needs an approval`);
			return p.run({ source, signal });
		},
	};
}

/**
 * The bar over the real store and verbs, with node1 to node<machines> ready.
 * `settle` does what the element does with run effects: runs the line as its
 * source, with the approval, and reports back.
 */
async function harness(machines = 3) {
	const lab = labOf();
	if (machines > 0) {
		await lab.run(`spawn ${machines} alpine`);
		for (const machine of lab.store.state.rail) {
			lab.store.dispatchRuntime({ type: "vm/ready", machine, attempt: 1, bootMs: 3582 });
		}
	}
	let bar: BarState = RESTING;
	let effects: BarEffect[] = [];
	const runs: Extract<BarEffect, { type: "run" }>[] = [];

	const press = (...inputs: BarInput[]) => {
		for (const input of inputs) {
			const step = barStep(bar, input, lab.store.state, lab.registry);
			bar = step.bar;
			effects.push(...step.effects);
			for (const effect of step.effects) if (effect.type === "run") runs.push(effect);
		}
	};
	const open = (): OpenBar => {
		if (!bar.open) throw new Error("the bar is closed");
		return bar;
	};
	return {
		lab,
		calls: lab.calls,
		press,
		/** One edit per character, as an input element reports typing. */
		type(text: string) {
			const start = open().text;
			for (let i = 1; i <= text.length; i++) {
				const next = start + text.slice(0, i);
				press({ kind: "edit", text: next, caret: next.length });
			}
		},
		view: () => barView(open(), lab.store.state, lab.registry),
		get bar() {
			return bar;
		},
		/** The effects since the last call. */
		take() {
			const out = effects;
			effects = [];
			return out;
		},
		async settle() {
			for (let effect = runs.shift(); effect !== undefined; effect = runs.shift()) {
				const parsed = parseLine(lab.registry, effect.line, lab.store.state);
				const ctx = { source: effect.source, signal: lab.signal };
				let result: Awaited<ReturnType<ParsedLine["run"]>> | typeof parsed;
				if (isLineError(parsed)) result = parsed;
				else if (!parsed.danger) result = await parsed.run(ctx);
				else if (effect.approval) result = await parsed.run({ ...ctx, approval: effect.approval });
				else throw new Error(`the bar ran ${effect.line} without an approval`);
				press({ kind: "ran", run: effect.run, result });
			}
		},
	};
}

/** The CmdOpen lab: three machines, and the agent among those who ran lines. */
async function withHistory() {
	const h = await harness();
	const agentExec = h.lab.parsed("exec node1 -- ping -c 2 -W 1 10.88.0.13");
	if (agentExec.danger) throw new Error("exec is safe");
	const pending = agentExec.run({ source: "agent", signal: h.lab.signal });
	h.calls[0].resolve({ exitCode: 0, output: "", lastLine: "", ms: 10 });
	await pending;
	await h.lab.run("link down node3");
	return h;
}

describe("the artboards, replayed", () => {
	it("CmdOpen: recent lines with who ran them, then the verbs, with spawn chosen", async () => {
		const h = await withHistory();
		h.press({ kind: "open" });
		const view = h.view();
		expect(view.rows.slice(0, 3)).toEqual([
			{ kind: "recent", line: "link down node3", source: "bar", at: 0 },
			{ kind: "recent", line: "exec node1 -- ping -c 2 -W 1 10.88.0.13", source: "agent", at: 0 },
			{ kind: "recent", line: "spawn 3 alpine", source: "bar", at: 0 },
		]);
		expect(view.rows.slice(3, 6)).toEqual([
			{ kind: "verb", name: "spawn", signature: "<count> <image>", about: "boot machines" },
			{ kind: "verb", name: "rm", signature: "<machines>", about: "remove machines and their disks" },
			{ kind: "verb", name: "ls", signature: "", about: "list machines, addresses and links" },
		]);
		expect(view.rows.filter((r) => r.kind === "verb").map((r) => r.kind === "verb" && r.name)).toEqual([
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
		expect(view.chosen).toBe(3);
		expect(view.hint).toBe("tab → spawn");
		expect(view.block).toEqual({ kind: "none" });
		expect(view.signature).toBeNull();
		expect(view.footer).toEqual(TYPING_FOOTER);
	});

	it("CmdComplete: the argument under the cursor, its suggestion chosen, and the line previewed as it would become", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("spawn 2 alp");
		const view = h.view();
		expect(view.hint).toBe("tab → alpine");
		expect(view.signature).toEqual({
			verb: "spawn",
			parts: ["<count>", "<image>", "[--mem MiB]", "[--net switch0 | --no-net]"],
			current: 1,
		});
		expect(view.rows).toEqual([
			{ kind: "value", suggestion: { insert: "alpine", label: "alpine", detail: "alpine 3.24" } },
		]);
		expect(view.chosen).toBe(0);
		expect(view.block).toEqual({
			kind: "preview",
			preview: {
				will: "boot node4 and node5 · alpine 3.24 · 256 MiB each · plugged into switch0 on ports 4 and 5",
				assumed: "Left out, so assumed: --mem 256 --net switch0",
				tone: "plain",
			},
		});

		h.press({ kind: "tab" });
		expect(h.bar).toMatchObject({ text: "spawn 2 alpine ", caret: 15 });
		expect(h.view().hint).toBe("↵ run");
		h.take();
		h.press({ kind: "enter", keepOpen: false });
		expect(h.take()).toEqual([{ type: "run", run: 1, line: "spawn 2 alpine ", source: "bar", approval: null }]);
		expect(h.view().block).toEqual({ kind: "running", line: "spawn 2 alpine " });
	});

	it("…and closes once the machines show, giving the keyboard back", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("spawn 2 alpine");
		h.press({ kind: "enter", keepOpen: false });
		await h.settle();
		expect(h.take()).toEqual([
			{ type: "run", run: 1, line: "spawn 2 alpine", source: "bar", approval: null },
			{ type: "close" },
			{ type: "focus-return" },
		]);
		expect(h.bar).toEqual({ open: false, runs: 1 });
		expect(h.lab.store.state.rail).toEqual(["node1", "node2", "node3", "node4", "node5"]);
	});

	it("CmdFanout: one block per console, the summary, and Enter runs it again", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type(`exec all -- ${PING}`);
		expect(h.view().hint).toBe("↵ run");
		h.press({ kind: "enter", keepOpen: false });
		const settled = h.settle();
		h.lab.advance(1000);
		h.calls[0].resolve({ exitCode: 1, output: LOSS, lastLine: LOSS, ms: 1000 });
		h.calls[1].resolve({ exitCode: 1, output: LOSS, lastLine: LOSS, ms: 1000 });
		h.calls[2].resolve({ exitCode: 0, output: OK, lastLine: OK, ms: 30 });
		await settled;

		const view = h.view();
		expect(h.bar).toMatchObject({ text: `exec all -- ${PING}` });
		expect(view.hint).toBe("↵ run again");
		expect(view.footer).toEqual(["↵ run again", "↑ edit the line", "esc close"]);
		expect(view.signature).toBeNull();
		expect(view.block).toEqual({
			kind: "result",
			line: `exec all -- ${PING}`,
			header: "ran in 3 consoles in 1.0 s · 2 failed",
			blocks: [
				{ machine: "node1", hue: 1, status: { kind: "exit", code: 1 }, lastLine: LOSS, focus: "node1:console" },
				{ machine: "node2", hue: 2, status: { kind: "exit", code: 1 }, lastLine: LOSS, focus: "node2:console" },
				{ machine: "node3", hue: 3, status: { kind: "exit", code: 0 }, lastLine: OK, focus: "node3:console" },
			],
		});

		h.take();
		h.press({ kind: "enter", keepOpen: false });
		expect(h.take()).toEqual([{ type: "run", run: 2, line: `exec all -- ${PING}`, source: "bar", approval: null }]);
	});

	it("…↑ edits the line, and the console link focuses that console and closes", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("exec node1 -- true");
		h.press({ kind: "enter", keepOpen: false });
		const settled = h.settle();
		h.calls[0].resolve({ exitCode: 0, output: "", lastLine: "", ms: 1 });
		await settled;
		h.press({ kind: "up" });
		expect(h.bar).toMatchObject({ text: "exec node1 -- true", mode: { kind: "typing" } });
		expect(h.view().block).toMatchObject({ kind: "preview" });

		h.press({ kind: "enter", keepOpen: false });
		const again = h.settle();
		h.calls[1].resolve({ exitCode: 0, output: "", lastLine: "", ms: 1 });
		await again;
		h.take();
		h.press({ kind: "open-console", session: "node1:console" });
		await h.settle();
		expect(h.take()).toEqual([
			{ type: "run", run: 3, line: "focus node1:console", source: "button", approval: null },
			{ type: "close" },
			{ type: "focus-return" },
		]);
	});

	it("CmdError: errors wait for Enter, then echo the line with carets and offer the fix", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("link dwon node3");
		expect(h.view().block).toEqual({ kind: "none" });
		expect(h.view().hint).toBe("↵ check the line");

		h.press({ kind: "enter", keepOpen: false });
		const view = h.view();
		expect(view.block).toEqual({
			kind: "error",
			line: "link dwon node3",
			mark: { start: 5, end: 9 },
			sentence: "link wants up or down here, not dwon.",
			nothingChanged: true,
		});
		expect(view.rows).toEqual([{ kind: "fix", line: "link down node3", will: "cut the cable to node3 on port 3" }]);
		expect(view.chosen).toBe(0);
		expect(view.hint).toBe("tab → fix it");
		expect(view.footer).toEqual(["tab take the fix", "↵ take it and run", "esc close"]);
		expect(view.signature).toEqual({ verb: "link", parts: ["<up | down>", "<machines>"], current: 0 });
		expect(h.take().filter((e) => e.type === "run")).toEqual([]);
	});

	it("…Tab takes the fix", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("link dwon node3");
		h.press({ kind: "enter", keepOpen: false }, { kind: "tab" });
		expect(h.bar).toMatchObject({ text: "link down node3", mode: { kind: "typing" } });
		expect(h.view().block).toMatchObject({ kind: "preview", preview: { will: "cut the cable to node3 on port 3" } });
	});

	it("…Enter takes the fix and runs it", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("link dwon node3");
		h.press({ kind: "enter", keepOpen: false });
		h.take();
		h.press({ kind: "enter", keepOpen: false });
		expect(h.take()).toEqual([{ type: "run", run: 1, line: "link down node3", source: "bar", approval: null }]);
		await h.settle();
		expect(h.lab.store.state.machines.node3?.life).toMatchObject({ plug: { link: "cut" } });
		expect(h.bar.open).toBe(false);
	});

	it("CmdConfirm: the first Enter asks, naming what is lost and who else is affected", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("rm node3");
		expect(h.view().hint).toBe("↵ remove");
		expect(h.view().block).toMatchObject({ kind: "preview", preview: { tone: "warn" } });

		h.press({ kind: "enter", keepOpen: false });
		const view = h.view();
		expect(view.block).toEqual({
			kind: "confirm",
			confirm: {
				question: "Remove node3?",
				detail:
					"Its console closes and everything on its disk is gone. There is no undo. " +
					"Port 3 on switch0 frees up. node1 and node2 will stop getting answers from 10.88.0.13.",
				actionLabel: "Remove node3",
			},
		});
		expect(view.hint).toBe("↵ again to remove");
		expect(view.footer).toEqual(["↵ remove", "esc keep it"]);
		expect(view.signature).toEqual({ verb: "rm", parts: ["<machines>"], current: 0 });
		expect(h.take()).toEqual([]);
	});

	it("…the second Enter removes it with an approval for that line, and closes when it is gone", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("rm node3");
		h.press({ kind: "enter", keepOpen: false }, { kind: "enter", keepOpen: false });
		const [run] = h.take();
		expect(run).toMatchObject({ type: "run", line: "rm node3", source: "bar", approval: { line: "rm node3" } });
		h.press({ kind: "ran", run: 1, result: { kind: "visible", text: "", data: null } });
		expect(h.take()).toEqual([{ type: "close" }, { type: "focus-return" }]);
	});

	it("…the Remove button runs it too", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("rm node3");
		h.press({ kind: "enter", keepOpen: false }, { kind: "approve" });
		await h.settle();
		expect(h.lab.store.state.rail).toEqual(["node1", "node2"]);
		expect(h.bar.open).toBe(false);
	});

	it.each<[string, readonly BarInput[]]>([
		["Esc", [{ kind: "escape" }]],
		["Keep it", [{ kind: "keep" }]],
		["an edit to the line", [{ kind: "edit", text: "rm node3,", caret: 9 }]],
	])("…%s cancels and nothing runs", async (_name, inputs) => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("rm node3");
		h.press({ kind: "enter", keepOpen: false }, ...inputs);
		expect(h.bar).toMatchObject({ open: true, mode: { kind: "typing" } });
		expect(h.view().block.kind).not.toBe("confirm");
		expect(h.take()).toEqual([]);
		expect(h.lab.store.state.rail).toHaveLength(3);
	});

	it("…a button for rm opens the bar already confirming, and never runs on its own", async () => {
		const h = await harness();
		h.press({ kind: "open-confirming", line: "rm node2" });
		expect(h.bar).toMatchObject({ open: true, text: "rm node2", mode: { kind: "confirm", line: "rm node2" } });
		expect(h.view().block).toMatchObject({ kind: "confirm", confirm: { actionLabel: "Remove node2" } });
		expect(h.take()).toEqual([]);
	});

	it("…turns into the error if the machine goes while it waits", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("rm node3");
		h.press({ kind: "enter", keepOpen: false });
		const line = h.lab.parsed("rm node3");
		if (!line.danger) throw new Error("rm is dangerous");
		await line.run({ source: "agent", signal: h.lab.signal, approval: grantApproval("rm node3") });
		expect(h.view().block).toMatchObject({
			kind: "error",
			sentence: "No machine called node3. You have node1, node2.",
		});
		h.press({ kind: "enter", keepOpen: false });
		expect(h.take().filter((e) => e.type === "run")).toEqual([]);
	});
});

describe("the keyboard map, bar rows", () => {
	it("1 to 8 on an empty input focuses that machine by rail order and closes", async () => {
		const h = await harness();
		h.press({ kind: "open" }, { kind: "digit", digit: 2 });
		await h.settle();
		expect(h.take()).toEqual([
			{ type: "run", run: 1, line: "focus node2", source: "button", approval: null },
			{ type: "close" },
			{ type: "focus-return" },
		]);
		expect(h.lab.store.state.keyboard).toEqual({ kind: "pane", machine: "node2" });
	});

	it("a digit with text in the input is just typed, and one past the rail does nothing", async () => {
		const h = await harness();
		h.press({ kind: "open" }, { kind: "digit", digit: 7 });
		expect(h.take()).toEqual([]);
		h.type("spawn ");
		h.press({ kind: "digit", digit: 2 });
		expect(h.take()).toEqual([{ type: "pass" }]);
	});

	it("Up on an empty input walks back through lines typed in the bar, and Down walks forward", async () => {
		const h = await harness();
		await h.lab.run("link down node3");
		await h.lab.run("ls", "agent");
		await h.lab.run("link up node3");
		h.press({ kind: "open" }, { kind: "up" });
		expect(h.bar).toMatchObject({ text: "link up node3" });
		h.press({ kind: "up" });
		expect(h.bar).toMatchObject({ text: "link down node3" });
		h.press({ kind: "up" });
		expect(h.bar).toMatchObject({ text: "spawn 3 alpine" });
		h.press({ kind: "up" });
		expect(h.bar).toMatchObject({ text: "spawn 3 alpine" });
		h.press({ kind: "down" }, { kind: "down" });
		expect(h.bar).toMatchObject({ text: "link up node3" });
		h.press({ kind: "down" });
		expect(h.bar).toMatchObject({ text: "", history: null });
	});

	it("Tab accepts the chosen suggestion and adds a space; with none it lets focus move on", async () => {
		const h = await harness();
		h.press({ kind: "open" }, { kind: "tab" });
		expect(h.bar).toMatchObject({ text: "spawn ", caret: 6 });
		h.type("2 alpine --no-net -- ");
		h.take();
		h.press({ kind: "tab" }, { kind: "shift-tab" });
		expect(h.take()).toEqual([{ type: "pass" }, { type: "pass" }]);
	});

	it("Up and Down move the choice, wrapping", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("link up ");
		expect(h.view().rows.map((r) => r.kind === "value" && r.suggestion.insert)).toEqual([
			"node1",
			"node2",
			"node3",
			"all",
		]);
		h.press({ kind: "down" });
		expect(h.view()).toMatchObject({ chosen: 1, hint: "tab → node2" });
		h.press({ kind: "up" }, { kind: "up" });
		expect(h.view()).toMatchObject({ chosen: 3, hint: "tab → all" });
	});

	it("Enter runs a complete line; otherwise accepts the suggestion; otherwise shows the error", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("link up no");
		h.press({ kind: "enter", keepOpen: false });
		expect(h.bar).toMatchObject({ text: "link up node1 ", mode: { kind: "typing" } });
		expect(h.take()).toEqual([]);

		h.press({ kind: "escape" }, { kind: "open" });
		h.type("link sideways node1");
		h.press({ kind: "enter", keepOpen: false });
		expect(h.view().block).toMatchObject({ kind: "error", sentence: "link wants up or down here, not sideways." });
		expect(h.view().hint).toBe("esc close");
	});

	it("⌘Enter runs and keeps the bar open with an empty input", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("link down node1");
		h.press({ kind: "enter", keepOpen: true });
		expect(h.bar).toMatchObject({ open: true, text: "" });
		await h.settle();
		expect(h.take()).toEqual([{ type: "run", run: 1, line: "link down node1", source: "bar", approval: null }]);
		expect(h.bar).toMatchObject({ open: true, text: "", mode: { kind: "typing" } });
		expect(h.view().rows[0]).toEqual({ kind: "recent", line: "link down node1", source: "bar", at: 0 });
	});

	it("Esc cancels a confirmation if one is showing, otherwise closes and gives the keyboard back", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("rm node1");
		h.press({ kind: "enter", keepOpen: false }, { kind: "escape" });
		expect(h.bar).toMatchObject({ open: true, mode: { kind: "typing" } });
		h.press({ kind: "escape" });
		expect(h.bar).toEqual({ open: false, runs: 0 });
		expect(h.take()).toEqual([{ type: "close" }, { type: "focus-return" }]);
	});

	it("a click outside closes without taking the keyboard anywhere", async () => {
		const h = await harness();
		h.press({ kind: "open" }, { kind: "dismiss" });
		expect(h.take()).toEqual([{ type: "close" }]);
	});

	it("closing while a line runs stops waiting for it, and its late result changes nothing", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("exec node1 -- sleep 5");
		h.press({ kind: "enter", keepOpen: false }, { kind: "escape" });
		expect(h.take()).toEqual([
			{ type: "run", run: 1, line: "exec node1 -- sleep 5", source: "bar", approval: null },
			{ type: "abort", run: 1 },
			{ type: "close" },
			{ type: "focus-return" },
		]);
		h.press({ kind: "open" }, { kind: "ran", run: 1, result: { kind: "visible", text: "", data: null } });
		expect(h.bar).toMatchObject({ open: true, mode: { kind: "typing" }, runs: 1 });
		expect(h.take()).toEqual([]);
	});

	it("a result for an earlier run does not land on the one now running", async () => {
		const h = await harness();
		h.press({ kind: "open" });
		h.type("exec node1 -- sleep 5");
		h.press({ kind: "enter", keepOpen: true });
		h.type("ls");
		h.press({ kind: "enter", keepOpen: false });
		h.take();
		h.press({ kind: "ran", run: 1, result: { kind: "visible", text: "", data: null } });
		expect(h.take()).toEqual([]);
		expect(h.view().block).toEqual({ kind: "running", line: "ls" });
	});

	it("keys reach the bar only while it is open", async () => {
		const h = await harness();
		h.press({ kind: "enter", keepOpen: false });
		expect(h.take()).toEqual([{ type: "pass" }]);
		expect(h.bar).toEqual(RESTING);
	});
});
