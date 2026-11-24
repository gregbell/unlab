import "@wterm/dom/css";
import { afterEach, describe, expect, test } from "vitest";
import type { SessionId } from "../model/index.ts";
import { createScreens, type Screen, type ScreenIo } from "./screens.ts";

const ESC = "\x1b";
const BEL = "\x07";
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async (n: number) => {
	for (let i = 0; i < n; i++) await frame();
};

/** What the guest's shell prints once a command returns: its status, then a fresh prompt. */
const prompt = (exit: number) => `${ESC}]133;D;${exit}${BEL}${ESC}]133;A${BEL}node1:~$ ${ESC}]133;B${BEL}`;

const screens = createScreens();
const hosts: HTMLElement[] = [];
let made = 0;

function host(width = 640, height = 260): HTMLElement {
	const el = document.createElement("div");
	el.style.cssText = `width:${width}px;height:${height}px;position:relative;`;
	document.body.append(el);
	hosts.push(el);
	return el;
}

function screen(io: Partial<ScreenIo> = {}): Screen {
	const session: SessionId = `node${++made}:console`;
	return screens.create(session, { input: io.input ?? (() => {}), resize: io.resize ?? (() => {}) });
}

/** The text of the rows the terminal has painted. */
const painted = (el: HTMLElement): string[] =>
	[...el.querySelectorAll(".term-row")].map((row) => (row.textContent ?? "").trimEnd());

/** The painted row holding `text`, as the gutter would address it: rows from the top of the terminal's text. */
function paintedRowOf(el: HTMLElement, text: string): number {
	const terminal = el.firstElementChild;
	if (!(terminal instanceof HTMLElement)) throw new Error("no terminal in the host");
	const row = [...el.querySelectorAll(".term-row")].find((r) => r.textContent?.includes(text));
	if (!row) throw new Error(`no painted row holds ${JSON.stringify(text)}`);
	const paddingTop = Number.parseFloat(getComputedStyle(terminal).paddingTop);
	const top = row.getBoundingClientRect().top - terminal.getBoundingClientRect().top - paddingTop;
	return top / row.getBoundingClientRect().height;
}

function inView(el: HTMLElement, text: string): boolean {
	const row = [...el.querySelectorAll(".term-row")].find((r) => r.textContent?.includes(text));
	if (!row) return false;
	const box = el.getBoundingClientRect();
	const r = row.getBoundingClientRect();
	return r.top >= box.top && r.bottom <= box.bottom;
}

afterEach(() => {
	for (const el of hosts.splice(0)) el.remove();
});

describe("mounting", () => {
	test("bytes written before the mount appear after it", async () => {
		const s = screen();
		s.write(bytes("Welcome to Alpine Linux\r\n"));
		s.write(bytes("node1 login: user\r\n"));
		expect(s.readText()).toBe("");

		const el = host();
		await s.mount(el);
		await frames(2);

		expect(painted(el)).toEqual(expect.arrayContaining(["Welcome to Alpine Linux", "node1 login: user"]));
		expect(s.readText()).toBe("Welcome to Alpine Linux\nnode1 login: user");
	});

	test("bytes that arrive while the terminal is still loading are not lost or reordered", async () => {
		const s = screen();
		const el = host();
		s.write(bytes("one\r\n"));
		const mounted = s.mount(el);
		s.write(bytes("two\r\n"));
		await mounted;
		s.write(bytes("three\r\n"));
		expect(s.readText()).toBe("one\ntwo\nthree");
	});

	test("a screen mounts once", async () => {
		const s = screen();
		await s.mount(host());
		await expect(s.mount(host())).rejects.toThrow(/already mounted/);
	});

	test("mounting does not take the keyboard from whoever has it", async () => {
		const bar = document.createElement("input");
		document.body.append(bar);
		bar.focus();
		let blurred = 0;
		bar.addEventListener("blur", () => blurred++);

		const s = screen();
		await s.mount(host());
		await frames(2);

		expect(document.activeElement).toBe(bar);
		expect(blurred).toBe(0);
		bar.remove();
	});

	test("replies to queries in the replayed log are not sent to the guest, live ones are", async () => {
		const sent: string[] = [];
		const s = screen({ input: (data) => sent.push(data) });
		s.write(bytes(`boot${ESC}[6n`));
		await s.mount(host());
		expect(sent).toEqual([]);

		s.write(bytes(`${ESC}[6n`));
		expect(sent).toEqual([`${ESC}[1;5R`]);
	});

	test("the grid fits its host, and the guest is told the size", async () => {
		const sizes: [number, number][] = [];
		const s = screen({ resize: (cols, rows) => sizes.push([cols, rows]) });
		expect(s.size).toEqual({ cols: 100, rows: 30 });

		const el = host(640, 262);
		await s.mount(el);
		await frames(3);

		// 262px less the body's 10px and 12px padding is twelve 20px rows.
		expect(s.size.rows).toBe(12);
		expect(s.size.cols).toBeLessThan(100);
		expect(sizes.at(-1)).toEqual([s.size.cols, 12]);
	});
});

describe("theme", () => {
	test("a transparent ground, the terminal text size and row height, with no shadow or rounding", async () => {
		const s = screen();
		const el = host();
		s.write(bytes("text\r\n"));
		await s.mount(el);
		await frames(2);

		const terminal = el.firstElementChild;
		if (!(terminal instanceof HTMLElement)) throw new Error("no terminal in the host");
		const style = getComputedStyle(terminal);
		expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
		expect(style.color).toBe("rgb(205, 214, 244)");
		expect(style.fontSize).toBe("12.5px");
		expect(style.padding).toBe("10px 14px 12px");
		expect(style.boxShadow).toBe("none");
		expect(style.borderRadius).toBe("0px");
		expect(el.querySelector(".term-row")?.getBoundingClientRect().height).toBe(20);
	});

	test("ANSI red is the handoff's red", async () => {
		const s = screen();
		const el = host();
		s.write(bytes(`${ESC}[31mfailed${ESC}[0m\r\n`));
		await s.mount(el);
		await frames(2);

		const span = [...el.querySelectorAll(".term-row span")].find((e) => e.textContent?.includes("failed"));
		if (!span) throw new Error("no span holds the red text");
		expect(getComputedStyle(span).color).toBe("rgb(243, 139, 168)");
	});

	test("the cursor is a solid --text block when focused and hollow when not", async () => {
		const s = screen();
		const el = host();
		await s.mount(el);
		s.setFocused(true);
		await frames(2);
		const cursor = () => {
			const c = el.querySelector(".term-cursor");
			if (!c) throw new Error("no cursor painted");
			return getComputedStyle(c);
		};
		expect(cursor().backgroundColor).toBe("rgb(205, 214, 244)");

		s.setFocused(false);
		await frames(2);
		expect(cursor().backgroundColor).toBe("rgba(0, 0, 0, 0)");
		expect(cursor().outlineColor).toBe("rgb(205, 214, 244)");
		expect(cursor().outlineStyle).toBe("solid");
	});
});

describe("visibility", () => {
	test("a hidden screen keeps parsing, and shows the latest output when it comes back", async () => {
		const s = screen();
		const el = host();
		await s.mount(el);
		s.write(bytes("before hiding\r\n"));
		await frames(2);

		el.hidden = true;
		s.setVisible(false);
		await frames(2);
		for (let i = 1; i <= 40; i++) s.write(bytes(`hidden ${i}\r\n`));
		s.write(bytes(prompt(0)));
		await frames(2);

		expect(painted(el)).not.toContain("hidden 40");
		expect(s.lastLines(2)).toBe("hidden 40\nnode1:~$");
		expect(s.shell).toBe("prompt");

		el.hidden = false;
		s.setVisible(true);
		await frames(3);
		expect(inView(el, "hidden 40")).toBe(true);
		expect(inView(el, "before hiding")).toBe(false);
	});

	test("a screen mounted into a hidden host fits and paints once it is shown", async () => {
		const s = screen();
		const el = host(640, 262);
		el.hidden = true;
		s.setVisible(false);
		await s.mount(el);
		for (let i = 1; i <= 30; i++) s.write(bytes(`line ${i}\r\n`));
		expect(s.size).toEqual({ cols: 100, rows: 30 });

		el.hidden = false;
		s.setVisible(true);
		await frames(3);
		expect(s.size.rows).toBe(12);
		expect(inView(el, "line 30")).toBe(true);
	});

	test("a visible screen follows new output", async () => {
		const s = screen();
		const el = host();
		await s.mount(el);
		await frames(3);
		for (let i = 1; i <= 60; i++) s.write(bytes(`line ${i}\r\n`));
		await frames(2);
		expect(inView(el, "line 60")).toBe(true);
	});
});

describe("line marks", () => {
	async function ready() {
		const s = screen();
		const el = host();
		await s.mount(el);
		s.write(bytes(`boot log\r\n${prompt(0)}`));
		await frames(3);
		return { s, el };
	}

	/** Type a command at the prompt as exec does, and let it print. */
	function run(s: Screen, command: string, output: string, exit: number, source: "bar" | "agent" = "bar") {
		const mark = s.beginMark(source, command);
		s.submitted();
		s.write(bytes(`${command}\r\n${output}`));
		s.write(bytes(prompt(exit)));
		return mark;
	}

	test("a mark spans the rows from the command line to the end of its output", async () => {
		const { s, el } = await ready();
		const mark = run(s, "ls /etc", "hosts\r\npasswd\r\n", 0);
		await frames(2);

		expect(mark.output()).toEqual({ text: "hosts\npasswd", truncated: false });
		const first = paintedRowOf(el, "node1:~$ ls /etc");
		const last = paintedRowOf(el, "passwd");
		expect(last - first).toBe(2);
		const [shown, ...rest] = s.marks();
		expect(rest).toEqual([]);
		expect(shown.source).toBe("bar");
		expect(shown.fromRow).toBeCloseTo(first, 5);
		expect(shown.toRow).toBeCloseTo(last, 5);
	});

	test("an open mark grows with the output and closes at the command's end, not the next prompt", async () => {
		const { s, el } = await ready();
		const mark = s.beginMark("agent", "ping -c2 node2");
		s.submitted();
		s.write(bytes("ping -c2 node2\r\nreply 1\r\n"));
		await frames(2);
		expect(s.marks().map((m) => m.toRow - m.fromRow)).toEqual([1]);
		expect(mark.output()).toEqual({ text: "reply 1", truncated: false });

		s.write(bytes(`reply 2\r\n${prompt(0)}`));
		s.write(bytes("typed by hand\r\nmore\r\n"));
		await frames(2);

		expect(mark.output()).toEqual({ text: "reply 1\nreply 2", truncated: false });
		const [shown] = s.marks();
		expect(shown.source).toBe("agent");
		expect(shown.fromRow).toBeCloseTo(paintedRowOf(el, "ping -c2 node2"), 5);
		expect(shown.toRow).toBeCloseTo(paintedRowOf(el, "reply 2"), 5);
	});

	test("a mark survives further output: it moves with its rows as they scroll", async () => {
		const { s, el } = await ready();
		const mark = run(s, "uname", "Linux\r\n", 0);
		for (let i = 1; i <= 6; i++) s.write(bytes(`later ${i}\r\n`));
		await frames(2);
		const before = s.marks();
		expect(before).toHaveLength(1);
		expect(before[0].fromRow).toBeCloseTo(paintedRowOf(el, "node1:~$ uname"), 5);

		for (let i = 7; i <= 9; i++) s.write(bytes(`later ${i}\r\n`));
		await frames(2);
		const after = s.marks();
		expect(after[0].fromRow).toBeCloseTo(paintedRowOf(el, "node1:~$ uname"), 5);
		expect(after[0].fromRow).toBeLessThan(before[0].fromRow);
		expect(after[0].toRow - after[0].fromRow).toBe(1);
		expect(mark.output()).toEqual({ text: "Linux", truncated: false });
	});

	test("a mark scrolled out of view is not drawn, and one out of the scrollback is forgotten", async () => {
		const { s } = await ready();
		const mark = run(s, "date", "Sun Nov 22\r\n", 0);
		for (let i = 1; i <= 100; i++) s.write(bytes(`later ${i}\r\n`));
		await frames(2);
		expect(s.marks()).toEqual([]);
		expect(mark.output()).toEqual({ text: "Sun Nov 22", truncated: false });

		const filler = bytes("x\r\n".repeat(1000));
		for (let i = 0; i < 6; i++) s.write(filler);
		await frames(2);
		expect(s.marks()).toEqual([]);
		expect(mark.output()).toEqual({ text: "", truncated: false });
	});

	const numbers = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}`);

	test("output longer than the scrollback keeps its end, says it was cut, and is still marked", async () => {
		const { s } = await ready();
		const mark = run(s, "seq 1 20000", `${numbers(1, 20000).join("\r\n")}\r\n`, 0);
		await frames(2);

		const { text, truncated } = mark.output();
		expect(truncated).toBe(true);
		const lines = text.split("\n");
		expect(lines.length).toBeGreaterThan(4000);
		expect(lines).toEqual(numbers(20001 - lines.length, 20000));
		expect(s.marks()).toHaveLength(1);

		s.write(bytes("typed by hand\r\n"));
		expect(mark.output().text.endsWith("\n20000")).toBe(true);
	});

	test("a command still printing once its start is gone keeps its mark and reads to its end", async () => {
		const { s } = await ready();
		const mark = s.beginMark("agent", "seq 1 20000");
		s.submitted();
		s.write(bytes("seq 1 20000\r\n"));
		for (let from = 1; from <= 20000; from += 4000) {
			s.write(bytes(`${numbers(from, from + 3999).join("\r\n")}\r\n`));
			await frames(2);
			expect(s.marks()).toHaveLength(1);
		}
		s.write(bytes(prompt(0)));
		const { text, truncated } = mark.output();
		expect(truncated).toBe(true);
		expect(text.endsWith("19999\n20000")).toBe(true);
	});

	test("a full-screen program gives back nothing, not what was on the terminal before it", async () => {
		const { s } = await ready();
		const mark = run(s, "vi", `${ESC}[?1049hediting${ESC}[?1049l`, 0);
		expect(mark.output()).toEqual({ text: "", truncated: false });
	});

	test("output with no trailing newline is still the command's output", async () => {
		const { s } = await ready();
		const mark = run(s, "printf hi", "hi", 0);
		expect(mark.output()).toEqual({ text: "hi", truncated: false });
	});

	test("a command that prints nothing marks only its own line", async () => {
		const { s, el } = await ready();
		const mark = run(s, "true", "", 0);
		await frames(2);
		expect(mark.output()).toEqual({ text: "", truncated: false });
		const [shown] = s.marks();
		expect(shown.toRow).toBeCloseTo(shown.fromRow, 5);
		expect(shown.fromRow).toBeCloseTo(paintedRowOf(el, "node1:~$ true"), 5);
	});

	test("a long command line that wraps is one echoed line, and wrapped output is one line", async () => {
		const { s } = await ready();
		const long = `echo ${"a".repeat(s.size.cols + 20)}`;
		const mark = run(s, long, `${"b".repeat(s.size.cols + 5)}\r\nend\r\n`, 0);
		expect(mark.output()).toEqual({ text: `${"b".repeat(s.size.cols + 5)}\nend`, truncated: false });
	});

	/** Echo as busybox does: its line editor ends every full row with a line feed of its own. */
	function hardWrapped(s: Screen, command: string): string {
		const first = s.size.cols - "node1:~$ ".length;
		const rows = [command.slice(0, first)];
		for (let i = first; i < command.length; i += s.size.cols) rows.push(command.slice(i, i + s.size.cols));
		return rows.join("\r\n");
	}

	test.each([
		["over two rows", (cols: number) => `echo ${"a".repeat(cols)}`],
		["over four rows", (cols: number) => `echo ${"a".repeat(cols * 3)}`],
		["at a space", (cols: number) => `echo ${"a".repeat(cols - "node1:~$ echo ".length - 1)} ${"b".repeat(9)}`],
	])("a command line the shell wraps itself is all echo: %s", async (_, line) => {
		const { s } = await ready();
		const command = line(s.size.cols);
		const mark = s.beginMark("agent", command);
		s.submitted();
		s.write(bytes(`${hardWrapped(s, command)}\r\n`));
		s.write(bytes(`out\r\nend\r\n${prompt(0)}`));
		expect(mark.output()).toEqual({ text: "out\nend", truncated: false });
	});

	test("output that repeats the command is output", async () => {
		const { s } = await ready();
		expect(run(s, "cat f", "cat f\r\ncat f\r\n", 0).output().text).toBe("cat f\ncat f");
	});

	test("an echo that is not the line typed loses its first row only", async () => {
		const { s } = await ready();
		const mark = s.beginMark("agent", "one that was redrawn");
		s.submitted();
		s.write(bytes(`one\r\nout\r\n${prompt(0)}`));
		expect(mark.output().text).toBe("out");
	});

	test("ending a mark by hand closes it at the cursor", async () => {
		const { s } = await ready();
		const mark = s.beginMark("bar", "sleep 100");
		s.write(bytes("sleep 100\r\nstill here\r\n"));
		mark.end();
		s.write(bytes("after the mark\r\n"));
		mark.end();
		expect(mark.output()).toEqual({ text: "still here", truncated: false });
	});

	test("subscribers hear about marks once per frame, however much is written", async () => {
		const { s } = await ready();
		let heard = 0;
		const off = s.subscribe(() => heard++);
		await frames(2);
		heard = 0;

		run(s, "seq 3", "1\r\n2\r\n3\r\n", 0);
		for (let i = 0; i < 50; i++) s.write(bytes("more\r\n"));
		await frame();
		expect(heard).toBe(1);

		off();
		s.write(bytes("unheard\r\n"));
		await frames(2);
		expect(heard).toBe(1);
	});

	test("a mark begun before the mount draws nothing and reads as empty", () => {
		const s = screen();
		const mark = s.beginMark("bar", "echo hi");
		s.write(bytes(`echo hi\r\nhi\r\n${prompt(0)}`));
		mark.end();
		expect(mark.output()).toEqual({ text: "", truncated: false });
		expect(s.marks()).toEqual([]);
	});
});

describe("reading text", () => {
	test("lastLines gives the newest lines, without the blank rows below the cursor", async () => {
		const s = screen();
		await s.mount(host());
		for (let i = 1; i <= 50; i++) s.write(bytes(`line ${i}\r\n`));
		s.write(bytes("node1:~$ "));

		expect(s.lastLines(3)).toBe("line 49\nline 50\nnode1:~$");
		expect(s.lastLines(1)).toBe("node1:~$");
		expect(s.lastLines(0)).toBe("");
		expect(s.lastLines(500).split("\n")).toHaveLength(51);
	});

	test("a soft-wrapped line is one line", async () => {
		const s = screen();
		await s.mount(host());
		await frames(3);
		const long = "w".repeat(s.size.cols * 2 + 7);
		s.write(bytes(`short\r\n${long}\r\nlast\r\n`));
		expect(s.lastLines(2)).toBe(`${long}\nlast`);
		expect(s.readText()).toBe(`short\n${long}\nlast`);
	});

	test("readText reaches back into the scrollback", async () => {
		const s = screen();
		await s.mount(host());
		for (let i = 1; i <= 200; i++) s.write(bytes(`line ${i}\r\n`));
		const lines = s.readText().split("\n");
		expect(lines).toHaveLength(200);
		expect([lines[0], lines[199]]).toEqual(["line 1", "line 200"]);
	});
});

describe("the shell's phase", () => {
	test("follows the marks in what is written, mounted or not", async () => {
		const s = screen();
		expect(s.shell).toBe("unknown");
		expect(s.write(bytes(prompt(0)))).toEqual([{ kind: "phase", phase: "prompt" }]);
		expect(s.submitted()).toEqual([{ kind: "phase", phase: "running" }]);
		expect(s.shell).toBe("running");

		await s.mount(host());
		expect(s.write(bytes(`out\r\n${prompt(2)}`))).toEqual([
			{ kind: "finished", exitCode: 2, at: 15 },
			{ kind: "phase", phase: "prompt" },
		]);
		expect(s.shell).toBe("prompt");
	});
});

describe("disposal", () => {
	test("a disposed screen leaves the host empty and takes no more bytes", async () => {
		const el = host();
		const session: SessionId = "node99:sh1";
		const s = screens.create(session, { input: () => {}, resize: () => {} });
		expect(screens.get(session)).toBe(s);
		expect(screens.create(session, { input: () => {}, resize: () => {} })).toBe(s);
		await s.mount(el);
		s.write(bytes("text\r\n"));

		screens.dispose(session);
		expect(screens.get(session)).toBeUndefined();
		expect(el.childElementCount).toBe(0);
		expect(s.write(bytes(prompt(0)))).toEqual([]);
		expect(s.readText()).toBe("");
	});

	test("disposing while the terminal is still loading leaves nothing behind", async () => {
		const el = host();
		const session: SessionId = "node98:sh1";
		const s = screens.create(session, { input: () => {}, resize: () => {} });
		const mounted = s.mount(el);
		screens.dispose(session);
		await mounted;
		expect(el.childElementCount).toBe(0);
	});
});
