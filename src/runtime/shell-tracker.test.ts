import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createShellTracker, type ShellEvent, type ShellTracker } from "./shell-tracker.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const osc = (body: string, end = BEL): string => `${ESC}]${body}${end}`;

/** What the guest prints after a command, as the spike recorded it. */
const promptAfter = (exit: number): string => `${osc(`133;D;${exit}`)}${osc("133;A")}node1:~$ ${osc("133;B")}`;

/** A shell at its first prompt. */
function atPrompt(): ShellTracker {
	const t = createShellTracker();
	t.scan(bytes(promptAfter(0)));
	return t;
}

/** A shell that was sent a line and has echoed its Enter. */
function running(): ShellTracker {
	const t = atPrompt();
	t.submitted();
	t.scan(bytes("ls\r\n"));
	return t;
}

describe("createShellTracker", () => {
	it("is unknown until the shell marks a prompt", () => {
		const t = createShellTracker();
		expect(t.phase).toBe("unknown");
		expect(t.scan(bytes("Welcome to Alpine Linux\r\nnode1 login: "))).toEqual([]);
		expect(t.phase).toBe("unknown");
	});

	it("reports the first prompt once, though D, A and B all arrive, and no command finished", () => {
		const t = createShellTracker();
		expect(t.scan(bytes(promptAfter(0)))).toEqual([{ kind: "phase", phase: "prompt" }]);
		expect(t.phase).toBe("prompt");
	});

	it.each(["A", "B", "D;0"])("takes a bare %s mark as a prompt", (mark) => {
		const t = createShellTracker();
		expect(t.scan(bytes(osc(`133;${mark}`)))).toEqual([{ kind: "phase", phase: "prompt" }]);
	});

	it("runs from a submitted line until the next D, which carries the exit code", () => {
		const t = atPrompt();
		expect(t.submitted()).toEqual([{ kind: "phase", phase: "running" }]);
		expect(t.phase).toBe("running");
		expect(t.scan(bytes("false\r\n"))).toEqual([]);

		expect(t.scan(bytes(promptAfter(1)))).toEqual([
			{ kind: "finished", exitCode: 1, at: osc("133;D;1").length },
			{ kind: "phase", phase: "prompt" },
		]);
		expect(t.phase).toBe("prompt");
	});

	it("ignores a submitted line when the shell is not at a prompt", () => {
		const t = createShellTracker();
		expect(t.submitted()).toEqual([]);
		expect(t.phase).toBe("unknown");

		t.scan(bytes(osc("133;A")));
		t.submitted();
		expect(t.submitted()).toEqual([]);
		expect(t.phase).toBe("running");
	});

	it("a prompt reprinted before the line's Enter is echoed does not finish the line", () => {
		const t = atPrompt();
		t.submitted();
		expect(t.scan(bytes(`\r${promptAfter(0)}`))).toEqual([]);
		expect(t.phase).toBe("running");

		const rest = `sh -c 'exit 7'\r\n${promptAfter(7)}`;
		expect(t.scan(bytes(rest))).toEqual([
			{ kind: "finished", exitCode: 7, at: `sh -c 'exit 7'\r\n${osc("133;D;7")}`.length },
			{ kind: "phase", phase: "prompt" },
		]);
	});

	it("a prompt reprinted while idle is not a command", () => {
		const t = atPrompt();
		expect(t.scan(bytes(`\r${promptAfter(130)}`))).toEqual([]);
		expect(t.phase).toBe("prompt");
	});

	it("accepts the ST terminator as well as BEL", () => {
		const t = running();
		expect(t.scan(bytes(osc("133;D;7", ST)))).toEqual([
			{ kind: "finished", exitCode: 7, at: osc("133;D;7", ST).length },
			{ kind: "phase", phase: "prompt" },
		]);
	});

	it.each([
		["133;D", null],
		["133;D;", null],
		["133;D;x", null],
		["133;D;12;aid=4711", 12],
		["133;A", null],
	])("reads the exit code of %s as %s", (body, exitCode) => {
		expect(running().scan(bytes(osc(body)))[0]).toEqual({ kind: "finished", exitCode, at: osc(body).length });
	});

	it("takes a C mark as a command starting, so the next D is its end", () => {
		const t = atPrompt();
		expect(t.scan(bytes(osc("133;C")))).toEqual([{ kind: "phase", phase: "running" }]);
		expect(t.scan(bytes(osc("133;D;3")))).toEqual([
			{ kind: "finished", exitCode: 3, at: osc("133;D;3").length },
			{ kind: "phase", phase: "prompt" },
		]);
	});

	it("carries a sequence across chunks, split at every byte", () => {
		const stream = `ls\r\nout\r\n${promptAfter(42)}`;
		const whole = [
			{ kind: "finished", exitCode: 42, at: `ls\r\nout\r\n${osc("133;D;42")}`.length },
			{ kind: "phase", phase: "prompt" },
		];
		for (let cut = 1; cut < stream.length; cut++) {
			const t = atPrompt();
			t.submitted();
			const head = t.scan(bytes(stream.slice(0, cut)));
			const tail = t.scan(bytes(stream.slice(cut))).map((e) => (e.kind === "finished" ? { ...e, at: e.at + cut } : e));
			expect([...head, ...tail], `cut at ${cut}`).toEqual(whole);
		}
	});

	it("ignores other OSC sequences, however long", () => {
		const t = createShellTracker();
		const noise = `${osc("0;node1: ~")}${osc(`7;file://node1/${"x".repeat(5000)}`)}${osc("1337;D;0")}${osc("133")}`;
		expect(t.scan(bytes(noise))).toEqual([]);
		expect(t.scan(bytes(osc("133;A")))).toEqual([{ kind: "phase", phase: "prompt" }]);
	});

	it("drops an OSC that is cancelled or interrupted by another escape", () => {
		const t = createShellTracker();
		expect(t.scan(bytes(`${ESC}]133;A\x18${BEL}`))).toEqual([]);
		expect(t.scan(bytes(`${ESC}]133;A${ESC}[0m${BEL}`))).toEqual([]);
		expect(t.phase).toBe("unknown");
		expect(t.scan(bytes(`${ESC}]0;title${ESC}]133;A${BEL}`))).toEqual([{ kind: "phase", phase: "prompt" }]);
	});

	it("finds the same marks however the stream is chunked", () => {
		const piece = fc.oneof(
			fc.constantFrom("A", "B", "C", "D", "D;0", "D;1", "D;127").map((b) => osc(`133;${b}`)),
			fc.constantFrom("D;3", "A").map((b) => osc(`133;${b}`, ST)),
			fc.constantFrom(ESC, BEL, "\\", "]", "\x18", "\n", "\r\n", "133;D;9", osc("0;title"), `${ESC}[1m`),
			fc.string({ maxLength: 12 }),
		);
		const primed = () => {
			const t = atPrompt();
			t.submitted();
			return t;
		};
		fc.assert(
			fc.property(fc.array(piece, { maxLength: 24 }), fc.array(fc.nat(), { maxLength: 12 }), (pieces, cuts) => {
				const stream = bytes(pieces.join(""));
				const whole = primed().scan(stream);

				const edges = [...new Set(cuts.map((c) => c % (stream.length + 1)))].sort((a, b) => a - b);
				const chunked = primed();
				const found: ShellEvent[] = [];
				let from = 0;
				for (const to of [...edges, stream.length]) {
					for (const e of chunked.scan(stream.subarray(from, to))) {
						found.push(e.kind === "finished" ? { ...e, at: e.at + from } : e);
					}
					from = to;
				}
				expect(found).toEqual(whole);
			}),
		);
	});
});
