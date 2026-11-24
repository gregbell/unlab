// The command bar as a pure state machine. The element forwards keys, edits
// and clicks as BarInput, renders barView(bar, lab, registry), and carries out
// the effects. Everything the artboards draw is decided here, without a DOM.

import { type Approval, grantApproval } from "../../commands/approval.ts";
import {
	type Completion,
	type ConfirmText,
	changedSinceAsked,
	completeLine,
	type DangerLine,
	isLineError,
	type LineError,
	NOTHING_CHANGED,
	type ParsedLine,
	type Preview,
	parseLine,
	type Registry,
	type ReportBlock,
	type Result,
	type Suggestion,
	tokenize,
} from "../../commands/index.ts";
import { type LabState, type SessionId, type Source, selectBarHistory, selectRecent } from "../../model/index.ts";

type Report = Extract<Result, { readonly kind: "report" }>;

/** What the bar is doing. Everything else it shows is derived from this, the text and the lab. */
export type BarMode =
	| { readonly kind: "typing" }
	/** Shown on Enter, about the text as it is. Any edit leaves it. */
	| { readonly kind: "error"; readonly error: LineError }
	/** A dangerous line waiting for a second Enter. `line` is canonical, as the approval names it, and `asked` is what the approval is for. */
	| { readonly kind: "confirm"; readonly line: string; readonly asked: ConfirmText }
	| { readonly kind: "running"; readonly run: number; readonly line: string; readonly keepOpen: boolean }
	| { readonly kind: "result"; readonly line: string; readonly report: Report };

type Confirming = Extract<BarMode, { readonly kind: "confirm" }>;

export interface OpenBar {
	readonly open: true;
	readonly text: string;
	readonly caret: number;
	readonly mode: BarMode;
	/** The chosen row; null means the default for what is shown. */
	readonly chosen: number | null;
	/** While walking back through bar history with the up arrow: how far back. */
	readonly history: number | null;
	/** Run ids only go up, so a late result for an old run is recognised and dropped. */
	readonly runs: number;
}

export type BarState = { readonly open: false; readonly runs: number } | OpenBar;

export const RESTING: BarState = { open: false, runs: 0 };

export type BarInput =
	/** The open shortcut or a click in the resting field. */
	| { readonly kind: "open" }
	/** A button for a dangerous verb: open on its line, already confirming. */
	| { readonly kind: "open-confirming"; readonly line: string }
	/** The input's text or caret changed. */
	| { readonly kind: "edit"; readonly text: string; readonly caret: number }
	| { readonly kind: "tab" }
	| { readonly kind: "shift-tab" }
	| { readonly kind: "up" }
	| { readonly kind: "down" }
	/** Enter, or ⌘Enter / Ctrl+Enter with `keepOpen`. */
	| { readonly kind: "enter"; readonly keepOpen: boolean }
	| { readonly kind: "escape" }
	| { readonly kind: "digit"; readonly digit: number }
	/** A click on a suggestion row. */
	| { readonly kind: "choose"; readonly row: number }
	/** The confirm block's action button (`Remove node3`). */
	| { readonly kind: "approve" }
	/** The confirm block's `Keep it`. */
	| { readonly kind: "keep" }
	/** A result block's link to its console. */
	| { readonly kind: "open-console"; readonly session: SessionId }
	/** A click outside the panel. */
	| { readonly kind: "dismiss" }
	/** A run effect settled. */
	| { readonly kind: "ran"; readonly run: number; readonly result: Result | LineError };

export type BarEffect =
	/** Run the line as `source`, with the approval when it is dangerous, and report back with `ran`. */
	| {
			readonly type: "run";
			readonly run: number;
			readonly line: string;
			readonly source: Extract<Source, "bar" | "button">;
			readonly approval: Approval | null;
	  }
	/** The bar closed while this run was going: stop waiting for it. */
	| { readonly type: "abort"; readonly run: number }
	/** The panel closes and the lab hears `ui/bar` closed. */
	| { readonly type: "close" }
	/** Give the keyboard back to the pane that holds it. */
	| { readonly type: "focus-return" }
	/** The key is not the bar's: let the browser have it, so Tab moves focus on. */
	| { readonly type: "pass" };

export interface BarStep {
	readonly bar: BarState;
	readonly effects: readonly BarEffect[];
}

export type BarRow =
	| { readonly kind: "recent"; readonly line: string; readonly source: Source; readonly at: number }
	| { readonly kind: "verb"; readonly name: string; readonly signature: string; readonly about: string }
	| { readonly kind: "value"; readonly suggestion: Suggestion }
	/** The `did you mean` row, with what the fixed line would do. */
	| { readonly kind: "fix"; readonly line: string; readonly will: string | null };

export interface Signature {
	readonly verb: string;
	readonly parts: readonly string[];
	/** The argument to underline. */
	readonly current: number | null;
}

export type BarBlock =
	| { readonly kind: "none" }
	/** Polite: read out as the line changes. */
	| { readonly kind: "preview"; readonly preview: Preview }
	| {
			readonly kind: "error";
			/** The line echoed, with `mark` in --down and carets under it. */
			readonly line: string;
			readonly mark: { readonly start: number; readonly end: number } | null;
			readonly sentence: string;
			readonly nothingChanged: boolean;
	  }
	| { readonly kind: "confirm"; readonly confirm: ConfirmText }
	| { readonly kind: "running"; readonly line: string }
	| {
			readonly kind: "result";
			readonly line: string;
			readonly header: string;
			readonly blocks: readonly ReportBlock[];
	  };

export interface BarView {
	readonly rows: readonly BarRow[];
	readonly chosen: number | null;
	readonly signature: Signature | null;
	readonly block: BarBlock;
	/** Always the next key and what it does. */
	readonly hint: string;
	readonly footer: readonly string[];
}

/** What Enter would do now. The hint says it; `enter` does it. */
type Next =
	| { readonly kind: "accept"; readonly row: number }
	| { readonly kind: "submit"; readonly line: string; readonly danger: string | null }
	| { readonly kind: "show-error"; readonly error: LineError }
	| { readonly kind: "take-fix"; readonly line: string }
	| { readonly kind: "approve"; readonly mode: Confirming; readonly word: string }
	/** What was asked no longer holds. */
	| { readonly kind: "ask-again"; readonly line: string }
	| { readonly kind: "run-again"; readonly line: string }
	| { readonly kind: "nothing"; readonly hint: string };

/** A line parsed and validated against the lab: it can run, or here is why not. */
type Checked = { readonly ok: true; readonly line: ParsedLine } | { readonly ok: false; readonly error: LineError };

function check(registry: Registry, line: string, lab: LabState): Checked {
	const parsed = parseLine(registry, line, lab);
	if (isLineError(parsed)) return { ok: false, error: parsed };
	const error = parsed.validate(lab);
	return error === null ? { ok: true, line: parsed } : { ok: false, error };
}

/** One reading of the bar against the lab: everything the view and the keys need. */
interface Reading {
	readonly rows: readonly BarRow[];
	readonly chosen: number | null;
	readonly completion: Completion | null;
	/** The text, or the line being confirmed, checked; null when there is nothing to check. */
	readonly checked: Checked | null;
	readonly next: Next;
}

/** `rm` asks before it removes: the word after ↵. */
function actionWord(parsed: ParsedLine, lab: LabState): string {
	if (!parsed.danger) return "run";
	const confirm = parsed.confirm(lab);
	return isLineError(confirm) ? "run" : confirm.actionLabel.split(" ")[0].toLowerCase();
}

/** Why a yes would not be to what was asked, or null when it would. */
function noLongerAsked(mode: Confirming, parsed: ParsedLine, lab: LabState): LineError | null {
	if (!parsed.danger) return null;
	const confirm = parsed.confirm(lab);
	return isLineError(confirm) ? confirm : changedSinceAsked(mode.asked, confirm);
}

function emptyRows(lab: LabState, registry: Registry): BarRow[] {
	const recent = selectRecent(lab).map(
		(entry): BarRow => ({ kind: "recent", line: entry.line, source: entry.source, at: entry.at }),
	);
	const verbs = registry.commands.map(
		(c): BarRow => ({
			kind: "verb",
			name: c.name,
			signature: c.signature.filter((part) => !part.startsWith("[")).join(" "),
			about: c.about,
		}),
	);
	return [...recent, ...verbs];
}

function willOf(checked: Checked, lab: LabState): Preview | null {
	if (!checked.ok) return null;
	const preview = checked.line.preview(lab);
	return isLineError(preview) ? null : preview;
}

function fixRow(fix: string, lab: LabState, registry: Registry): BarRow {
	return { kind: "fix", line: fix, will: willOf(check(registry, fix, lab), lab)?.will ?? null };
}

function clamp(chosen: number | null, fallback: number, rows: readonly BarRow[]): number | null {
	if (rows.length === 0) return null;
	return Math.min(Math.max(chosen ?? fallback, 0), rows.length - 1);
}

/** The text with a suggestion put in place of the token under the caret, and a space after it. */
function accepted(text: string, completion: Completion, suggestion: Suggestion): { text: string; caret: number } {
	const before = text.slice(0, completion.replace.start);
	const after = text.slice(completion.replace.end);
	const spaced = after.startsWith(" ") ? after : ` ${after}`;
	return { text: before + suggestion.insert + spaced, caret: before.length + suggestion.insert.length + 1 };
}

function read(bar: OpenBar, lab: LabState, registry: Registry): Reading {
	const { mode, text } = bar;
	switch (mode.kind) {
		case "error": {
			const rows = mode.error.fix === undefined ? [] : [fixRow(mode.error.fix, lab, registry)];
			const next: Next =
				mode.error.fix === undefined
					? { kind: "nothing", hint: "esc close" }
					: { kind: "take-fix", line: mode.error.fix };
			return { rows, chosen: clamp(bar.chosen, 0, rows), completion: null, checked: null, next };
		}
		case "confirm": {
			const checked = check(registry, mode.line, lab);
			const next: Next =
				checked.ok && noLongerAsked(mode, checked.line, lab) === null
					? { kind: "approve", mode, word: actionWord(checked.line, lab) }
					: { kind: "ask-again", line: mode.line };
			return { rows: [], chosen: null, completion: null, checked, next };
		}
		case "running":
			return {
				rows: [],
				chosen: null,
				completion: null,
				checked: null,
				next: { kind: "nothing", hint: "esc close" },
			};
		case "result":
			return {
				rows: [],
				chosen: null,
				completion: null,
				checked: null,
				next: { kind: "run-again", line: mode.line },
			};
		case "typing":
			break;
	}

	if (text.trim() === "") {
		const rows = emptyRows(lab, registry);
		const firstVerb = rows.findIndex((r) => r.kind === "verb");
		const chosen = clamp(bar.chosen, firstVerb, rows);
		const next: Next = chosen === null ? { kind: "nothing", hint: "esc close" } : { kind: "accept", row: chosen };
		return { rows, chosen, completion: null, checked: null, next };
	}

	const completion = completeLine(registry, text, bar.caret, lab);
	const rows = completion.suggestions.map((suggestion): BarRow => ({ kind: "value", suggestion }));
	const chosen = clamp(bar.chosen, 0, rows);
	const checked = check(registry, text, lab);
	return { rows, chosen, completion, checked, next: typingNext(text, rows, chosen, completion, checked, lab) };
}

/** Enter runs a complete, valid line; otherwise it takes a suggestion that changes something; otherwise it shows the error. */
function typingNext(
	text: string,
	rows: readonly BarRow[],
	chosen: number | null,
	completion: Completion,
	checked: Checked,
	lab: LabState,
): Next {
	if (checked.ok)
		return { kind: "submit", line: text, danger: checked.line.danger ? actionWord(checked.line, lab) : null };
	const typed = text.slice(completion.replace.start, completion.replace.end);
	const row = chosen === null ? undefined : rows[chosen];
	if (chosen !== null && row?.kind === "value" && row.suggestion.insert !== typed)
		return { kind: "accept", row: chosen };
	return { kind: "show-error", error: checked.error };
}

function hintOf(next: Next, rows: readonly BarRow[]): string {
	switch (next.kind) {
		case "accept": {
			const row = rows[next.row];
			const label = row.kind === "verb" ? row.name : row.kind === "value" ? row.suggestion.insert : row.line;
			return `tab → ${label}`;
		}
		case "submit":
			return `↵ ${next.danger ?? "run"}`;
		case "show-error":
			return "↵ check the line";
		case "take-fix":
			return "tab → fix it";
		case "approve":
			return `↵ again to ${next.word}`;
		case "ask-again":
			return "↵ ask again";
		case "run-again":
			return "↵ run again";
		case "nothing":
			return next.hint;
	}
}

function footerOf(mode: BarMode, next: Next): readonly string[] {
	switch (mode.kind) {
		case "typing":
			return ["tab complete", "↑↓ choose", "↵ run", "esc close"];
		case "error":
			return next.kind === "take-fix" ? ["tab take the fix", "↵ take it and run", "esc close"] : ["esc close"];
		case "confirm":
			return [`↵ ${next.kind === "approve" ? next.word : "ask again"}`, "esc keep it"];
		case "running":
			return ["esc close"];
		case "result":
			return ["↵ run again", "↑ edit the line", "esc close"];
	}
}

function errorBlock(text: string, error: LineError): BarBlock {
	const token = error.token === undefined ? undefined : tokenize(text).tokens[error.token];
	const suffix = ` ${NOTHING_CHANGED}`;
	const nothingChanged = error.message.endsWith(suffix);
	return {
		kind: "error",
		line: text,
		mark: token ? { start: token.start, end: token.end } : null,
		sentence: nothingChanged ? error.message.slice(0, -suffix.length) : error.message,
		nothingChanged,
	};
}

function previewBlock(checked: Checked, lab: LabState): BarBlock {
	const preview = willOf(checked, lab);
	return preview === null ? { kind: "none" } : { kind: "preview", preview };
}

function blockOf(bar: OpenBar, reading: Reading, lab: LabState, registry: Registry): BarBlock {
	const { mode } = bar;
	switch (mode.kind) {
		case "error":
			return errorBlock(bar.text, mode.error);
		case "confirm": {
			const checked = reading.checked ?? check(registry, mode.line, lab);
			if (!checked.ok) return errorBlock(mode.line, checked.error);
			const over = noLongerAsked(mode, checked.line, lab);
			return over ? errorBlock(mode.line, over) : { kind: "confirm", confirm: mode.asked };
		}
		case "running":
			return { kind: "running", line: mode.line };
		case "result":
			return { kind: "result", line: mode.line, header: mode.report.header, blocks: mode.report.blocks };
		case "typing": {
			if (reading.checked === null) return { kind: "none" };
			if (reading.checked.ok) return previewBlock(reading.checked, lab);
			// While a token is half typed, preview the line as the chosen suggestion would make it.
			const row = reading.chosen === null ? undefined : reading.rows[reading.chosen];
			if (row?.kind !== "value" || reading.completion === null) return { kind: "none" };
			return previewBlock(check(registry, accepted(bar.text, reading.completion, row.suggestion).text, lab), lab);
		}
	}
}

function signatureOf(bar: OpenBar, lab: LabState, registry: Registry): Signature | null {
	const { mode } = bar;
	if (mode.kind === "running" || mode.kind === "result") return null;
	const text = mode.kind === "confirm" ? mode.line : bar.text;
	const tokens = tokenize(text).tokens;
	const command = tokens[0] && registry.find(tokens[0].text);
	if (!command) return null;
	const errorToken = mode.kind === "error" && mode.error.token !== undefined ? tokens[mode.error.token] : undefined;
	const caret = errorToken ? errorToken.end : mode.kind === "confirm" ? text.length : bar.caret;
	return { verb: command.name, parts: command.signature, current: completeLine(registry, text, caret, lab).slot };
}

export function barView(bar: OpenBar, lab: LabState, registry: Registry): BarView {
	const reading = read(bar, lab, registry);
	return {
		rows: reading.rows,
		chosen: reading.chosen,
		signature: signatureOf(bar, lab, registry),
		block: blockOf(bar, reading, lab, registry),
		hint: hintOf(reading.next, reading.rows),
		footer: footerOf(bar.mode, reading.next),
	};
}

const TYPING: BarMode = { kind: "typing" };

function opened(runs: number, text = ""): OpenBar {
	return { open: true, text, caret: text.length, mode: TYPING, chosen: null, history: null, runs };
}

function typing(bar: OpenBar, text: string, caret = text.length): OpenBar {
	return { ...bar, text, caret, mode: TYPING, chosen: null, history: null };
}

function done(bar: BarState, ...effects: BarEffect[]): BarStep {
	return { bar, effects };
}

function close(bar: OpenBar, returnFocus: boolean): BarStep {
	const effects: BarEffect[] = [];
	if (bar.mode.kind === "running") effects.push({ type: "abort", run: bar.mode.run });
	effects.push({ type: "close" });
	if (returnFocus) effects.push({ type: "focus-return" });
	return { bar: { open: false, runs: bar.runs }, effects };
}

function run(
	bar: OpenBar,
	line: string,
	opts: { keepOpen: boolean; source?: "bar" | "button"; approval?: Approval },
): BarStep {
	const id = bar.runs + 1;
	const { keepOpen, source = "bar", approval = null } = opts;
	const next: OpenBar = {
		...bar,
		...(keepOpen ? { text: "", caret: 0 } : {}),
		mode: { kind: "running", run: id, line, keepOpen },
		chosen: null,
		history: null,
		runs: id,
	};
	return done(next, { type: "run", run: id, line, source, approval });
}

function askFirst(bar: OpenBar, line: DangerLine, lab: LabState): BarStep {
	const asked = line.confirm(lab);
	const mode: BarMode = isLineError(asked)
		? { kind: "error", error: asked }
		: { kind: "confirm", line: line.line, asked };
	return done({ ...bar, mode });
}

/** Enter on a line: run it, or confirm it when it is dangerous, or show why it cannot run. */
function submit(bar: OpenBar, line: string, keepOpen: boolean, lab: LabState, registry: Registry): BarStep {
	const checked = check(registry, line, lab);
	const at = { ...bar, text: line, caret: line.length };
	if (!checked.ok) return done({ ...at, mode: { kind: "error", error: checked.error } });
	return checked.line.danger ? askFirst(at, checked.line, lab) : run(at, line, { keepOpen });
}

/** The second Enter, or the action button. The run checks that the lab would still ask what was asked. */
function approve(
	bar: OpenBar,
	{ line, asked }: Confirming,
	keepOpen: boolean,
	lab: LabState,
	registry: Registry,
): BarStep {
	const checked = check(registry, line, lab);
	const at = { ...bar, text: line, caret: line.length };
	if (!checked.ok) return done({ ...at, mode: { kind: "error", error: checked.error } });
	return run(bar, line, { keepOpen, approval: grantApproval(line, asked) });
}

function accept(bar: OpenBar, reading: Reading, row: number): BarStep {
	const chosen = reading.rows[row];
	if (!chosen) return done(bar, { type: "pass" });
	switch (chosen.kind) {
		case "verb":
			return done(typing(bar, `${chosen.name} `));
		case "recent":
		case "fix":
			return done(typing(bar, chosen.line));
		case "value": {
			if (reading.completion === null) return done(bar);
			const next = accepted(bar.text, reading.completion, chosen.suggestion);
			return done(typing(bar, next.text, next.caret));
		}
	}
}

function move(bar: OpenBar, reading: Reading, by: 1 | -1): BarStep {
	if (reading.chosen === null) return done(bar, { type: "pass" });
	const count = reading.rows.length;
	return done({ ...bar, chosen: (reading.chosen + by + count) % count });
}

function focusLine(bar: OpenBar, target: string): BarStep {
	return run(bar, `focus ${target}`, { keepOpen: false, source: "button" });
}

function enter(bar: OpenBar, keepOpen: boolean, lab: LabState, registry: Registry): BarStep {
	const reading = read(bar, lab, registry);
	const { next } = reading;
	switch (next.kind) {
		case "accept":
			return accept(bar, reading, next.row);
		case "submit":
			return submit(bar, next.line, keepOpen, lab, registry);
		case "show-error":
			return done({ ...bar, mode: { kind: "error", error: next.error }, chosen: null });
		case "take-fix":
			return submit(typing(bar, next.line), next.line, keepOpen, lab, registry);
		case "approve":
			return approve(bar, next.mode, keepOpen, lab, registry);
		case "ask-again":
		case "run-again":
			return submit(bar, next.line, keepOpen, lab, registry);
		case "nothing":
			return done(bar);
	}
}

function settled(bar: OpenBar, id: number, result: Result | LineError): BarStep {
	if (bar.mode.kind !== "running" || bar.mode.run !== id) return done(bar);
	const { line, keepOpen } = bar.mode;
	if (isLineError(result))
		return done({ ...bar, text: line, caret: line.length, mode: { kind: "error", error: result } });
	switch (result.kind) {
		case "visible":
			return keepOpen ? done({ ...bar, mode: TYPING }) : close({ ...bar, mode: TYPING }, true);
		case "report":
			return done({ ...bar, text: line, caret: line.length, mode: { kind: "result", line, report: result } });
		case "failed":
			return done({ ...bar, text: line, caret: line.length, mode: { kind: "error", error: result.error } });
	}
}

function up(bar: OpenBar, lab: LabState, registry: Registry): BarStep {
	if (bar.mode.kind === "result") return done(typing(bar, bar.mode.line));
	if (bar.mode.kind !== "typing") return done(bar);
	const history = selectBarHistory(lab);
	if (bar.history !== null || bar.text === "") {
		const back = bar.history === null ? 0 : Math.min(bar.history + 1, history.length - 1);
		const line = history[back];
		return line === undefined ? done(bar) : done({ ...typing(bar, line), history: back });
	}
	return move(bar, read(bar, lab, registry), -1);
}

function down(bar: OpenBar, lab: LabState, registry: Registry): BarStep {
	if (bar.mode.kind !== "typing") return done(bar);
	if (bar.history !== null) {
		if (bar.history === 0) return done(typing(bar, ""));
		const back = bar.history - 1;
		return done({ ...typing(bar, selectBarHistory(lab)[back] ?? ""), history: back });
	}
	return move(bar, read(bar, lab, registry), 1);
}

/**
 * One input, one transition. `lab` is the state now; the bar parses against
 * it and never keeps a copy, so what it shows cannot go stale.
 */
export function barStep(bar: BarState, input: BarInput, lab: LabState, registry: Registry): BarStep {
	if (!bar.open) {
		switch (input.kind) {
			case "open":
				return done(opened(bar.runs));
			case "open-confirming":
				return submitConfirming(opened(bar.runs, input.line), lab, registry);
			default:
				return done(bar, { type: "pass" });
		}
	}

	switch (input.kind) {
		case "open":
			return done(bar);
		case "open-confirming":
			return submitConfirming(typing(bar, input.line), lab, registry);
		case "edit":
			if (input.text === bar.text) return done({ ...bar, caret: input.caret, chosen: null });
			return done(typing(bar, input.text, input.caret));
		case "tab": {
			const reading = read(bar, lab, registry);
			if (reading.next.kind === "take-fix") return done(typing(bar, reading.next.line));
			if (bar.mode.kind !== "typing" || reading.chosen === null) return done(bar, { type: "pass" });
			return accept(bar, reading, reading.chosen);
		}
		case "shift-tab":
			return done(bar, { type: "pass" });
		case "up":
			return up(bar, lab, registry);
		case "down":
			return down(bar, lab, registry);
		case "enter":
			return enter(bar, input.keepOpen, lab, registry);
		case "escape":
			return bar.mode.kind === "confirm" ? done({ ...bar, mode: TYPING }) : close(bar, true);
		case "dismiss":
			return close(bar, false);
		case "digit": {
			if (bar.mode.kind !== "typing" || bar.text !== "") return done(bar, { type: "pass" });
			const machine = lab.rail[input.digit - 1];
			const life = machine === undefined ? undefined : lab.machines[machine]?.life;
			return machine === undefined || !life || life.phase === "removing" ? done(bar) : focusLine(bar, machine);
		}
		case "choose": {
			const reading = read(bar, lab, registry);
			const row = reading.rows[input.row];
			if (!row) return done(bar);
			if (row.kind === "fix") return done(typing(bar, row.line));
			return accept({ ...bar, chosen: input.row }, reading, input.row);
		}
		case "approve":
			return bar.mode.kind === "confirm" ? approve(bar, bar.mode, false, lab, registry) : done(bar);
		case "keep":
			return bar.mode.kind === "confirm" ? done({ ...bar, mode: TYPING }) : done(bar);
		case "open-console":
			return focusLine(bar, input.session);
		case "ran":
			return settled(bar, input.run, input.result);
	}
}

/** A button's dangerous line opens straight onto its confirmation; it never runs from here. */
function submitConfirming(bar: OpenBar, lab: LabState, registry: Registry): BarStep {
	const checked = check(registry, bar.text, lab);
	if (!checked.ok) return done({ ...bar, mode: { kind: "error", error: checked.error } });
	return checked.line.danger ? askFirst(bar, checked.line, lab) : done(bar);
}
