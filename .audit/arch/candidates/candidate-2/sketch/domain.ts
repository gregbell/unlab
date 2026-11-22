// src/domain/* — the lab as data. Pure: no DOM, no Worker, no Date.now().
// Every function here is a pure function of its arguments, tested with
// node --test and nothing else. Time enters only through events (`at`, `tick`).

// ───────────────────────── identity ─────────────────────────

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `node<n>`; n monotonic per lab, never reused. Also the switch port id. */
export type MachineName = Brand<string, 'MachineName'>;
/** `node2:console`, `node2:sh1`. Parsed once at the edge. */
export type SessionId = Brand<string, 'SessionId'>;
export type Hue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type PortNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const HUES: readonly Hue[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const PORTS: readonly PortNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
/** The design's limit: one machine per hue. Open question in HANDOFF. */
export const MAX_MACHINES = 8;

export type Source = 'bar' | 'button' | 'agent';
/** Who caused a link change; `system` covers removal and failure. */
export type Cause = Source | 'system';

// ───────────────────────── machines ─────────────────────────

/**
 * Lifecycle as a discriminated union: a field that only exists in one phase
 * lives only in that phase, so `reason` on a ready machine does not compile.
 * `attempt` increments on every boot; runtime events carry it, and the reducer
 * drops any event whose attempt is stale (a dead worker's late message).
 */
export type Lifecycle =
  | { readonly phase: 'booting'; readonly attempt: number; readonly startedAt: number; readonly stage: string }
  | { readonly phase: 'ready'; readonly attempt: number; readonly bootMs: number }
  | { readonly phase: 'failed'; readonly attempt: number; readonly reason: string }
  | { readonly phase: 'removing'; readonly attempt: number; readonly by: Cause };

export type Phase = Lifecycle['phase'];

/**
 * What the machine wants (`wantsNet`) is separate from what it has (`port`).
 * A failed machine keeps wantsNet=true with port=null ("cable withdrawn,
 * port freed"); boot again re-takes the lowest free port. A cut cable keeps
 * its port. `--no-net` is wantsNet=false, port=null ("unplugged").
 */
export interface NetAttachment {
  readonly wantsNet: boolean;
  readonly port: PortNo | null;
  readonly cable: 'up' | 'cut';
  /** Who last changed the cable, for `Cable to node3 cut by the agent.` */
  readonly cableBy: Cause;
}

export interface Shell {
  readonly id: SessionId;
  /** `console`, `sh1`, `sh2`…; never reused per machine. */
  readonly label: string;
  readonly state: 'opening' | 'open';
}

export interface Machine {
  readonly name: MachineName;
  /** n in node<n>; address 10.88.0.(10+n), MAC labMac(10+n). */
  readonly n: number;
  readonly hue: Hue;
  readonly image: string;
  readonly memMiB: number;
  readonly ip: string;
  readonly mac: string;
  readonly life: Lifecycle;
  readonly net: NetAttachment;
  /** console first, always present. Closed shells are removed, not flagged. */
  readonly sessions: readonly Shell[];
  readonly activeSession: SessionId;
  readonly nextShell: number;
}

// ───────────────────────── panes ─────────────────────────

export type ParkReason = 'auto' | 'user';

/**
 * Pane layout is fully determined by this record plus capacity. No DOM
 * measurement leaks in except `area`, written by one ResizeObserver event.
 * Invariant (enforced by `settle`, checked by a property test):
 *   visible(p).length <= capacity(area) and every order entry is a machine.
 */
export interface PaneState {
  /** All machines in pane order. Rail order is creation order, not this. */
  readonly order: readonly MachineName[];
  readonly parked: ReadonlyMap<MachineName, ParkReason>;
  /** Focus generation per machine; larger = focused more recently. */
  readonly focusedAt: ReadonlyMap<MachineName, number>;
  readonly focusGen: number;
  /** Set while maximised: the parked map to restore, exactly. */
  readonly maximised: { readonly pane: MachineName; readonly restore: ReadonlyMap<MachineName, ParkReason> } | null;
  readonly area: { readonly width: number; readonly height: number };
}

export interface Capacity { readonly cols: 1 | 2 | 3; readonly rows: 1 | 2; readonly total: number }

/** cols = min(3, floor(w/400)) (at least 1), rows = min(2, floor(h/200)) (at least 1). */
export function capacity(area: PaneState['area']): Capacity { throw new Error('not implemented'); }
export function visible(p: PaneState): MachineName[] { throw new Error('not implemented'); }

/**
 * The one rebalancing rule, run by the reducer after every pane-affecting
 * event. Idempotent: settle(settle(p)) === settle(p).
 *  - over capacity: park auto the visible pane with the smallest focusedAt
 *    (never the focused one) until it fits;
 *  - under capacity: un-park auto-parked panes, most recently focused first;
 *  - user-parked panes are never touched.
 */
export function settle(p: PaneState, focused: MachineName | null): PaneState { throw new Error('not implemented'); }
export function parkByUser(p: PaneState, m: MachineName): PaneState { throw new Error('not implemented'); }
/** Chip click / focus of a parked machine: unpark it, then settle evicts the oldest-focused other. */
export function bringBack(p: PaneState, m: MachineName): PaneState { throw new Error('not implemented'); }
export function promote(p: PaneState, m: MachineName): PaneState { throw new Error('not implemented'); }
/** Snapshot `parked`, then park every other pane as auto. Toggle: maximise twice = restore. */
export function toggleMaximise(p: PaneState, m: MachineName): PaneState { throw new Error('not implemented'); }

/** CSS grid placement for the visible panes; the 3-pane case is 3:2 main + stack. */
export interface Tile { readonly pane: MachineName; readonly col: string; readonly row: string }
export function tile(names: readonly MachineName[], cap: Capacity): { template: { cols: string; rows: string }; tiles: Tile[] } {
  throw new Error('not implemented');
}

// ───────────────────────── focus, views ─────────────────────────

export type View = 'lab' | 'wire' | 'spawn';

/** Exactly one thing has the keyboard. */
export type Focus =
  | { readonly kind: 'pane'; readonly machine: MachineName }
  | { readonly kind: 'bar'; readonly returnTo: MachineName | null }
  | { readonly kind: 'none' };

// ───────────────────────── command log, agent ─────────────────────────

export interface LogEntry {
  readonly id: number;
  readonly source: Source;
  /** The call in bar grammar, rendered by `command.format(args)`, so agent calls read like typed lines. */
  readonly line: string;
  readonly at: number;
  readonly outcome: { readonly status: 'running' } | { readonly status: 'ok'; readonly summary: string } | { readonly status: 'failed'; readonly message: string };
}

export type Policy = 'run' | 'ask' | 'off';

export interface PendingCall {
  readonly id: number;
  readonly tool: string;
  readonly line: string;
  /** The command's own preview() text, verbatim. */
  readonly preview: string;
  /** `Remove node3`, from command.actionLabel(args). */
  readonly actionLabel: string;
}

export interface AgentState {
  readonly policies: ReadonlyMap<string, Policy>;
  readonly paused: boolean;
  readonly firstCallAt: number | null;
  readonly lastCallAt: number | null;
  /** Oldest first; never time out on their own. */
  readonly pending: readonly PendingCall[];
  readonly calls: readonly { readonly id: number; readonly line: string; readonly result: string | null }[];
  readonly nextCall: number;
}

// ───────────────────────── the whole state ─────────────────────────

/**
 * The control-plane state. Immutable; replaced by `reduce`. It deliberately
 * does NOT contain frame bytes or terminal bytes: those live in the store's
 * append-only lanes (see store.ts), referenced here only by revision numbers
 * that bump at most once per flush. That is what keeps per-frame cost O(1).
 */
export interface LabState {
  readonly now: number;
  readonly startedAt: number;
  readonly images: readonly string[];
  /** Insertion order = creation order = rail order and the 1..8 quick-focus order. */
  readonly machines: ReadonlyMap<MachineName, Machine>;
  readonly nextNode: number;
  readonly panes: PaneState;
  readonly focus: Focus;
  readonly view: View;
  readonly agentPanel: boolean;
  readonly capture: { readonly filter: string; readonly paused: boolean; readonly selected: number | null };
  readonly log: readonly LogEntry[];
  readonly nextLog: number;
  readonly agent: AgentState;
  /** Lane revisions; components select these to re-read a lane. */
  readonly lanes: { readonly capture: number; readonly switch: number; readonly sessions: number };
}

export const BOOT_TIMEOUT_MS = 60_000; // open question: HANDOFF "Boot timeout"

// ───────────────────────── allocation (shared by preview and reducer) ─────────────────────────

export interface SpawnPlan {
  readonly machines: readonly { name: MachineName; n: number; hue: Hue; port: PortNo | null; ip: string; mac: string }[];
  readonly image: string;
  readonly memMiB: number;
}

/**
 * The single allocator. `spawn.preview` and the reducer both call it, so the
 * preview names and ports are exactly what the spawn takes. Returns a reason
 * sentence instead of a plan when hues or ports run out.
 */
export function planSpawn(s: LabState, count: number, image: string, memMiB: number, net: boolean): SpawnPlan | { readonly short: 'hues' | 'ports'; readonly free: number } {
  throw new Error('not implemented');
}
export function firstFreeHue(s: LabState): Hue | null { throw new Error('not implemented'); }
export function lowestFreePort(s: LabState): PortNo | null { throw new Error('not implemented'); }

// ───────────────────────── events: the only way state changes ─────────────────────────

/** Intent events: dispatched by command `run`s and by UI-local actions (focus clicks, resize). */
export type IntentEvent =
  | { type: 'spawn'; plan: SpawnPlan; source: Source }
  | { type: 'boot-again'; machine: MachineName; source: Source }
  | { type: 'remove'; machines: readonly MachineName[]; source: Source }
  | { type: 'cable'; machines: readonly MachineName[]; cable: 'up' | 'cut'; source: Source }
  | { type: 'shell-open'; machine: MachineName; id: SessionId }
  | { type: 'tab'; session: SessionId }
  | { type: 'focus'; target: Focus }
  | { type: 'park'; machine: MachineName }
  | { type: 'bring-back'; machine: MachineName }
  | { type: 'promote'; machine: MachineName }
  | { type: 'maximise'; machine: MachineName }
  | { type: 'pane-area'; width: number; height: number }
  | { type: 'view'; view: View }
  | { type: 'agent-panel'; open: boolean }
  | { type: 'capture'; filter?: string; paused?: boolean; selected?: number | null }
  | { type: 'log-start'; entry: Omit<LogEntry, 'outcome' | 'id'> }
  | { type: 'log-end'; id: number; outcome: LogEntry['outcome'] }
  | { type: 'agent-call'; line: string; at: number }
  | { type: 'agent-pending'; call: Omit<PendingCall, 'id'> }
  | { type: 'agent-settled'; id: number; result: string }
  | { type: 'agent-policy'; tool: string; policy: Policy }
  | { type: 'agent-paused'; paused: boolean };

/** Observation events: dispatched only by runtime/driver.ts. All carry `attempt`. */
export type RuntimeEvent =
  | { type: 'rt-stage'; machine: MachineName; attempt: number; stage: string }
  | { type: 'rt-ready'; machine: MachineName; attempt: number; bootMs: number }
  | { type: 'rt-failed'; machine: MachineName; attempt: number; reason: string }
  | { type: 'rt-gone'; machine: MachineName; attempt: number }
  | { type: 'rt-shell-ready'; session: SessionId }
  | { type: 'rt-shell-exit'; session: SessionId };

export type LabEvent = IntentEvent | RuntimeEvent | { type: 'tick'; now: number } | { type: 'lanes'; lanes: Partial<LabState['lanes']> };

/**
 * The one writer of LabState. Total over (state, event): an event that does
 * not apply (stale attempt, unknown machine, rm of a removing machine) returns
 * `s` unchanged — that is what makes every command and runtime message
 * idempotent. After each pane-affecting event it calls `settle`. `tick` fails
 * any booting machine whose startedAt + BOOT_TIMEOUT_MS <= now: the boot
 * timeout is a pure rule, not a setTimeout.
 */
export function reduce(s: LabState, e: LabEvent): LabState { throw new Error('not implemented'); }

export function initialState(opts: { images: readonly string[]; now: number }): LabState { throw new Error('not implemented'); }

// ───────────────────────── targets ─────────────────────────

export interface Resolved {
  readonly machines: readonly Machine[];
  /** `skipped node4: still booting` */
  readonly skipped: readonly { readonly name: MachineName; readonly reason: string }[];
}
/** `node2`, `node1,node3`, `node*`, `all`. Globs and `all` expand to ready only; named non-ready machines are skipped with a reason. */
export function resolveTargets(expr: string, s: LabState, accept: (m: Machine) => string | null): Resolved | { readonly unknown: string } {
  throw new Error('not implemented');
}
