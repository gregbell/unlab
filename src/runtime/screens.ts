// Terminal screens: one per session, for the session's whole life.
//
// A screen is where a session's bytes go. It scans them for the shell's OSC 133
// marks, and once an <unlab-terminal> has mounted it, it renders them with one
// WTerm (DOM renderer, input, selection, accessibility) over one GhosttyCore
// (Ghostty's VT engine in WebAssembly; the module is compiled once and every
// core instantiates it). Until then it keeps the bytes. Panes never move in
// the DOM, so a screen mounts once: a parked pane or a background tab is
// hidden, which pauses painting while parsing goes on.
//
// Line marks ("who typed a line") are pairs of positions the core tracks
// through scrolling and reflow. The stream itself is never touched.

import { type TerminalCore, type TerminalPosition, type TrackedTerminalPosition, WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
// Let the bundler emit the binary and hand us its real URL; left to resolve
// itself it can end up as a build-machine file: path.
import ghosttyWasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url";
import type { SessionId } from "../model/index.ts";
import { createPromptQueryFilter } from "./prompt-query.ts";
import { createShellTracker, type ShellEvent, type ShellPhase } from "./shell-tracker.ts";
import { BODY_PADDING, ROW_HEIGHT_PX, TERMINAL_COLORS, TERMINAL_STYLE } from "./theme.ts";
import { DEFAULT_TTY_SIZE } from "./vm.ts";

export type MarkSource = "bar" | "agent";

/** What a command printed, as far as the terminal still holds it. */
export interface Printed {
	readonly text: string;
	/** The output's start has left the scrollback, so `text` is its end. */
	readonly truncated: boolean;
}

/** A gutter rule over the rows of one injected command: its line and its output. */
export interface LineMark {
	readonly source: MarkSource;
	/**
	 * Close the mark at the cursor. The shell's next command-finished mark
	 * closes the oldest open mark by itself, at the exact end of the command's
	 * output, so this only matters for a command that never reports. Idempotent.
	 */
	end(): void;
	/**
	 * What the command printed: the marked rows as text, without the echoed
	 * command line. Empty once the rows have all left the scrollback, and for a
	 * mark begun before the screen was mounted.
	 */
	output(): Printed;
}

/**
 * A mark as the gutter draws it. Rows count from the terminal's first visible
 * row and are inclusive: with the body's top padding P and row height H, the
 * rule runs from `P + fromRow * H` for `(toRow - fromRow + 1) * H`. They are
 * fractional while the terminal is scrolled between rows, and clipped to what
 * the terminal shows.
 */
export interface VisibleMark {
	readonly fromRow: number;
	readonly toRow: number;
	readonly source: MarkSource;
}

/** What a screen sends back: keys and terminal replies for the guest, and the grid's size. */
export interface ScreenIo {
	input(data: string): void;
	resize(cols: number, rows: number): void;
}

export interface Screen {
	readonly session: SessionId;
	/** What the session's shell is doing, from every byte written so far. */
	readonly shell: ShellPhase;
	/** Believe only prompt marks with this boot's token, starting over at unknown. */
	expectPromptToken(token: string): void;
	/** The grid the guest should be drawing for. */
	readonly size: { readonly cols: number; readonly rows: number };
	/**
	 * Output from the guest, in order. Returns what it told us about the shell;
	 * usually nothing. An unmounted screen keeps the array, so do not reuse it.
	 */
	write(bytes: Uint8Array): readonly ShellEvent[];
	/** A line was sent to the session's shell. */
	submitted(): readonly ShellEvent[];
	/** The shell owes a typed-ahead line. See shell-tracker.ts. */
	readonly expectsTypedAhead: boolean;
	/** The session stayed quiet while it did, so the shell is at its prompt. */
	settle(): readonly ShellEvent[];
	/**
	 * Render into `host` from now on. Once per screen. Resolves when everything
	 * written so far is on the terminal. Mounting never takes keyboard focus.
	 */
	mount(host: HTMLElement): Promise<void>;
	/** Hidden screens keep parsing and stop painting. A shown screen fits its host and shows the latest output. */
	setVisible(visible: boolean): void;
	/** The focused screen has the keyboard and a solid cursor; the others show a hollow one. */
	setFocused(focused: boolean): void;
	/** Start a mark at the cursor, where `line` is about to be typed. */
	beginMark(source: MarkSource, line: string): LineMark;
	/** The marks on screen now. Marks whose rows have all left the scrollback are forgotten. */
	marks(): readonly VisibleMark[];
	/** Hear, at most once per animation frame, that `marks()` may have changed. */
	subscribe(listener: () => void): () => void;
	/** The last n lines of text, blank rows at the bottom left out. A soft-wrapped line is one line. */
	lastLines(n: number): string;
	/** Everything the terminal still holds, scrollback first. */
	readText(): string;
}

export interface Screens {
	/** The session's screen, created on first use. */
	create(session: SessionId, io: ScreenIo): Screen;
	get(session: SessionId): Screen | undefined;
	dispose(session: SessionId): void;
}

const SCROLLBACK_LINES = 5000;
/** Bytes kept for a screen nobody has mounted yet. A boot log is a few tens of kilobytes. */
const PENDING_LIMIT = 1 << 20;
/** The core tracks 63 positions per terminal. A mark takes two, and wterm's own selection needs some. */
const MAX_MARKS = 24;

const NO_EVENTS: readonly ShellEvent[] = Object.freeze([]);
const NO_MARKS: readonly VisibleMark[] = Object.freeze([]);
const NOTHING: Printed = Object.freeze({ text: "", truncated: false });

interface Mark {
	readonly source: MarkSource;
	readonly from: TrackedTerminalPosition;
	/** `from`'s row counted from the terminal's first ever, not the oldest it still holds. */
	readonly line: number;
	/** Where the command's output ended. Null while the command runs. */
	to: TrackedTerminalPosition | null;
}

interface Buffering {
	readonly kind: "buffering";
	readonly pending: Uint8Array[];
	bytes: number;
	mounting: boolean;
}

interface Live {
	readonly kind: "live";
	readonly el: HTMLElement;
	readonly term: WTerm;
	readonly core: GhosttyCore;
	readonly follow: TailFollower;
}

/**
 * Keeps a terminal on its newest line when its box changes size. wterm checks
 * whether it was at the bottom only after the box has already shrunk, so a
 * pane that re-tiles smaller stops following its output. This remembers the
 * answer from before the layout changed and scrolls back to the bottom.
 */
interface TailFollower {
	disconnect(): void;
}

function followTail(el: HTMLElement, shown: () => boolean): TailFollower {
	let pinned = true;
	const track = () => {
		pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 5;
	};
	const observer = new ResizeObserver(() => {
		if (!pinned || !shown()) return;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
	});
	el.addEventListener("scroll", track, { passive: true });
	observer.observe(el);
	return {
		disconnect() {
			observer.disconnect();
			el.removeEventListener("scroll", track);
		},
	};
}

type State = Buffering | Live | { readonly kind: "disposed" };

interface OwnedScreen extends Screen {
	dispose(): void;
}

function cursorPosition(core: TerminalCore): TerminalPosition {
	const cursor = core.getCursor();
	return { row: core.getScrollbackCount() + cursor.row, col: cursor.col };
}

/** How many rows the terminal has ever dropped from the oldest end. */
function discarded(core: TerminalCore): number {
	return core.getScrollbackDiscardedCount?.() ?? 0;
}

/** One retained row as text. Row zero is the oldest the core still holds. */
function readRow(core: TerminalCore, row: number, history: number, limit: number) {
	const inHistory = row < history;
	const offset = history - row - 1;
	const meta = inHistory ? core.getScrollbackRowMetadata?.(offset) : core.getRowMetadata?.(row - history);
	const cols = Math.min(limit, inHistory ? core.getScrollbackLineLen(offset) : core.getCols());
	let text = "";
	for (let col = 0; col < cols; col++) {
		const cell = inHistory ? core.getScrollbackCell(offset, col) : core.getCell(row - history, col);
		if (cell.width === 0 || cell.spacerHead) continue;
		text += cell.chars ?? String.fromCodePoint(cell.char || 32);
	}
	const wraps = meta?.wrapsToNext ?? false;
	// The padding of a hard line end is not text; the spaces of a wrapped row are.
	return { text: wraps ? text : text.trimEnd(), wraps, continues: meta?.continuesPrevious ?? false };
}

/** Rows [from, to) as lines, a soft-wrapped line being one line. The last row is read up to `lastCols`. */
function linesOf(core: TerminalCore, from: number, to: number, lastCols = Number.POSITIVE_INFINITY): string[] {
	const history = core.getScrollbackCount();
	const lines: string[] = [];
	let wrapped = false;
	for (let row = Math.max(0, from); row < to; row++) {
		const r = readRow(core, row, history, row === to - 1 ? lastCols : Number.POSITIVE_INFINITY);
		if (wrapped && r.continues && lines.length) lines[lines.length - 1] += r.text;
		else lines.push(r.text);
		wrapped = r.wraps;
	}
	return lines;
}

/**
 * How many of `lines` are the echo of the typed line. readline lets the
 * terminal wrap, which reads back as one line, but busybox's line editor ends
 * each full row with a line feed, so its echo can be several. Spaces are left
 * out of the comparison: those at the end of a row do not read back. An echo
 * that does not add up to the line, such as one the shell redrew, is taken to
 * be the first.
 */
function echoedLines(lines: readonly string[], prompt: string, typed: string): number {
	const solid = (s: string) => s.replace(/\s+/g, "");
	const whole = solid(typed);
	const before = solid(prompt);
	let echo = "";
	for (let i = 0; i < lines.length; i++) {
		const text = solid(lines[i]);
		echo += i === 0 && text.startsWith(before) ? text.slice(before.length) : text;
		if (echo === whole) return i + 1;
		if (!whole.startsWith(echo)) break;
	}
	return 1;
}

function createScreen(session: SessionId, io: ScreenIo, loadCore: () => Promise<GhosttyCore>): OwnedScreen {
	const tracker = createShellTracker();
	const withoutPromptQuery = createPromptQueryFilter();
	const marks: Mark[] = [];
	const listeners = new Set<() => void>();
	let state: State = { kind: "buffering", pending: [], bytes: 0, mounting: false };
	let size: { cols: number; rows: number } = DEFAULT_TTY_SIZE;
	let visible = true;
	let focused = false;
	let replaying = false;
	let notifying = false;

	const invalidate = () => {
		if (notifying || listeners.size === 0) return;
		notifying = true;
		requestAnimationFrame(() => {
			notifying = false;
			for (const listener of [...listeners]) listener();
		});
	};

	const resized = (cols: number, rows: number) => {
		if (cols === size.cols && rows === size.rows) return;
		size = { cols, rows };
		io.resize(cols, rows);
		invalidate();
	};

	const drop = (mark: Mark) => {
		mark.from.dispose();
		mark.to?.dispose();
		const i = marks.indexOf(mark);
		if (i >= 0) marks.splice(i, 1);
	};

	/**
	 * Both ends of a mark, or null once its end has left the scrollback. An
	 * open mark ends at the cursor. With only the start gone, every row up to
	 * the end is the command's. A start can also be lost to a reset or a
	 * full-screen program, and then nothing says which rows those are.
	 */
	const ends = (mark: Mark, core: TerminalCore) => {
		const from = mark.from.resolve();
		const end = mark.to ? mark.to.resolve() : cursorPosition(core);
		if (!end) return null;
		if (from) return { from, end, truncated: false };
		return discarded(core) > mark.line ? { from: { row: 0, col: 0 }, end, truncated: true } : null;
	};

	const close = (mark: Mark, core: GhosttyCore) => {
		if (mark.to) return;
		mark.to = core.trackPosition(cursorPosition(core));
		if (!mark.to) drop(mark);
		invalidate();
	};

	const reveal = (live: Live) => {
		live.term.fit();
		live.term.setRenderingPaused(false);
		// A hidden element loses its scroll offset, and wterm follows output only
		// from the bottom. Its own render is already queued for this frame.
		requestAnimationFrame(() => {
			if (state === live && visible) live.el.scrollTop = live.el.scrollHeight;
		});
	};

	const keep = (buffer: Buffering, bytes: Uint8Array) => {
		buffer.pending.push(bytes);
		buffer.bytes += bytes.length;
		while (buffer.bytes > PENDING_LIMIT && buffer.pending.length > 1) {
			const dropped = buffer.pending.shift();
			if (dropped) buffer.bytes -= dropped.length;
		}
	};

	const unanchored = (source: MarkSource): LineMark => ({ source, end() {}, output: () => NOTHING });

	return {
		session,
		get shell() {
			return tracker.phase;
		},
		expectPromptToken(token) {
			tracker.expectToken(token);
		},
		get size() {
			return size;
		},

		write(raw) {
			if (state.kind === "disposed") return NO_EVENTS;
			const bytes = withoutPromptQuery(raw);
			const events = tracker.scan(bytes);
			if (state.kind === "buffering") {
				keep(state, bytes);
				return events;
			}
			const { term, core } = state;
			let written = 0;
			for (const event of events) {
				if (event.kind !== "finished") continue;
				const open = marks.find((m) => m.to === null);
				if (!open) break;
				// Stop at the mark, so the open line mark ends where the command's
				// output did and not after the prompt that follows in the same chunk.
				term.write(bytes.subarray(written, event.at));
				written = event.at;
				close(open, core);
			}
			if (written < bytes.length) term.write(written === 0 ? bytes : bytes.subarray(written));
			invalidate();
			return events;
		},

		submitted: () => tracker.submitted(),
		get expectsTypedAhead() {
			return tracker.expectsTypedAhead;
		},
		settle: () => tracker.settle(),

		async mount(host) {
			if (state.kind === "disposed") return;
			if (state.kind !== "buffering" || state.mounting) throw new Error(`${session} is already mounted`);
			const buffer = state;
			buffer.mounting = true;

			const el = host.ownerDocument.createElement("div");
			el.setAttribute("aria-label", `Terminal ${session}`);
			for (const [property, value] of Object.entries(TERMINAL_STYLE)) el.style.setProperty(property, value);
			host.append(el);

			let core: GhosttyCore | undefined;
			let term: WTerm | undefined;
			try {
				core = await loadCore();
				term = new WTerm(el, {
					core,
					cols: size.cols,
					rows: size.rows,
					autoResize: true,
					cursorBlink: false,
					renderingPaused: !visible,
					announceOutput: true,
					webmcp: false,
					onData: (data) => {
						// Replies to queries in replayed output answer questions the guest stopped asking.
						if (!replaying) io.input(data);
					},
					onResize: resized,
				});
				term.setThemeColors(TERMINAL_COLORS);
				// init() focuses the terminal's input. A new terminal must not take the keyboard.
				el.inert = true;
				try {
					await term.init();
				} finally {
					el.inert = false;
				}
			} catch (e) {
				term?.destroy();
				core?.dispose();
				el.remove();
				buffer.mounting = false;
				throw e;
			}
			if (state !== buffer) {
				term.destroy();
				core.dispose();
				el.remove();
				return;
			}

			replaying = true;
			try {
				for (const chunk of buffer.pending) term.write(chunk);
			} finally {
				replaying = false;
			}
			const live: Live = { kind: "live", el, term, core, follow: followTail(el, () => state === live && visible) };
			state = live;
			el.addEventListener("scroll", invalidate, { passive: true });
			resized(term.cols, term.rows);
			if (visible) reveal(live);
			if (focused) term.focus();
			invalidate();
		},

		setVisible(next) {
			if (visible === next) return;
			visible = next;
			if (state.kind !== "live") return;
			if (next) reveal(state);
			else state.term.setRenderingPaused(true);
			invalidate();
		},

		setFocused(next) {
			focused = next;
			if (state.kind !== "live") return;
			if (next) {
				state.term.focus();
				return;
			}
			const active = state.el.ownerDocument.activeElement;
			if (active instanceof HTMLElement && state.el.contains(active)) active.blur();
		},

		beginMark(source, line) {
			if (state.kind !== "live") return unanchored(source);
			const { core } = state;
			for (const mark of [...marks]) if (!ends(mark, core)) drop(mark);
			while (marks.length >= MAX_MARKS) drop(marks[0]);
			const cursor = cursorPosition(core);
			const from = core.trackPosition(cursor);
			if (!from) return unanchored(source);
			const mark: Mark = { source, from, line: discarded(core) + cursor.row, to: null };
			marks.push(mark);
			invalidate();
			return {
				source,
				end() {
					if (state.kind === "live" && marks.includes(mark)) close(mark, state.core);
				},
				output() {
					if (state.kind !== "live" || !marks.includes(mark)) return NOTHING;
					const span = ends(mark, state.core);
					if (!span) return NOTHING;
					// An end at column 0 is the start of the row after the output's last.
					const lines =
						span.end.col === 0
							? linesOf(state.core, span.from.row, span.end.row)
							: linesOf(state.core, span.from.row, span.end.row + 1, span.end.col);
					const { truncated } = span;
					if (truncated) return { text: lines.join("\n"), truncated };
					const prompt = linesOf(state.core, span.from.row, span.from.row + 1, span.from.col)[0] ?? "";
					return { text: lines.slice(echoedLines(lines, prompt, line)).join("\n"), truncated };
				},
			};
		},

		marks() {
			if (state.kind !== "live" || !visible) return NO_MARKS;
			const { core, el } = state;
			const rowHeight = Number.parseFloat(el.style.getPropertyValue("--term-row-height")) || ROW_HEIGHT_PX;
			const scrolled = el.scrollTop / rowHeight;
			const top = -BODY_PADDING.top / rowHeight;
			const bottom = (el.clientHeight - BODY_PADDING.top) / rowHeight;
			const shown: VisibleMark[] = [];
			for (const mark of [...marks]) {
				const span = ends(mark, core);
				if (!span) {
					drop(mark);
					continue;
				}
				const last = Math.max(span.from.row, span.end.col === 0 ? span.end.row - 1 : span.end.row);
				const from = Math.max(span.from.row - scrolled, top);
				const to = Math.min(last + 1 - scrolled, bottom);
				if (to > from) shown.push({ fromRow: from, toRow: to - 1, source: mark.source });
			}
			return shown;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		lastLines(n) {
			if (state.kind !== "live" || n <= 0) return "";
			const { core } = state;
			const history = core.getScrollbackCount();
			let row = history + core.getRows() - 1;
			while (row >= 0 && readRow(core, row, history, Number.POSITIVE_INFINITY).text === "") row--;
			const lines: string[] = [];
			let line = "";
			let open = false;
			for (; row >= 0 && lines.length < n; row--) {
				const r = readRow(core, row, history, Number.POSITIVE_INFINITY);
				line = r.text + line;
				open = r.continues;
				if (!open) {
					lines.unshift(line);
					line = "";
				}
			}
			if (open && lines.length < n) lines.unshift(line);
			return lines.join("\n");
		},

		readText() {
			if (state.kind !== "live") return "";
			const { core } = state;
			const lines = linesOf(core, 0, core.getScrollbackCount() + core.getRows());
			while (lines.length && lines[lines.length - 1] === "") lines.pop();
			return lines.join("\n");
		},

		dispose() {
			const was = state;
			state = { kind: "disposed" };
			for (const mark of [...marks]) drop(mark);
			listeners.clear();
			if (was.kind !== "live") return;
			was.el.removeEventListener("scroll", invalidate);
			was.follow.disconnect();
			was.term.destroy();
			was.core.dispose();
			was.el.remove();
		},
	};
}

export function createScreens(): Screens {
	const screens = new Map<SessionId, OwnedScreen>();
	const loadCore = () => GhosttyCore.load({ wasmPath: ghosttyWasmUrl, scrollbackLines: SCROLLBACK_LINES });
	return {
		create(session, io) {
			const existing = screens.get(session);
			if (existing) return existing;
			const screen = createScreen(session, io, loadCore);
			screens.set(session, screen);
			return screen;
		},
		get: (session) => screens.get(session),
		dispose(session) {
			screens.get(session)?.dispose();
			screens.delete(session);
		},
	};
}
