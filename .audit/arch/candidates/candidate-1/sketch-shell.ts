// src/terminal/** : one terminal engine per SESSION (not per pane element).
// src/agent/**    : WebMCP adapter, policies, approvals.
// src/ui/**       : Lit elements in light DOM, one stylesheet.
// src/app.ts      : the composition root; the only file that imports every layer.

import type { AgentEvent, Event, MachineName, Policy, ReadStore, SessionId, Source, State, Store, TerminalEvent, UiEvent } from "./sketch-domain.ts";
import type { CaptureLog, LabRuntime, SessionPipe } from "./sketch-runtime-wire.ts";
import type { Commands, ConsolePort, LineError, Prepared, Result, VerbName, Verbs, Command } from "./sketch-commands.ts";

const NI = (): never => {
	throw new Error("not implemented");
};

// ───────────────────────── terminal/terminals.ts ─────────────────────────

/** A run of rows the lab injected. Rows are absolute (0 = oldest retained row), resolved now. */
export interface MarkView {
	source: Source;
	fromRow: number;
	/** Open marks end at the cursor row. */
	toRow: number;
}

/**
 * One session's terminal for as long as the session lives: a host <div>, a WTerm on a
 * GhosttyCore, the marks, the prompt tracker. Parking, tab switches, view changes and
 * maximise only MOVE `element`; the grid, scrollback, selection and marks survive.
 */
export interface TerminalHost {
	readonly session: SessionId;
	/** Light-DOM node wterm renders into. `<unlab-terminal>` adopts it; otherwise it waits in the lot. */
	readonly element: HTMLElement;
	/** Move into `slot` (Element.moveBefore where available), resume painting, fit. */
	show(slot: HTMLElement): void;
	/** Back to the off-screen lot at its last size, painting paused, still parsing. No SIGWINCH. */
	hide(): void;
	focus(): void;
	/** Solid block when its pane has the keyboard, hollow otherwise. */
	setCursor(style: "solid" | "hollow"): void;
	/** Current marks, positions resolved through TrackedTerminalPosition; pruned ones are gone. */
	marks(): MarkView[];
	/** Fires when marks or their geometry may have changed (output, scroll, resize). rAF-coalesced. */
	onMarks(fn: () => void): () => void;
	readonly rowHeight: number;
}

/**
 * Deep module. Public surface: `host(id)` for the UI and `ConsolePort` for commands.
 * Hidden: compiling ghostty-vt.wasm once, one core per session, attaching the
 * SessionPipe, the off-screen lot, theme colours, OSC 133 prompt tracking, the sentinel
 * fallback when a shell prints no OSC 133, mark bookkeeping, and reading text back out
 * of the grid. Driven by the store: a host is created on `session/opened` and destroyed
 * on `session/closed`; nothing else creates or destroys terminals.
 *
 *   inject(line):
 *     start = core.trackPosition(cursor)            // before writing
 *     pipe.write(line + '\r'); mark = { start, end: null, source }
 *     await next prompt  (OSC 133;A — the guest's PS1 carries `133;D;$?` then `133;A`)
 *       or, if this session has never shown OSC 133: the line is sent as
 *       `<line>; printf '\033]133;D;%s\007' $?` and the same wait applies
 *     mark.end = core.trackPosition(row above the new prompt)
 *     resolve { exitCode, lastLine: text of mark.end row, output: text of the range }
 */
export interface Terminals extends ConsolePort {
	host(id: SessionId): TerminalHost | undefined;
}
export function createTerminals(_deps: {
	store: ReadStore;
	pipe: (id: SessionId) => SessionPipe;
	dispatch: (e: TerminalEvent) => void;
	lot: HTMLElement;
}): Terminals {
	return NI();
}

// ───────────────────────── agent/webmcp.ts ─────────────────────────

/** The slice of the WebMCP draft we use. Parsed at the boundary; never leaves agent/. */
interface ModelContext {
	registerTool(
		tool: { name: string; description: string; inputSchema: object; annotations?: object; execute(input: unknown, opts: { signal: AbortSignal }): Promise<unknown> },
		opts: { signal: AbortSignal },
	): void;
}
/** `document.modelContext`, else `navigator.modelContext`, else null (then the agent layer does nothing). */
export function findModelContext(_doc: Document, _nav: Navigator): ModelContext | null {
	return NI();
}

/**
 * The UI's handle on the gate. Everything else (the tool list, the call log, what is
 * waiting) is read from `state.agent`.
 */
export interface AgentGate {
	/** `off` aborts that tool's registration signal; `run`/`ask` re-registers it. */
	setPolicy(tool: string, policy: Policy): void;
	/** Paused: every registration aborted; resume re-registers per policy. */
	setPaused(paused: boolean): void;
	/** Allow or Deny for a waiting call. A second answer, or an answer to a settled call, is a no-op. */
	answer(n: number, allow: boolean): void;
}

/**
 * Tools are derived from `commands.verbs`: every verb with a `tool` face becomes one
 * registration. There is no separate tool table.
 *
 *   execute(input, { signal }):
 *     raw = tool.input.parse(input)                       → on error: return its sentence
 *     p   = commands.prepare(verb, raw, 'agent')          → on error: return its sentence
 *     dispatch agent/called { n, line: p.line, preview: p.preview, action: p.action,
 *                             status: policy === 'ask' ? 'waiting' : 'running' }
 *     if policy === 'ask': await the answer; signal abort → agent/settled 'aborted'
 *                          (block disappears); Deny → return 'Denied by the user.'
 *     r = await commands.execute(p, signal)               // re-validates
 *     dispatch agent/settled; return tool.output(r)
 *   and a 5-minute timer, reset per call, that dispatches agent/idled.
 */
export function createAgentGate(_deps: { commands: Commands; store: ReadStore; dispatch: (e: AgentEvent) => void; context: ModelContext | null }): AgentGate {
	return NI();
}

// ───────────────────────── ui/context.ts ─────────────────────────

type RawFor<N extends VerbName> = Verbs[N] extends Command<any, infer R> ? R : never;

/**
 * Everything an element can reach. No runtime, no reducer, no `Store.dispatch(Event)`:
 * an element cannot fabricate `machine/ready`, and cannot touch a worker.
 */
export interface App {
	readonly store: ReadStore;
	/** State-only intents: views, tabs, parking, selection, capture pause. */
	dispatch(e: UiEvent): void;
	/**
	 * What every button calls. Prepares with source 'button'; runs at once unless the
	 * command is dangerous or the line is in error, in which case the bar opens on that
	 * line, confirming or explaining. So a human confirmation exists in one place.
	 */
	act<N extends VerbName>(verb: N, raw: RawFor<N>): void;
	readonly commands: Pick<Commands, "analyse" | "prepareLine" | "execute" | "verbs">;
	readonly agent: AgentGate;
	readonly terminals: Pick<Terminals, "host">;
	readonly capture: Pick<CaptureLog, "row" | "info" | "view" | "pcap" | "clear">;
}

/**
 * Lit ReactiveController. `value` is the selected slice; the host re-renders when it
 * changes and unsubscribes on disconnect. The only way an element reads state.
 */
export class Select<T> {
	value!: T;
	constructor(_host: UnlabElement, _selector: (s: State) => T, _equal?: (a: T, b: T) => boolean) {}
}

/**
 * Base for all `<unlab-*>` elements: a LitElement whose render root is itself (light
 * DOM), with `app` resolved once from the nearest provider via a `context-request`
 * event. Reactive properties are declared with `static properties` and `declare`
 * fields; no decorators anywhere.
 */
export declare class UnlabElement extends HTMLElement {
	protected readonly app: App;
	requestUpdate(): void;
}

// ───────────────────────── ui/terminal.ts: the mount, in full ─────────────────────────

/**
 *   <unlab-terminal session="node2:sh1" focused></unlab-terminal>
 *
 * Renders two children: `.gutter` (the 14px strip that holds mark rules) and `.slot`
 * (where the host element goes). It owns no terminal state.
 *
 *   connected / `session` changed:  app.terminals.host(session).show(this.slot)
 *   disconnected / session changed: previous host.hide()
 *   host.onMarks → for each MarkView: a rule at
 *       top = fromRow * rowHeight - host.element.scrollTop
 *       height = (toRow - fromRow + 1) * rowHeight
 *     2px wide, `--text-3` for bar and button, `--agent` for agent; clipped to the body.
 */
export declare class UnlabTerminal extends UnlabElement {
	session: SessionId;
	focused: boolean;
}

// ───────────────────────── ui/keys.ts, ui/focus.ts ─────────────────────────

/** Capture-phase window listener: ⌘K (mac) / Ctrl+/ (elsewhere) opens the bar before any terminal sees the key. */
export function installOpenShortcut(_win: Window, _dispatch: (e: UiEvent) => void): () => void {
	return NI();
}
/**
 * The only caller of `.focus()` on terminals and the bar input. Keyboard ownership is
 * derived from state (`ui.bar.open ? bar : panes.focused's active tab`), so "closing the
 * bar returns focus to the pane that had it" needs no saved element.
 */
export function installFocusDirector(_app: App, _root: HTMLElement): () => void {
	return NI();
}

// ───────────────────────── app.ts ─────────────────────────

export interface AppParts {
	app: App;
	store: Store;
	runtime: LabRuntime;
	/** Tear everything down (tests, HMR). */
	dispose(): void;
}

/**
 * Wiring, and only wiring:
 *
 *   store    = createStore(initialState(...))
 *   capture  = new CaptureLog({ paused: () => store.state.net.capture.paused,
 *                               frame: requestAnimationFrame, onTick: store.dispatch, ... })
 *   runtime  = new LabRuntime({ onEvent: store.dispatch, onWire: (i) => capture.push(i), ... })
 *   terms    = createTerminals({ store, pipe: (id) => runtime.session(id), dispatch: store.dispatch, lot })
 *   commands = createCommands({ store, lab: runtime, consoles: terms, capture, dispatch: store.dispatch, now })
 *   agent    = createAgentGate({ commands, store, dispatch: store.dispatch, context: findModelContext(...) })
 */
export function createApp(_opts: { root: HTMLElement; manifest: unknown; spawnWorker: ConstructorParameters<typeof LabRuntime>[0]["spawnWorker"] }): AppParts {
	return NI();
}

// Compile-time proof that the layers meet: these lines are the design's seams.
declare const parts: AppParts;
declare const name: MachineName;
export function callSites(): void {
	// a button
	parts.app.act("link", { state: "down", machines: { is: "names", names: [name] } });
	// a rail row click
	parts.app.dispatch({ type: "panes/focused", name });
	// the bar, on Enter
	const p: Prepared | LineError = parts.app.commands.prepareLine("rm node3", "bar");
	if (!("message" in p)) void parts.app.commands.execute(p).then((r: Result) => r.is);
	// an element reading a slice
	const unsubscribe = parts.app.store.select(
		(s) => s.machines[name],
		(m) => void m?.phase.is,
	);
	unsubscribe();
	// the runtime cannot be reached from `app`, and `app.dispatch` rejects runtime facts:
	// @ts-expect-error elements cannot fabricate lifecycle events
	parts.app.dispatch({ type: "machine/ready", name, bootMs: 1 });
	const all: (e: Event) => void = parts.store.dispatch;
	void all;
}
