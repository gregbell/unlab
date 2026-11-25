import { expect, test } from "vitest";
import type { RemoteBlock, RemoteResult } from "../../src/streams/index.ts";
import { exitCode, machinesLine, resultText } from "./print.ts";
import { complete } from "./prompt.ts";
import type { Completion } from "./server.ts";

const lab = (completion: Partial<Completion>) => async (): Promise<Completion> => ({
	start: 0,
	end: 0,
	suggestions: [],
	...completion,
});
const machines = async () => ["node1", "node2", "web"];

test("the lab's own completer completes a line, and replaces the word under the caret", async () => {
	const labs = lab({ start: 8, end: 10, suggestions: [{ insert: "alpine", detail: null }] });
	expect(await complete("spawn 1 al", labs, machines)).toEqual([["alpine "], "al"]);
});

test("the first word is a verb of the lab's or one of the CLI's", async () => {
	const labs = lab({
		suggestions: [
			{ insert: "sh", detail: null },
			{ insert: "spawn", detail: null },
		],
	});
	expect(await complete("s", labs, machines)).toEqual([["sh ", "spawn ", "ssh ", "status "], "s"]);
});

test("ssh and forward complete machines, after a user too", async () => {
	expect(await complete("ssh no", lab({}), machines)).toEqual([["node1 ", "node2 "], "no"]);
	expect(await complete("ssh root@w", lab({}), machines)).toEqual([["root@web "], "root@w"]);
	expect(await complete("forward w", lab({}), machines)).toEqual([["web "], "w"]);
});

const block = (over: Partial<RemoteBlock>): RemoteBlock => ({
	machine: "node1",
	status: "exit 0",
	exitCode: 0,
	lastLine: "",
	output: null,
	...over,
});
const report = (...blocks: RemoteBlock[]): RemoteResult => ({
	ok: true,
	text: "ran in 1 console in 0.1 s",
	blocks,
	rows: [],
	reply: null,
});

test("one machine's output is all there is when it ends well, and its status is said when it does not", () => {
	const ran = report(block({ output: "hello\n" }));
	expect(resultText(ran)).toBe("hello");
	expect(exitCode(ran)).toBe(0);
	const failed = report(block({ output: "oh\n", status: "exit 3", exitCode: 3 }));
	expect(resultText(failed)).toBe("oh\nnode1  exit 3");
	expect(exitCode(failed)).toBe(3);
});

test("several machines' outputs are told apart, and one that failed or was skipped is the status", () => {
	const ran = report(
		block({ output: "a\n" }),
		block({ machine: "node2", output: "b\n", status: "exit 2", exitCode: 2 }),
	);
	expect(resultText(ran)).toBe(
		"== node1 ==\na\n== node2 ==\nb\nran in 1 console in 0.1 s\nnode1  exit 0\nnode2  exit 2",
	);
	expect(exitCode(ran)).toBe(2);
	const skipped = report(
		block({ output: "a\n" }),
		block({ machine: "node2", status: "skipped: still booting", exitCode: null }),
	);
	expect(exitCode(skipped)).toBe(1);
});

test("a command that runs in no machine has no status to fail with", () => {
	expect(exitCode(report(block({ status: "ready", exitCode: null, lastLine: "10.88.0.11" })))).toBe(0);
	expect(exitCode({ ok: false, message: "No.", fix: null })).toBe(1);
});

test("a refusal says what would work", () => {
	expect(resultText({ ok: false, message: "No verb spwn.", fix: "spawn 1" })).toBe(
		"No verb spwn.\nDid you mean: spawn 1",
	);
});

test("the machines are one line with their states", () => {
	expect(machinesLine([])).toContain("no machines yet");
	const machine = { n: 1, name: "web", image: "lab", state: "ready" };
	expect(machinesLine([machine, { ...machine, name: "db", state: "off" }])).toBe(
		"Linked to the lab: web (lab), db (lab, off)",
	);
});
