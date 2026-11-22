// src/model/* — the pure lab. No DOM, no Worker, no timers, no Date.now().
// Everything here runs under `node --test` with no setup.
//
// One function changes state: update(state, event) -> { state, effects }.
// Time enters only as event fields (`at`) and `tick` events, so the boot
// timeout, the boot counter, "agent active" and "seen 1 s ago" are all pure.

// ───────────────────────────── identity ─────────────────────────────

/** Names are ids. Monotonic and never reused in a lab, so `node4` means one machine for the lab's lifetime. */
export type MachineName = `node${number}`;
/** The address the user types, and the id everything else uses: `node2:console`, `node2:sh1`. Also never reused. */
export type SessionId = `${MachineName}:console` | `${MachineName}:sh${number}`;
export type PortNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type HueNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const PORTS: readonly PortNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const HUES: readonly HueNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const MAX_MACHINES = 8;

/**
 * node<n> is 10.88.0.(10+n) with MAC labMac(10+n). Arithmetic, not a table:
 * because names are never reused, any frame's MAC or IP names its machine
 * forever, including machines already removed (capture history stays right).
 */
export interface Identity {
	readonly n: number;
	readonly name: MachineName;
	readonly ip: string;
	readonly mac: string;
}
export function identity(n: number): Identity {
	throw new Error("not implemented"); // name `node${n}`, ip subnet.host(10 + n), mac labMac(10 + n)
}
/** Inverse of identity() over raw frame bytes; null for anything the lab cannot name (shown raw). */
export function nameForMac(bytes: Uint8Array, offset: number): MachineName | null {
	throw new Error("not implemented");
}
export function nameForIp(ip: number): MachineName | null {
	throw new Error("not implemented");
}

// ───────────────────────────── machines ─────────────────────────────

export type Source = "bar" | "button" | "agent";
/** Who caused something the lab reports in words (capture event rows, announcements). */
export type Cause = Source | "runtime";

export type Plug =
	| { readonly kind: "none" }
	| { readonly kind: "port"; readonly port: PortNo; readonly link: "up" | "cut" };

export interface MachineSpec {
	readonly image: string;
	readonly memMiB: number;
	/** What the user asked for at spawn; boot again honours it. */
	readonly net: "switch0" | "none";
}

/**
 * The lifecycle is the type. A failed machine has no `plug` field, so it
 * cannot hold a port; a removing machine holds its port (link already down)
 * until it is gone, so nobody else can take it mid-teardown.
 */
export type Lifecycle =
	| { readonly phase: "booting"; readonly attempt: number; readonly since: number; readonly stage: string; readonly plug: Plug }
	| { readonly phase: "ready"; readonly attempt: number; readonly bootMs: number; readonly plug: Plug }
	| { readonly phase: "failed"; readonly attempt: number; readonly reason: string }
	| { readonly phase: "removing"; readonly attempt: number; readonly port: PortNo | null };

export type Machine = Identity &
	Lifecycle & {
		readonly hue: HueNo;
		readonly spec: MachineSpec;
		/** Tab order. Console first, always present. */
		readonly sessions: readonly SessionId[];
		readonly activeSession: SessionId;
		/** Next shell number; sh<k> is never reused on this machine. */
		readonly nextShell: number;
	};

export interface Session {
	readonly id: SessionId;
	readonly machine: MachineName;
	readonly kind: "console" | "shell";
	readonly state: "opening" | "open";
	/** From the shell tracker (OSC 133). `running` refuses exec. `unknown` until the first prompt mark. */
	readonly shell: "prompt" | "running" | "unknown";
	/** Some lines in this session carry the blue rule; drives the pane legend. */
	readonly agentLines: boolean;
}

// ───────────────────────────── panes ─────────────────────────────

export type ParkReason = "auto" | "user";

export interface Panes {
	/** Tiling order. New machines go to the end; `focus --main` moves one to the front. */
	readonly order: readonly MachineName[];
	/** Absent means visible. */
	readonly parked: Readonly<Partial<Record<MachineName, ParkReason>>>;
	/** Focus stamps from a monotonic counter, not wall time, so LRU is deterministic in tests. */
	readonly focusStamp: Readonly<Partial<Record<MachineName, number>>>;
	readonly focusClock: number;
	/** Present while one pane is maximised: the exact parking it will restore. */
	readonly maximised: { readonly machine: MachineName; readonly before: Panes["parked"] } | null;
	/** From the pane area's size: cols = clamp(floor(w/400),1,3), rows = clamp(floor(h/200),1,2). */
	readonly grid: { readonly cols: 1 | 2 | 3; readonly rows: 1 | 2 };
}

// ───────────────────────────── the rest of the state ─────────────────────────────

export type Keyboard =
	| { readonly kind: "pane"; readonly machine: MachineName }
	| { readonly kind: "bar"; readonly returnTo: MachineName | null }
	| { readonly kind: "none" };

export interface CaptureUi {
	/** Source text as typed; the compiled predicate is derived (selectCaptureFilter, memoised). */
	readonly filter: string;
	readonly paused: boolean;
	/** Wire selection, by capture seq. */
	readonly selected: number | null;
}

export type Policy = "run" | "ask" | "off";
export type ToolName =
	| "machines_list" | "machines_spawn" | "machines_remove" | "shell_exec" | "shell_read" | "link_set" | "capture_read";

export interface AgentCall {
	readonly id: number;
	readonly tool: ToolName;
	/** The call in bar grammar: `rm node3`. Shown in the panel, in `recent`, and in the log. */
	readonly line: string;
	readonly status: "running" | "waiting" | "done" | "denied" | "failed" | "aborted";
	/** For waiting calls: the command's own preview and the action-named button label (`Remove node3`). */
	readonly preview: string | null;
	readonly actionLabel: string | null;
	readonly result: string | null;
	readonly at: number;
}

export interface AgentState {
	readonly policies: Readonly<Record<ToolName, Policy>>;
	readonly paused: boolean;
	readonly calls: readonly AgentCall[];
	readonly firstCallAt: number | null;
	readonly lastCallAt: number | null;
}

export interface LogEntry {
	readonly line: string;
	readonly source: Source;
	readonly at: number;
	readonly outcome: "ok" | "failed";
}

export interface LabState {
	/** ms since the lab started; advanced only by `tick` and stamped events. */
	readonly now: number;
	/** The n of the next machine. Only goes up. */
	readonly nextN: number;
	readonly machines: Readonly<Partial<Record<MachineName, Machine>>>;
	/** Rail order = spawn order. ⌘K then a digit indexes this. */
	readonly rail: readonly MachineName[];
	readonly sessions: Readonly<Partial<Record<SessionId, Session>>>;
	readonly panes: Panes;
	readonly keyboard: Keyboard;
	readonly view: "lab" | "wire" | "spawn";
	readonly agentPanel: boolean;
	readonly capture: CaptureUi;
	readonly agent: AgentState;
	/** Bounded (last 200). `recent` and bar history are selectors over it. */
	readonly log: readonly LogEntry[];
	readonly images: readonly string[];
}

// ───────────────────────────── events: one union, three producers ─────────────────────────────

/** Only the engine dispatches these (runtime/engine.ts). Attempt-stamped: a stale worker's message is ignored. */
export type RuntimeEvent =
	| { type: "vm/stage"; machine: MachineName; attempt: number; stage: string }
	| { type: "vm/ready"; machine: MachineName; attempt: number; bootMs: number }
	| { type: "vm/failed"; machine: MachineName; attempt: number; reason: string }
	| { type: "vm/stopped"; machine: MachineName; attempt: number }
	| { type: "session/opened"; session: SessionId }
	| { type: "session/ended"; session: SessionId }
	| { type: "session/shell"; session: SessionId; shell: "prompt" | "running" }
	| { type: "session/marked"; session: SessionId; source: "bar" | "agent" }
	| { type: "tick"; now: number };

/** Only command `execute` functions dispatch these (commands/verbs/*). Plans are computed by model functions. */
export type CommandEvent =
	| { type: "cmd/spawn"; plan: SpawnPlan; at: number }
	| { type: "cmd/remove"; machines: readonly MachineName[]; cause: Cause; at: number }
	| { type: "cmd/boot-again"; machine: MachineName; at: number }
	| { type: "cmd/link"; changes: readonly LinkChange[]; cause: Cause }
	| { type: "cmd/shell"; machine: MachineName }
	| { type: "cmd/focus"; target: MachineName | SessionId; mode: "plain" | "main" | "max" }
	| { type: "cmd/capture"; filter: string }
	| { type: "cmd/logged"; entry: LogEntry };

/** The only events elements may dispatch (app.ui(e)). None of them touches machines, ports or links. */
export type UiEvent =
	| { type: "ui/pane-focused"; machine: MachineName } // DOM focus already moved; record it
	| { type: "ui/tab-selected"; session: SessionId }
	| { type: "ui/park"; machine: MachineName }
	| { type: "ui/unpark"; machine: MachineName }
	| { type: "ui/area-resized"; width: number; height: number }
	| { type: "ui/view"; view: LabState["view"] }
	| { type: "ui/agent-panel"; open: boolean }
	| { type: "ui/bar"; open: boolean }
	| { type: "ui/capture-filter"; filter: string }
	| { type: "ui/capture-pause"; paused: boolean }
	| { type: "ui/capture-clear" }
	| { type: "ui/frame-selected"; seq: number | null }
	| { type: "ui/policy"; tool: ToolName; policy: Policy }
	| { type: "ui/tools-paused"; paused: boolean };

/** Only agent/ dispatches these. */
export type AgentEvent =
	| { type: "agent/call"; call: AgentCall }
	| { type: "agent/settled"; id: number; status: AgentCall["status"]; result: string | null };

export type LabEvent = RuntimeEvent | CommandEvent | UiEvent | AgentEvent;

// ───────────────────────────── effects: what the shell must do ─────────────────────────────

export interface BootConfig {
	readonly identity: Identity;
	readonly spec: MachineSpec;
	readonly hosts: readonly { ip: string; name: string }[];
}

export type Effect =
	| { type: "vm/boot"; machine: MachineName; attempt: number; config: BootConfig }
	| { type: "vm/stop"; machine: MachineName; attempt: number } // stop, terminate after 250 ms, then vm/stopped
	| { type: "port/attach"; port: PortNo; machine: MachineName }
	| { type: "port/detach"; port: PortNo }
	| { type: "link/set"; port: PortNo; machine: MachineName; up: boolean; cause: Cause } // switch + capture event row
	| { type: "pty/open"; session: SessionId }
	| { type: "pty/close"; session: SessionId }
	| { type: "screen/create"; session: SessionId }
	| { type: "screen/dispose"; session: SessionId }
	| { type: "screen/focus"; session: SessionId }
	| { type: "hosts/publish"; hosts: readonly { ip: string; name: string }[] }
	| { type: "capture/clear" }
	| { type: "announce"; text: string } // the one polite live region
	| { type: "clock"; hz: 1 | 10 }; // 10 while anything boots (the counter shows tenths), else 1

export interface Step {
	readonly state: LabState;
	readonly effects: readonly Effect[];
}

/**
 * The reducer. A switch over event.type delegating to the slice functions
 * below; after any event that changes membership or capacity it runs
 * reconcilePanes. Unknown attempts and unknown names are no-ops, so a
 * duplicated or late runtime event is harmless (idempotent by construction).
 */
export function update(state: LabState, event: LabEvent): Step {
	throw new Error("not implemented");
}

export function initialState(images: readonly string[], area: { width: number; height: number }): LabState {
	throw new Error("not implemented");
}

// ───────────────────────────── plans: shared by validate, preview and update ─────────────────────────────

/**
 * What a spawn will do, decided once. The command's preview describes this
 * object, the reducer applies this object; so the words in the bar and in an
 * agent approval are, by construction, what happens.
 */
export interface SpawnPlan {
	readonly machines: readonly { readonly identity: Identity; readonly hue: HueNo; readonly port: PortNo | null }[];
	readonly spec: MachineSpec;
}
export interface LinkChange {
	readonly machine: MachineName;
	readonly up: boolean;
	/** `link up` on an unplugged machine takes the lowest free port; this is it. */
	readonly port: PortNo;
	readonly newPort: boolean;
}

export type PlanError =
	| { kind: "no-ports"; free: number; wanted: number } // "switch0 has 2 free ports. Add --no-net to boot them unplugged."
	| { kind: "no-hues"; free: number; wanted: number }
	| { kind: "no-addresses" }
	| { kind: "unknown-machine"; name: string; token: number };

export function planSpawn(state: LabState, count: number, spec: MachineSpec): SpawnPlan | PlanError {
	throw new Error("not implemented"); // names from nextN, hues firstFree in order, ports lowestFree in order
}
export function planLink(state: LabState, machines: readonly MachineName[], up: boolean): readonly LinkChange[] | PlanError {
	throw new Error("not implemented");
}

// ───────────────────────────── allocation (derived, never stored) ─────────────────────────────

/** Ports held by booting/ready (plug.kind === 'port') and removing machines. */
export function takenPorts(state: LabState): ReadonlySet<PortNo> {
	throw new Error("not implemented");
}
export function lowestFreePorts(state: LabState, k: number): readonly PortNo[] {
	throw new Error("not implemented");
}
/** Every machine in state holds its hue, whatever its phase; a hue frees when the record is deleted. */
export function firstFreeHues(state: LabState, k: number): readonly HueNo[] {
	throw new Error("not implemented");
}

// ───────────────────────────── lifecycle (one table, tested exhaustively) ─────────────────────────────

/**
 *   booting --vm/ready(attempt)--> ready            effects: announce `node4 ready`, hosts/publish
 *   booting --vm/failed|timeout--> failed           effects: vm/stop, port/detach, announce
 *   ready   --vm/failed(fatal)/exit--> failed       (guest powered off counts; reason verbatim)
 *   failed  --cmd/boot-again-->     booting(attempt+1, lowest free port if spec.net)
 *   booting|ready|failed --cmd/remove--> removing   effects: link/set down (event row first), vm/stop
 *   removing --vm/stopped-->        (deleted)       effects: port/detach, screen/dispose×n, hosts/publish
 *
 * Boot timeout: on `tick`, any booting machine with now - since > BOOT_TIMEOUT_MS fails with
 * "No prompt after 120 s." No timer effect exists; a stale timeout cannot fire on a later attempt.
 */
export const BOOT_TIMEOUT_MS = 120_000;

// ───────────────────────────── panes (pure; property-tested) ─────────────────────────────

export const capacity = (p: Panes): number => (p.maximised ? 1 : p.grid.cols * p.grid.rows);
export function visiblePanes(p: Panes): readonly MachineName[] {
	throw new Error("not implemented"); // order filtered by !parked
}
/**
 * The invariant keeper, run after every pane-affecting event:
 *   1. visible ≤ capacity: park the visible pane with the oldest focus stamp, reason 'auto'.
 *   2. room left: unpark 'auto' panes, newest focus stamp first. 'user' panes stay parked.
 * Never reorders `order`. Idempotent: reconcile(reconcile(p)) === reconcile(p).
 */
export function reconcilePanes(p: Panes): Panes {
	throw new Error("not implemented");
}
export function addPane(p: Panes, m: MachineName): Panes {
	throw new Error("not implemented");
}
export function removePane(p: Panes, m: MachineName): Panes {
	throw new Error("not implemented");
}
/** Stamps focus. A parked pane comes back first; if there is no room, the oldest-focused other pane parks (auto) in exchange. Never reorders. */
export function focusPane(p: Panes, m: MachineName): Panes {
	throw new Error("not implemented");
}
export function parkPane(p: Panes, m: MachineName, reason: ParkReason): Panes {
	throw new Error("not implemented");
}
export function promotePane(p: Panes, m: MachineName): Panes {
	throw new Error("not implemented");
}
/** Maximise parks every other pane (auto) and remembers `parked`; again restores exactly, minus removed machines, plus machines added meanwhile (then reconcile). */
export function toggleMaximise(p: Panes, m: MachineName): Panes {
	throw new Error("not implemented");
}
export function resizeArea(p: Panes, width: number, height: number): Panes {
	throw new Error("not implemented");
}

/** CSS grid placement for the visible panes. 6-column track so 3-across and 2-across rows share one grid. */
export interface Tiling {
	readonly columns: string; // e.g. '3fr 2fr' for the three-pane main+stack
	readonly rows: string;
	readonly tiles: readonly { readonly machine: MachineName; readonly area: string }[]; // grid-area values
}
export function tile(visible: readonly MachineName[], grid: Panes["grid"]): Tiling {
	throw new Error("not implemented"); // table-driven: 1, 2, 3 (main + stack, 3:2), 4, 5 (3 then 2), 6; rows===1 lays across
}

// ───────────────────────────── selectors (memoised; elements read only these) ─────────────────────────────

export interface RailRow {
	readonly name: MachineName;
	readonly hue: HueNo;
	readonly phase: Lifecycle["phase"];
	/** `booting 1.4 s`, `did not boot`, `10.88.0.12 · parked` */
	readonly line2: string;
	/** `up`, `cut`, `unplugged`, `booting`, `failed` — state always has a word. */
	readonly word: string;
	readonly focused: boolean;
	readonly parked: boolean;
}
export interface PortView {
	readonly port: PortNo;
	readonly state: "empty" | "booting" | "up" | "cut";
	readonly machine: { name: MachineName; hue: HueNo } | null;
	/** "Cut the cable from node1 to port 1" — the accessible name is the click's action. */
	readonly actionLabel: string | null;
}
export interface StatusSegment {
	readonly text: string;
	readonly tone: "quiet" | "down" | "warn";
}

export declare const selectRail: (s: LabState) => readonly RailRow[];
export declare const selectPorts: (s: LabState) => readonly PortView[];
export declare const selectTiling: (s: LabState) => Tiling;
export declare const selectParkedChips: (s: LabState) => readonly MachineName[];
export declare const selectStatus: (s: LabState) => { left: readonly StatusSegment[]; right: readonly StatusSegment[] };
export declare const selectAgentIndicator: (s: LabState) => "no agent calls yet" | "agent active" | "agent idle";
/** Last three lines run from the bar or by the agent (buttons excluded, so clicks do not crowd it). */
export declare const selectRecent: (s: LabState) => readonly LogEntry[];
export declare const selectBarHistory: (s: LabState) => readonly string[];

// ───────────────────────────── store (model/store.ts) ─────────────────────────────

export interface ReadStore {
	readonly state: LabState;
	/** Synchronous notification after each committed event. Lit batches renders per microtask on its own. */
	subscribe(fn: () => void): () => void;
	/** Resolve when pred(state) holds (checked on every commit); rejects on abort. Used by run() to wait for "effect visible". */
	until(pred: (s: LabState) => boolean, signal: AbortSignal): Promise<LabState>;
}

/** Each producer gets a dispatch narrowed to its own events; the type system is the "elements never change state" rule. */
export interface Store extends ReadStore {
	dispatchRuntime(e: RuntimeEvent): void;
	dispatchCommand(e: CommandEvent): void;
	dispatchUi(e: UiEvent): void;
	dispatchAgent(e: AgentEvent): void;
}

/**
 * Re-entrancy: an effect handler that dispatches (the engine reporting
 * vm/stopped synchronously in a test fake) is queued and processed after the
 * current step's effects, FIFO, so effect order equals event order.
 */
export function createStore(initial: LabState, runEffect: (e: Effect) => void): Store {
	throw new Error("not implemented");
}
