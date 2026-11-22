// src/domain/** : pure data and pure functions. No DOM, no Worker, no timers, no imports
// from any other layer. Everything here runs under `vitest --project unit` in Node.
//
// Files this sketch stands for:
//   domain/ids.ts  domain/state.ts  domain/events.ts  domain/reduce.ts  domain/store.ts
//   domain/panes.ts  domain/select.ts  domain/announce.ts  domain/fixtures.ts

const NI = (): never => {
	throw new Error("not implemented");
};

// ───────────────────────────── ids.ts ─────────────────────────────

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * `node3`. The name IS the identity: the spec makes names monotonic, never reused and
 * not renamable, so a second opaque id would only add a map to keep in sync.
 * Minted only by the runtime (`LabRuntime.spawn`); parsed from user text only by
 * `pinTargets` in commands/grammar.ts.
 */
export type MachineName = Brand<string, "MachineName">;
/** `node3:console` | `node3:sh1`. The bar's session address, verbatim. */
export type SessionId = Brand<string, "SessionId">;
export type PortNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type Hue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const PORTS: readonly PortNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const HUES: readonly Hue[] = [1, 2, 3, 4, 5, 6, 7, 8];

export type Source = "bar" | "button" | "agent";
/** Who changed a link. `lab` is the runtime itself (boot, removal, failure). */
export type Cause = Source | "lab";

// ───────────────────────────── state.ts ─────────────────────────────

export interface MachineSpec {
	image: string;
	memMiB: number;
	/** false = `--no-net`. Survives a failure, so Boot again knows whether to take a port. */
	net: boolean;
}

/** The lifecycle, as data. Fields that only exist in one state live only in that state. */
export type Phase =
	| { is: "booting"; since: number; stage: string }
	| { is: "ready"; bootMs: number }
	| { is: "failed"; reason: string }
	| { is: "removing" };

export interface Machine {
	readonly name: MachineName;
	/** The 3 in node3. Address and MAC derive from it. */
	readonly n: number;
	/** Assigned by the reducer at `machine/spawned`: first hue not in use. Kept across Boot again. */
	readonly hue: Hue;
	readonly spec: MachineSpec;
	readonly ip: string;
	readonly mac: string;
	readonly phase: Phase;
	/** null = unplugged (--no-net) or withdrawn (failed). A booting machine holds its port reserved. */
	readonly port: PortNo | null;
	/** Only meaningful with a port. Kept while cut, per the spec. */
	readonly cut: boolean;
	/** Tab order. sessions[0] is always the console. */
	readonly sessions: readonly SessionId[];
	readonly activeTab: SessionId;
}

/** A machine the type system knows is ready. The only thing `exec`, `sh`, `link` accept. */
export type ReadyMachine = Machine & { phase: { is: "ready" } };

export interface Session {
	readonly id: SessionId;
	readonly machine: MachineName;
	/** `console`, `sh1`, `sh2`… numbered by the runtime, never reused. */
	readonly label: string;
	readonly opening: boolean;
	/** From OSC 133, reported by terminal/. `busy` makes `exec` refuse. */
	readonly activity: "prompt" | "busy" | "unknown";
	/** Live line marks per source; drives the pane's agent legend. Rows live in terminal/. */
	readonly marks: { readonly bar: number; readonly agent: number };
}

export interface Panes {
	/** Every machine that has a pane, in pane order. Visible = order minus parked. */
	readonly order: readonly MachineName[];
	readonly parked: Readonly<Record<MachineName, "auto" | "user">>;
	/** Larger = touched more recently. Stamped on focus and on add. */
	readonly touched: Readonly<Record<MachineName, number>>;
	readonly clock: number;
	readonly focused: MachineName | null;
	/** The parking to put back, exactly, when maximise is toggled off. */
	readonly maximised: { readonly name: MachineName; readonly restore: Panes["parked"] } | null;
	readonly capacity: { readonly cols: 1 | 2 | 3; readonly rows: 1 | 2 };
}

export interface MacEntry {
	mac: string;
	port: PortNo;
	machine: MachineName | null;
	/** Lab time (ms) the switch last saw it. */
	seenT: number;
	/** Kept, struck through, until relearned or the machine is removed. */
	flushed: boolean;
}

export interface WireTotals {
	in: number;
	delivered: number;
	flooded: number;
}

/**
 * The store's handle on the capture ring. The rows are NOT here: they live in
 * wire/CaptureLog. A component selects `head`/`rev` (changes at most once per animation
 * frame) and then pulls the rows it shows from the log.
 */
export interface CaptureIndex {
	/** seq of the oldest retained row, and one past the newest. */
	readonly first: number;
	readonly head: number;
	/** Bumped when retained rows change in place (annotation added, clear). */
	readonly rev: number;
	readonly paused: boolean;
	/** The text as typed. `filterError` is set when it does not parse; the list then keeps the last good filter. */
	readonly filter: string;
	readonly filterError: string | null;
	readonly selected: number | null;
}

export type Policy = "run" | "ask" | "off";

export interface LogEntry {
	readonly id: number;
	readonly at: number;
	/** Canonical bar grammar, whatever the source: `link down node3`. */
	readonly line: string;
	readonly source: Source;
	readonly outcome: { is: "running" } | { is: "done"; summary: string } | { is: "failed"; message: string };
}

export interface AgentCall {
	/** The number shown in the panel: `8 · waiting for you`. */
	readonly n: number;
	readonly tool: string;
	readonly line: string;
	readonly status: "waiting" | "running" | "done" | "denied" | "aborted" | "rejected";
	/** For a waiting call: the command's own preview and action label. */
	readonly preview: string;
	readonly action: string;
	readonly danger: boolean;
	readonly result: string | null;
}

export interface State {
	readonly lab: { readonly name: string; readonly subnet: string; readonly images: readonly string[]; readonly startedAt: number };
	readonly machines: Readonly<Record<MachineName, Machine>>;
	/** Rail order (creation order). Digits 1-8 in the bar index this. */
	readonly rail: readonly MachineName[];
	readonly sessions: Readonly<Record<SessionId, Session>>;
	readonly panes: Panes;
	readonly net: {
		readonly capture: CaptureIndex;
		readonly mac: readonly MacEntry[];
		readonly totals: WireTotals;
		readonly frames: Readonly<Partial<Record<PortNo, { rx: number; tx: number }>>>;
	};
	readonly log: readonly LogEntry[];
	readonly agent: {
		readonly available: boolean;
		readonly paused: boolean;
		readonly active: boolean;
		readonly firstCallAt: number | null;
		readonly policies: Readonly<Record<string, Policy>>;
		readonly calls: readonly AgentCall[];
	};
	readonly ui: {
		readonly view: "lab" | "wire" | "spawn";
		readonly agentPanel: boolean;
		/** `seed` lets a button open the bar on a line (e.g. Remove → `rm node3`, already confirming). */
		readonly bar: { readonly open: boolean; readonly seed: { line: string; source: Source } | null };
		/** One polite live region reads this. seq makes repeats announce. */
		readonly announcement: { readonly seq: number; readonly text: string } | null;
	};
}

// ───────────────────────────── events.ts ─────────────────────────────
// The ONLY way state changes. Four families, one per writer; a writer can only
// construct its own family (its dispatch function is typed to it).

/** Facts from runtime/. Emitted synchronously as the runtime mutates the world. */
export type RuntimeEvent =
	| { type: "machine/spawned"; name: MachineName; n: number; spec: MachineSpec; ip: string; mac: string; port: PortNo | null; at: number }
	| { type: "machine/stage"; name: MachineName; stage: string }
	| { type: "machine/ready"; name: MachineName; bootMs: number }
	| { type: "machine/failed"; name: MachineName; reason: string }
	| { type: "machine/rebooting"; name: MachineName; port: PortNo | null; at: number }
	| { type: "machine/removing"; name: MachineName }
	| { type: "machine/gone"; name: MachineName }
	| { type: "link/plugged"; name: MachineName; port: PortNo; cause: Cause }
	| { type: "link/changed"; name: MachineName; port: PortNo; up: boolean; cause: Cause }
	| { type: "session/opened"; id: SessionId; machine: MachineName; label: string }
	| { type: "session/ready"; id: SessionId }
	| { type: "session/closed"; id: SessionId };

/** From wire/CaptureLog, at most once per animation frame however many frames crossed. */
export type WireEvent = {
	type: "wire/tick";
	first: number;
	head: number;
	rev: number;
	totals: WireTotals;
	mac: readonly MacEntry[];
	frames: State["net"]["frames"];
};

/** From terminal/. Low rate: once per prompt, once per mark. */
export type TerminalEvent =
	| { type: "session/activity"; id: SessionId; activity: Session["activity"] }
	| { type: "session/marks"; id: SessionId; bar: number; agent: number };

/** From commands/ (the log) and agent/ (the gate). */
export type CommandEvent =
	| { type: "command/started"; id: number; at: number; line: string; source: Source }
	| { type: "command/finished"; id: number; outcome: LogEntry["outcome"] };
export type AgentEvent =
	| { type: "agent/available"; tools: readonly { name: string; policy: Policy }[] }
	| { type: "agent/called"; call: AgentCall; at: number }
	| { type: "agent/settled"; n: number; status: AgentCall["status"]; result: string | null }
	| { type: "agent/policy"; tool: string; policy: Policy }
	| { type: "agent/paused"; paused: boolean }
	| { type: "agent/idled" };

/** Everything an element (or a state-only command: focus, capture) may dispatch. */
export type UiEvent =
	| { type: "ui/view"; view: State["ui"]["view"] }
	| { type: "ui/agent-panel"; open: boolean }
	| { type: "bar/opened"; seed?: { line: string; source: Source } }
	| { type: "bar/closed" }
	| { type: "panes/focused"; name: MachineName; main?: boolean; max?: boolean }
	| { type: "panes/tab"; id: SessionId }
	| { type: "panes/parked"; name: MachineName }
	| { type: "panes/unparked"; name: MachineName }
	| { type: "panes/maximise-toggled"; name: MachineName }
	| { type: "panes/capacity"; cols: 1 | 2 | 3; rows: 1 | 2 }
	| { type: "capture/filter"; text: string; error: string | null }
	| { type: "capture/paused"; paused: boolean }
	| { type: "capture/selected"; seq: number | null };

export type Event = RuntimeEvent | WireEvent | TerminalEvent | CommandEvent | AgentEvent | UiEvent;

// ───────────────────────────── reduce.ts ─────────────────────────────

export function initialState(lab: State["lab"]): State {
	return NI();
}

/**
 * Total and pure. An event that does not apply (ready for a machine already gone,
 * removing twice) returns the same state object: every transition is idempotent, so a
 * late worker message can never corrupt the lab.
 *
 *   machine/spawned   → add Machine{phase: booting, hue: firstFreeHue(state)}, console
 *                       session, pane at end of order; settle(panes)
 *   machine/ready     → booting → ready            (ignored unless booting)
 *   machine/failed    → booting|ready → failed, port: null, cut: false
 *   machine/rebooting → failed → booting, same hue/spec/name, the port the runtime took
 *   machine/removing  → ready|failed|booting → removing
 *   machine/gone      → delete machine, its sessions, its pane; settle(panes); frees the hue
 *   …and after every event: `announcement = announce(event, next) ?? prev`.
 */
export function reduce(state: State, event: Event): State {
	return NI();
}

/** Lifecycle as a table, so the state diagram in the handoff is one test. null = not allowed. */
export function nextPhase(from: Phase["is"], event: RuntimeEvent["type"]): Phase["is"] | "gone" | null {
	return NI();
}

export function firstFreeHue(machines: State["machines"]): Hue | null {
	return NI();
}

/** `node4 ready`, `Cable to node3 cut`, `1 call waiting for you`. null = say nothing. */
export function announce(event: Event, next: State): string | null {
	return NI();
}

// ───────────────────────────── store.ts ─────────────────────────────

export interface ReadStore {
	readonly state: State;
	/**
	 * Calls `listener` synchronously after a dispatch whenever `selector`'s value changed
	 * (by `equal`, default Object.is). The reducer shares structure, so selecting a slice
	 * (`s => s.machines[name]`) is a pointer compare. No listener ever runs per frame:
	 * frames reach state only as `wire/tick`.
	 */
	select<T>(selector: (s: State) => T, listener: (value: T, state: State) => void, equal?: (a: T, b: T) => boolean): () => void;
}

export interface Store extends ReadStore {
	/** Reduces immediately; `state` is current when this returns. A dispatch made from a listener is queued, never nested. */
	dispatch(event: Event): void;
}

export function createStore(initial: State): Store {
	return NI();
}

// ───────────────────────────── panes.ts ─────────────────────────────
// Every tiling rule in the handoff is one of these pure functions. The reducer calls
// them; nothing else moves a pane.

/** cols = floor(width / 400) clamped 1..3; rows = height >= 400 ? 2 : 1. */
export function capacityFor(width: number, height: number): Panes["capacity"] {
	return NI();
}

export function visible(p: Panes): readonly MachineName[] {
	return NI();
}

/**
 * Restore the invariants, and nothing else:
 *   while visible > capacity: park (auto) the visible pane touched longest ago, never `keep`
 *   while visible < capacity and auto-parked exist: bring back the most recently touched
 * User-parked panes are never touched. settle(settle(p)) === settle(p). While maximised,
 * capacity is 1 and `keep` is the maximised pane.
 */
export function settle(p: Panes, keep?: MachineName): Panes {
	return NI();
}

export function addPane(p: Panes, name: MachineName): Panes {
	return NI();
}
export function removePane(p: Panes, name: MachineName): Panes {
	return NI();
}
/** Stamps `touched`, sets `focused`; brings a parked pane back first. Never reorders visible panes. */
export function focusPane(p: Panes, name: MachineName): Panes {
	return NI();
}
export function parkPane(p: Panes, name: MachineName): Panes {
	return NI();
}
export function unparkPane(p: Panes, name: MachineName): Panes {
	return NI();
}
/** `focus --main`: move to the front of `order`. */
export function promotePane(p: Panes, name: MachineName): Panes {
	return NI();
}
/** On: remember `parked`, park the rest (auto). Off: put `restore` back, then settle. */
export function toggleMaximise(p: Panes, name: MachineName): Panes {
	return NI();
}

/** The six layouts of the tiling table as CSS grid data; `<unlab-pane-area>` only applies it. */
export interface Tiling {
	columns: string;
	rows: string;
	/** Grid area per visible pane, in order. */
	areas: readonly string[];
}
export function tiling(visibleCount: number, cols: 1 | 2 | 3): Tiling {
	return NI();
}

// ───────────────────────────── select.ts ─────────────────────────────
// Derived, never stored. Each is a table test.

export type PortView =
	| { port: PortNo; is: "empty" }
	| { port: PortNo; is: "boot" | "up" | "cut"; machine: MachineName; hue: Hue; /** aria-label, e.g. "Cut the cable from node1 to port 1" */ action: string | null };
export function portViews(s: State): readonly PortView[] {
	return NI();
}
export function linkWord(m: Machine): "up" | "cut" | "unplugged" | "booting" | "failed" {
	return NI();
}
export function readyMachines(s: State): readonly ReadyMachine[] {
	return NI();
}
export function freePorts(s: State): readonly PortNo[] {
	return NI();
}
export interface StatusSegment {
	text: string;
	tone: "quiet" | "down" | "warn";
}
export function statusLine(s: State): { left: StatusSegment[]; right: StatusSegment[] } {
	return NI();
}
/** `agent active` | `no agent calls yet` | `paused` | `1 call waiting for you`. */
export function agentWording(s: State): StatusSegment {
	return NI();
}

// ───────────────────────────── fixtures.ts (test + gallery only) ─────────────────────────────

/** Builds a State by replaying events through `reduce`, so a fixture cannot be an impossible state. */
export function labFrom(...events: Event[]): State {
	return NI();
}
