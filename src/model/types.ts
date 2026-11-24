// The lab as plain data. Nothing here touches the DOM, a worker, a timer or a
// clock: time arrives only as `tick` events and `at` stamps.

import type { Address, NicName, NicNo } from "../net/index.ts";

export type { Address, NicName, NicNo };

// ───────────────────────────── identity ─────────────────────────────

/** Names are ids. `n` only goes up, so `node4` means one machine for the lab's lifetime. */
export type MachineName = `node${number}`;
/** What the user types and what everything else keys by. Never reused on a machine. */
export type SessionId = `${MachineName}:console` | `${MachineName}:sh${number}`;
export type PortNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type HueNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const PORTS: readonly PortNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const HUES: readonly HueNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const MAX_MACHINES = 8;
export const SWITCH_NAME = "switch0";

/** node<n> has a MAC for each NIC, all arithmetic, so any frame names its machine forever. */
export interface Identity {
	readonly n: number;
	readonly name: MachineName;
	/** eth0's. */
	readonly mac: string;
}

/** One NIC of one machine. NIC 0 is eth0. */
export interface NicRef {
	readonly machine: MachineName;
	readonly nic: NicNo;
}

// ───────────────────────────── machines ─────────────────────────────

export type Source = "bar" | "button" | "agent";
/** Who caused something the lab reports in words: capture event rows, announcements. */
export type Cause = Source | "runtime";

export type Plug =
	| { readonly kind: "none" }
	| { readonly kind: "port"; readonly port: PortNo; readonly link: "up" | "cut" };

/** A port for each NIC, eth0 first, or null for one that is not plugged in. */
export type NicPorts = readonly (PortNo | null)[];

export interface ImageInfo {
	/** The manifest name, used in the grammar: `alpine`. */
	readonly name: string;
	/** For display: `alpine 3.24`. */
	readonly label: string;
}

export const DISK_SIZES = ["4", "8", "16", "32", "64"] as const;
export type DiskSize = (typeof DISK_SIZES)[number];

export interface NicSpec {
	readonly net: "switch0" | "none";
	/** What the lab sets on it at every boot. Null leaves it up with none. */
	readonly address: Address | null;
}

interface Hardware {
	readonly diskGiB?: DiskSize;
	readonly cpus?: number;
	readonly image: string;
	readonly memMiB: number;
	/** Whether eth0 reaches the package gateway. */
	readonly gateway: boolean;
}

/** What a machine is, decided at spawn. Boot again honours it. */
export interface MachineSpec extends Hardware {
	/** One to MAX_NICS of them, eth0 first. */
	readonly nics: readonly NicSpec[];
}

/** A NIC as a spawn asks for it. */
export interface NicRequest {
	readonly net: NicSpec["net"];
	/** `default` is 10.88.0.(10+n)/24, which differs for each machine. */
	readonly address: Address | null | "default";
}

/** What a spawn asks of every machine it boots. */
export interface SpawnRequest extends Hardware {
	readonly nics: readonly NicRequest[];
}

/**
 * The lifecycle is the type. A failed machine has no plugs, so it cannot hold
 * a port. A removing machine keeps its ports (links already down) until it is
 * gone, so nobody can take them mid-teardown. `plugs` and `ports` have one for
 * each NIC, eth0 first. `attempt` stamps every runtime
 * event, so a late message from a replaced worker is ignored.
 */
export type Lifecycle =
	| {
			readonly phase: "booting";
			readonly attempt: number;
			readonly since: number;
			readonly stage: string;
			readonly plugs: readonly Plug[];
	  }
	| { readonly phase: "ready"; readonly attempt: number; readonly bootMs: number; readonly plugs: readonly Plug[] }
	| { readonly phase: "failed"; readonly attempt: number; readonly reason: string }
	| { readonly phase: "removing"; readonly attempt: number; readonly ports: NicPorts };

export type Phase = Lifecycle["phase"];

export type Machine = Identity & {
	readonly life: Lifecycle;
	readonly hue: HueNo;
	readonly spec: MachineSpec;
	/** Tab order. The console is first and always present. */
	readonly sessions: readonly SessionId[];
	readonly activeSession: SessionId;
	/** The next shell number; sh<k> is never reused on this machine. */
	readonly nextShell: number;
};

export interface Session {
	readonly id: SessionId;
	readonly machine: MachineName;
	readonly kind: "console" | "shell";
	readonly state: "opening" | "open";
	/** From the OSC 133 tracker. `running` refuses exec. `unknown` until the first prompt mark. */
	readonly shell: "prompt" | "running" | "unknown";
	/** Some lines here carry the blue rule; drives the pane's agent legend. */
	readonly agentLines: boolean;
}

// ───────────────────────────── panes ─────────────────────────────

export type ParkReason = "auto" | "user";
export type PanesParked = Readonly<Partial<Record<MachineName, ParkReason>>>;

export interface Panes {
	/** Tiling order. New machines go to the end; `focus --main` moves one to the front. */
	readonly order: readonly MachineName[];
	/** Absent means visible. */
	readonly parked: PanesParked;
	/** Stamps from a monotonic counter, so least-recently-focused is deterministic. */
	readonly focusStamp: Readonly<Partial<Record<MachineName, number>>>;
	readonly focusClock: number;
	/** While one pane is maximised: the exact parking to restore. */
	readonly maximised: { readonly machine: MachineName; readonly before: PanesParked } | null;
	/** cols = clamp(floor(w / 400), 1, 3); rows = clamp(floor(h / 200), 1, 2). */
	readonly grid: { readonly cols: 1 | 2 | 3; readonly rows: 1 | 2 };
}

// ───────────────────────────── the rest of the state ─────────────────────────────

/** Exactly one thing has the keyboard. */
export type Keyboard =
	| { readonly kind: "pane"; readonly machine: MachineName }
	| { readonly kind: "bar"; readonly returnTo: MachineName | null }
	| { readonly kind: "none" };

export interface CaptureUi {
	/** As typed. The compiled predicate is derived and memoised. */
	readonly filter: string;
	readonly paused: boolean;
	/** The Wire selection, by capture seq. */
	readonly selected: number | null;
}

export type Policy = "run" | "ask" | "off";
export type ToolName =
	| "machines_list"
	| "machines_spawn"
	| "machines_remove"
	| "shell_exec"
	| "shell_read"
	| "link_set"
	| "capture_read";

export interface AgentCall {
	readonly id: number;
	readonly tool: ToolName;
	/** The call in bar grammar: `rm node3`. */
	readonly line: string;
	readonly status: "running" | "waiting" | "done" | "denied" | "failed" | "aborted";
	/** For waiting calls: the command's own preview and the action-named button label. */
	readonly preview: string | null;
	readonly actionLabel: string | null;
	readonly result: string | null;
	readonly at: number;
}

/** What the browser makes of the tools. Nothing can call in unless it took them. */
export type WebMcp =
	| { readonly kind: "absent" }
	| { readonly kind: "registered" }
	/** The browser has WebMCP and turned a tool down, in its own words. */
	| { readonly kind: "refused"; readonly message: string };

export interface AgentState {
	readonly webmcp: WebMcp;
	readonly policies: Readonly<Record<ToolName, Policy>>;
	readonly paused: boolean;
	readonly calls: readonly AgentCall[];
	readonly firstCallAt: number | null;
	readonly lastCallAt: number | null;
}

export interface LogEntry {
	readonly id: number;
	readonly line: string;
	readonly source: Source;
	readonly at: number;
	readonly outcome: "ok" | "failed";
}

export type View = "lab" | "wire" | "spawn";

/** The network dock under the panes: the capture and the switch, or one strip that sums them up. */
export type Dock = "open" | "collapsed";

export interface LabState {
	/** ms since the lab started; advanced by `tick` and stamped events. */
	readonly now: number;
	/** The n of the next machine. Only goes up. */
	readonly nextN: number;
	readonly machines: Readonly<Partial<Record<MachineName, Machine>>>;
	/** Rail order is spawn order. ⌘K then a digit indexes this. */
	readonly rail: readonly MachineName[];
	readonly sessions: Readonly<Partial<Record<SessionId, Session>>>;
	readonly panes: Panes;
	readonly keyboard: Keyboard;
	readonly view: View;
	readonly agentPanel: boolean;
	readonly dock: Dock;
	readonly capture: CaptureUi;
	readonly agent: AgentState;
	/** Bounded. `recent` and bar history are selectors over it. */
	readonly log: readonly LogEntry[];
	readonly nextLogId: number;
	readonly images: readonly ImageInfo[];
}

// ───────────────────────────── plans: shared by validate, preview and update ─────────────────────────────

/** What a spawn will do, decided once. The preview describes it; the reducer applies it. */
export interface SpawnPlan {
	readonly machines: readonly {
		readonly identity: Identity;
		readonly hue: HueNo;
		readonly ports: NicPorts;
		readonly spec: MachineSpec;
	}[];
	readonly request: SpawnRequest;
}

export interface LinkChange extends NicRef {
	readonly up: boolean;
	readonly port: PortNo;
	/** `link up` on an unplugged NIC takes the lowest free port. */
	readonly newPort: boolean;
}

export type PlanError =
	| { readonly kind: "no-ports"; readonly free: number; readonly wanted: number }
	| { readonly kind: "no-room"; readonly free: number; readonly wanted: number }
	| { readonly kind: "unknown-image"; readonly image: string }
	| { readonly kind: "address-taken"; readonly address: Address; readonly by: NicRef }
	/** Two of one machine's NICs would be in overlapping subnets. */
	| { readonly kind: "address-overlap"; readonly nics: readonly [NicNo, NicNo] }
	| { readonly kind: "address-gateway"; readonly address: Address; readonly subnet: Address };

// ───────────────────────────── events: one union, four producers ─────────────────────────────

/** Dispatched only by the runtime engine. Attempt-stamped. */
export type RuntimeEvent =
	| { readonly type: "vm/stage"; readonly machine: MachineName; readonly attempt: number; readonly stage: string }
	| { readonly type: "vm/ready"; readonly machine: MachineName; readonly attempt: number; readonly bootMs: number }
	| { readonly type: "vm/failed"; readonly machine: MachineName; readonly attempt: number; readonly reason: string }
	| { readonly type: "vm/stopped"; readonly machine: MachineName; readonly attempt: number }
	| { readonly type: "session/opened"; readonly session: SessionId }
	| { readonly type: "session/ended"; readonly session: SessionId }
	| { readonly type: "session/shell"; readonly session: SessionId; readonly shell: "prompt" | "running" }
	| { readonly type: "session/marked"; readonly session: SessionId; readonly source: "bar" | "agent" }
	| { readonly type: "tick"; readonly now: number };

/** Dispatched only by command `execute` functions. */
export type CommandEvent =
	| { readonly type: "cmd/spawn"; readonly plan: SpawnPlan; readonly at: number }
	| { readonly type: "cmd/remove"; readonly machines: readonly MachineName[]; readonly cause: Cause }
	| {
			readonly type: "cmd/boot-again";
			readonly machine: MachineName;
			readonly ports: NicPorts;
			readonly at: number;
	  }
	| { readonly type: "cmd/link"; readonly changes: readonly LinkChange[]; readonly cause: Cause }
	| { readonly type: "cmd/shell"; readonly machine: MachineName }
	| {
			readonly type: "cmd/focus";
			readonly target: MachineName | SessionId;
			readonly mode: "plain" | "main" | "max";
	  }
	| { readonly type: "cmd/capture"; readonly filter: string }
	| {
			readonly type: "cmd/logged";
			readonly line: string;
			readonly source: Source;
			readonly at: number;
			readonly outcome: LogEntry["outcome"];
	  };

/** The only events elements may dispatch. None touches a machine, a port or a link. */
export type UiEvent =
	| { readonly type: "ui/pane-focused"; readonly machine: MachineName }
	| { readonly type: "ui/tab-selected"; readonly session: SessionId }
	| { readonly type: "ui/park"; readonly machine: MachineName }
	| { readonly type: "ui/unpark"; readonly machine: MachineName }
	| { readonly type: "ui/maximise"; readonly machine: MachineName }
	| { readonly type: "ui/area-resized"; readonly width: number; readonly height: number }
	| { readonly type: "ui/view"; readonly view: View }
	| { readonly type: "ui/agent-panel"; readonly open: boolean }
	| { readonly type: "ui/dock"; readonly dock: Dock }
	| { readonly type: "ui/bar"; readonly open: boolean }
	| { readonly type: "ui/capture-filter"; readonly filter: string }
	| { readonly type: "ui/capture-pause"; readonly paused: boolean }
	| { readonly type: "ui/capture-clear" }
	| { readonly type: "ui/frame-selected"; readonly seq: number | null }
	| { readonly type: "ui/policy"; readonly tool: ToolName; readonly policy: Policy }
	| { readonly type: "ui/tools-paused"; readonly paused: boolean };

/** Dispatched only by agent/. */
export type AgentEvent =
	| { readonly type: "agent/webmcp"; readonly webmcp: WebMcp }
	| { readonly type: "agent/call"; readonly call: AgentCall }
	| {
			readonly type: "agent/settled";
			readonly id: number;
			readonly status: AgentCall["status"];
			readonly result: string | null;
	  };

export type LabEvent = RuntimeEvent | CommandEvent | UiEvent | AgentEvent;

// ───────────────────────────── effects: what the shell must do ─────────────────────────────

export interface HostEntry {
	readonly ip: string;
	readonly name: string;
}

export interface BootConfig {
	readonly identity: Identity;
	readonly spec: MachineSpec;
	readonly hosts: readonly HostEntry[];
}

export type Effect =
	| { readonly type: "vm/boot"; readonly machine: MachineName; readonly attempt: number; readonly config: BootConfig }
	/** Stop, terminate after 250 ms, then report vm/stopped. Idempotent. */
	| { readonly type: "vm/stop"; readonly machine: MachineName; readonly attempt: number }
	| { readonly type: "port/attach"; readonly port: PortNo; readonly machine: MachineName; readonly nic: NicNo }
	| { readonly type: "port/detach"; readonly port: PortNo }
	/** Changes the switch link and writes the capture event row, in that order. */
	| {
			readonly type: "link/set";
			readonly port: PortNo;
			readonly machine: MachineName;
			readonly nic: NicNo;
			readonly up: boolean;
			readonly cause: Cause;
	  }
	| { readonly type: "pty/open"; readonly session: SessionId }
	| { readonly type: "pty/close"; readonly session: SessionId }
	| { readonly type: "screen/create"; readonly session: SessionId }
	| { readonly type: "screen/dispose"; readonly session: SessionId }
	| { readonly type: "hosts/publish"; readonly hosts: readonly HostEntry[] }
	| { readonly type: "capture/clear" }
	/** The one polite live region. */
	| { readonly type: "announce"; readonly text: string }
	/** 10 Hz while anything boots (the counter shows tenths), else 1 Hz. */
	| { readonly type: "clock"; readonly hz: 1 | 10 };

export interface Step {
	readonly state: LabState;
	readonly effects: readonly Effect[];
}

export const BOOT_TIMEOUT_MS = 120_000;
export const LOG_LIMIT = 200;
export const AGENT_IDLE_MS = 5 * 60_000;
