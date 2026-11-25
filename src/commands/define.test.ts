import { describe, expect, it } from "vitest";
import type { LabState } from "../model/index.ts";
import { createRegistry, defineVerb, type Grammar, type ParsedLine, parseLine, slots } from "./index.ts";
import { fakeDeps, labWith } from "./testing/lab.ts";
import { link, parsedOk, rm, spawn, TOY_VERBS, toyRegistry, yesTo } from "./testing/verbs.ts";

const lab = labWith([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4, phase: "booting" }, { n: 5, phase: "failed" }]);
const signal = new AbortController().signal;

describe("preview", () => {
	it("states the effect and what was assumed", () => {
		const { registry } = toyRegistry(lab);
		expect(parsedOk(parseLine(registry, "spawn 2 alpine", lab)).preview(lab)).toEqual({
			will: "boot node6 and node7 · alpine · 256 MiB",
			assumed: "Left out, so assumed: --mem 256 --net switch0",
			tone: "plain",
		});
		expect(parsedOk(parseLine(registry, "spawn 2 alpine --mem 512 --no-net", lab)).preview(lab)).toMatchObject({
			assumed: null,
		});
	});

	it("is in the warn tone for a dangerous verb", () => {
		const { registry } = toyRegistry(lab);
		expect(parsedOk(parseLine(registry, "rm node3", lab)).preview(lab)).toEqual({
			will: "remove node3 and its disk",
			assumed: null,
			tone: "warn",
		});
	});
});

describe("validate", () => {
	const crowded = labWith([1, 2, 3, 4, 5, 6].map((n) => ({ n })));

	it("is the plan's refusal, with carets under the argument the plan names", () => {
		const { registry } = toyRegistry(crowded);
		const line = parsedOk(parseLine(registry, "spawn 3 alpine", crowded));
		const refusal = {
			message: "switch0 has 2 free ports. Add --no-net to boot them unplugged. Nothing was changed.",
			token: 1,
		};
		expect(line.validate(crowded)).toEqual(refusal);
		expect(line.preview(crowded)).toEqual(refusal);
		expect(parsedOk(parseLine(registry, "spawn 3 alpine --no-net", crowded)).validate(crowded)).toBeNull();
	});

	it("checks the lab it is given, not the one the line was parsed against", () => {
		const { registry } = toyRegistry(lab);
		const line = parsedOk(parseLine(registry, "spawn 3 alpine", lab));
		expect(line.validate(lab)).toBeNull();
		expect(line.validate(crowded)).toMatchObject({ message: expect.stringContaining("switch0 has 2 free ports") });
	});
});

describe("confirm", () => {
	it("is the dangerous verb's question, named for the action", () => {
		const { registry } = toyRegistry(lab);
		const line = parsedOk(parseLine(registry, "rm node3", lab));
		if (!line.danger) throw new Error("rm is dangerous");
		expect(line.confirm(lab)).toEqual({
			question: "Remove node3?",
			detail: "Closes node3:console.",
			actionLabel: "Remove node3",
			machines: [{ n: 3, name: "node3" }],
		});
	});
});

describe("run", () => {
	it("executes the plan and logs the canonical line with its source", async () => {
		const { registry, events } = toyRegistry(lab);
		const line = parsedOk(parseLine(registry, "link   down node1", lab));
		if (line.danger) throw new Error("link is not dangerous");
		const result = await line.run({ source: "agent", signal });
		expect(result).toMatchObject({ kind: "visible" });
		expect(events).toEqual([
			{ type: "cmd/link", changes: [{ machine: "node1", nic: 0, up: false, port: 1, newPort: false }], cause: "agent" },
			{ type: "cmd/logged", line: "link down node1", source: "agent", at: expect.any(Number), outcome: "ok" },
		]);
	});

	it("re-plans against the state at run time and changes nothing when the plan now refuses", async () => {
		const { registry, events, setState } = toyRegistry(lab);
		const line = parsedOk(parseLine(registry, "link down node1", lab));
		setState(labWith([{ n: 1, phase: "removing" }, { n: 2 }]));
		if (line.danger) throw new Error("link is not dangerous");
		expect(await line.run({ source: "bar", signal })).toEqual({
			kind: "failed",
			error: { message: "node1 is no longer ready. Nothing was changed." },
		});
		expect(events).toEqual([
			{ type: "cmd/logged", line: "link down node1", source: "bar", at: expect.any(Number), outcome: "failed" },
		]);
	});

	it("runs a dangerous line with an approval for that line, and resolves once its effect is visible", async () => {
		const { registry, events, setState } = toyRegistry(lab);
		const line = parsedOk(parseLine(registry, "rm node3", lab));
		const yes = yesTo(line, lab);
		const running = yes.line.run({ source: "bar", signal, approval: yes.approval });
		expect(events).toEqual([{ type: "cmd/remove", machines: ["node3"], cause: "bar" }]);
		setState(labWith([{ n: 1 }, { n: 2 }, { n: 4, phase: "booting" }, { n: 5, phase: "failed" }]));
		expect(await running).toMatchObject({ kind: "visible", data: { removed: ["node3"] } });
		expect(events[1]).toMatchObject({ type: "cmd/logged", line: "rm node3", source: "bar", outcome: "ok" });
	});

	it("refuses an approval that was given for another line", async () => {
		const { registry, events } = toyRegistry(lab);
		const command = registry.command(rm);
		const args = { targets: { machines: ["node3" as const], skipped: [], written: "node3" } };
		const { approval } = yesTo(parsedOk(parseLine(registry, "rm node2", lab)), lab);
		expect(await command.run(args, { source: "agent", signal, approval })).toEqual({
			kind: "failed",
			error: { message: "That approval was for rm node2, not rm node3. Nothing was changed." },
		});
		expect(events).toEqual([expect.objectContaining({ type: "cmd/logged", line: "rm node3", outcome: "failed" })]);
	});

	it.each<[string, LabState]>([
		["another machine has its name", labWith([{ n: 1 }, { n: 2 }, { n: 9, name: "node3" }])],
		["it would ask for more", labWith([{ n: 1 }, { n: 2 }, { n: 3, shells: 1 }])],
	])("refuses an approval once %s", async (_what, later) => {
		const { registry, events, setState } = toyRegistry(lab);
		const yes = yesTo(parsedOk(parseLine(registry, "rm node3", lab)), lab);
		setState(later);
		expect(await yes.line.run({ source: "agent", signal, approval: yes.approval })).toEqual({
			kind: "failed",
			error: { message: "What this does to node3 has changed since it was asked. Nothing was changed." },
		});
		expect(events).toEqual([expect.objectContaining({ type: "cmd/logged", line: "rm node3", outcome: "failed" })]);
	});

	it("logs a failure and rethrows when execution is aborted", async () => {
		const { registry, events } = toyRegistry(lab);
		const line = parsedOk(parseLine(registry, "rm node3", lab));
		const yes = yesTo(line, lab);
		const abort = new AbortController();
		const running = yes.line.run({ source: "agent", signal: abort.signal, approval: yes.approval });
		abort.abort(new Error("agent went away"));
		await expect(running).rejects.toThrow("agent went away");
		expect(events.map((e) => e.type)).toEqual(["cmd/remove", "cmd/logged"]);
		expect(events[1]).toMatchObject({ outcome: "failed" });
	});

	it("cannot run a dangerous verb without an approval", () => {
		const { registry } = toyRegistry(lab);
		const remove = registry.command(rm);
		const add = registry.command(spawn);
		const args = { targets: { machines: ["node3" as const], skipped: [], written: "node3" } };
		const attempts = [
			// @ts-expect-error a dangerous command's run requires an Approval
			() => remove.run(args, { source: "bar", signal }),
			() => add.run({ count: 1, image: "alpine", mem: 256, net: "switch0" }, { source: "bar", signal }),
			(line: ParsedLine) => {
				// @ts-expect-error a line of unknown danger may be dangerous, so it needs an Approval too
				void line.run({ source: "bar", signal });
				if (!line.danger) void line.run({ source: "bar", signal });
			},
		];
		expect(attempts).toHaveLength(3);
	});
});

describe("defineVerb", () => {
	it("refuses a grammar that could never parse", () => {
		const verb = (grammar: Grammar) => () =>
			defineVerb({
				name: "bad",
				about: "",
				danger: false,
				grammar,
				plan: () => ({}),
				describe: () => "",
				execute: async () => ({ kind: "visible", text: "", data: null }),
			});
		expect(verb({ words: slots.text("words"), count: slots.count() })).toThrow(
			"free text must be the last positional argument",
		);
		expect(verb({ a: slots.option("--x", slots.count(), 1), b: slots.option("--x", slots.count(), 2) })).toThrow(
			"each option flag must be unique",
		);
		expect(verb({ words: slots.count(), more: slots.text("more") })).not.toThrow();
	});
});

describe("registry", () => {
	it("hands out the same command a line runs through", () => {
		const { registry } = toyRegistry(lab);
		expect(registry.command(link)).toBe(registry.find("link"));
		expect(registry.commands.map((c) => c.name)).toEqual(TOY_VERBS.map((v) => v.name));
	});

	it("refuses two verbs with one name, and a verb it does not hold", () => {
		const { deps } = fakeDeps(lab);
		expect(() => createRegistry(deps, [link, link])).toThrow("two verbs are called link");
		expect(() => createRegistry(deps, [link]).command(rm)).toThrow("rm is not registered");
	});
});
