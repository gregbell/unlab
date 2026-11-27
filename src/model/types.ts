// The lab as plain data. Nothing here touches the DOM, a worker, a timer or a
// clock: time arrives only as `tick` events and `at` stamps.

import type { Address, MachineName, NicName, NicNo } from "../net/index.ts";

export type { Address, MachineName, NicName, NicNo };

// ───────────────────────────── identity ─────────────────────────────

/** What the user types and what everything else keys by. Never reused on a machine. */
export type SessionId = `${MachineName}:console` | `${MachineName}:sh${number}`;
export type PortNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type HueNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const PORTS: readonly PortNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
/** A lab of more than eight machines has some that share one. */
export const HUES: readonly HueNo[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const MAX_MACHINES = 16;
export const MAX_SWITCHES = 8;
/** The switch that every lab has. */
export const DEFAULT_SWITCH = "switch0" as const;
declare const switchName: unique symbol;
/** What a switch goes by: the default one's name, or one that was chosen and checked. */
export type SwitchName = typeof DEFAULT_SWITCH | (string & { readonly [switchName]: true });
/** What a command takes for every machine. */
export const ALL_MACHINES = "all";

/** `n` only goes up and is one machine's for the lab's lifetime. Its MACs, its first address and its disks follow from it. */
export interface Identity {
	readonly n: number;
	/** What the user types and what everything else keys by. Free again once the machine is gone. */
	readonly name: MachineName;
	/** eth0's. */
	readonly mac: string;
}

/** One port of one switch. */
export interface PortRef {
	readonly switch: SwitchName;
	readonly port: PortNo;
}

/** Where a cable can be put. A port of null is the lowest free one. */
export interface Place {
	readonly switch: SwitchName;
	readonly port: PortNo | null;
}

/** One NIC of one machine. NIC 0 is eth0. */
export interface NicRef {
	readonly machine: MachineName;
	readonly nic: NicNo;
}

declare const conditions: unique symbol;
/**
 * How a cable treats the frames that cross it, the same in both directions. A
 * part that is left out does nothing, so a cable that is as good as new has
 * none. Made only by `conditionsOf`, which keeps each part in its range.
 */
export type Conditions = {
	/** How long each frame takes to cross, in whole ms. */
	readonly delay?: number;
	/** The frames it loses, in percent. */
	readonly loss?: number;
	/** The frames that skip the delay, and so arrive before those sent just ahead of them, in percent. Only with a delay. */
	readonly reorder?: number;
	/** The most it carries, in bits a second. */
	readonly rate?: number;
	/** The longest packet that a frame on it can hold, in bytes, below Ethernet's 1500. */
	readonly mtu?: number;
} & { readonly [conditions]: true };

/** A cable that is as good as new. */
export const NO_CONDITIONS = {} as Conditions;

export type ConditionPart = "delay" | "loss" | "reorder" | "rate" | "mtu";

/** Why a cable did not carry a frame: it lost it, had no room for it at its rate, or the frame was longer than its MTU. */
export type DropReason = "loss" | "rate" | "mtu";

/** A frame that a cable dropped, by the port of the switch that the cable is in. */
export interface CableDrop {
	readonly port: PortNo;
	readonly reason: DropReason;
}

/** What a cable has carried, both ways, since it was put in. */
export interface CableCounters {
	/** Frames that reached its far end. */
	readonly delivered: number;
	readonly dropped: Readonly<Record<DropReason, number>>;
}

/**
 * A cable between two ports of switches, which can both be of one switch. A
 * port holds one cable, so either of its ports names it. Cut, it keeps both.
 */
export interface SwitchCable {
	readonly ends: readonly [PortRef, PortRef];
	readonly link: "up" | "cut";
	/** Left out, none. */
	readonly conditions?: Conditions;
}

declare const vlanId: unique symbol;
/** A VLAN's number: a whole number from 1 to 4094. */
export type VlanId = number & { readonly [vlanId]: true };
export const MIN_VLAN = 1;
export const MAX_VLAN = 4094;
/** The VLAN that every port is in until it is put in another. */
export const DEFAULT_VLAN = 1 as VlanId;

/**
 * What a port carries. An access port carries one VLAN, untagged. A trunk
 * carries those it allows, each tagged but its native VLAN, which goes
 * untagged and only when it is one of those allowed.
 */
export type PortVlan =
	| { readonly mode: "access"; readonly vlan: VlanId }
	| { readonly mode: "trunk"; readonly allowed: readonly VlanId[] | "all"; readonly native: VlanId };

export const DEFAULT_PORT_VLAN: PortVlan = { mode: "access", vlan: DEFAULT_VLAN };

/** A port that is not an access port of VLAN 1. */
export interface VlanPort {
	readonly port: PortRef;
	readonly vlan: PortVlan;
}

/** A switch that looped frames come into: one on a loop of cables, or one that such a loop reaches. */
export interface Storm {
	readonly since: number;
	/** Looped frames a second, as they came into it over the last second. */
	readonly rate: number;
	/** Frames it did not send on since the storm began, which is how the lab stays responsive. */
	readonly dropped: number;
}

/**
 * What a port is in its switch's spanning tree: its way to the root, a way
 * from the root to whatever is on its cable, or a spare of either, which
 * carries nothing: an alternate to the root port, or a backup to another port
 * of its own switch.
 */
export type TreeRole = "root" | "designated" | "alternate" | "backup";

/** What a port of a switch with spanning tree on does with frames: drops them, drops them and learns from them, or carries them. */
export type TreeState = "discarding" | "learning" | "forwarding";

export interface TreePort {
	readonly port: PortNo;
	readonly role: TreeRole;
	readonly state: TreeState;
}

/** A switch as the spanning tree knows it. The lower priority wins, and then the lower address. */
export interface BridgeRef {
	readonly priority: number;
	/** As a MAC is written. */
	readonly address: string;
}

/** A switch's part in the spanning tree, as its messages with its neighbours left it. */
export interface Tree {
	readonly bridge: BridgeRef;
	/** The switch that every one of the tree counts its way to. Its own, for the root. */
	readonly root: BridgeRef;
	/** What its way to the root costs: 0 for the root. */
	readonly cost: number;
	/** The ports whose link is up, lowest first. */
	readonly ports: readonly TreePort[];
}

// ───────────────────────────── machines ─────────────────────────────

export type Source = "bar" | "button" | "agent" | "cli";
/** Who or what caused something the lab reports in words: capture event rows, announcements. */
export type Cause = Source | "runtime" | "power";

export type Plug =
	| { readonly kind: "none" }
	| {
			readonly kind: "port";
			readonly port: PortRef;
			readonly link: "up" | "cut";
			/** The cable's, which go where it is moved. Left out, none. */
			readonly conditions?: Conditions;
	  };

/** A port for each NIC, eth0 first, or null for one that is not plugged in. */
export type NicPorts = readonly (PortRef | null)[];

export interface ImageInfo {
	/** The manifest name, used in the grammar: `alpine`. */
	readonly name: string;
	/** For display: `alpine 3.24`. */
	readonly label: string;
}

export const DISK_SIZES = ["4", "8", "16", "32", "64"] as const;
export type DiskSize = (typeof DISK_SIZES)[number];

declare const gib: unique symbol;
/** An extra disk's size: a whole number from 1 to 64. */
export type GiB = number & { readonly [gib]: true };

export interface Disks {
	/** The size of the one that keeps the guest's files. */
	readonly root: DiskSize;
	/** The blank ones beside it, in the guest's order. */
	readonly extra: readonly GiB[];
}

declare const checkpointName: unique symbol;
/** What a person calls a checkpoint, unique on its machine. */
export type CheckpointName = string & { readonly [checkpointName]: true };

/** A machine's disks as they were. */
export interface Checkpoint {
	readonly name: CheckpointName;
	readonly set: number;
	/** What its blocks take in the browser's storage. */
	readonly bytes: number;
}

/**
 * All of a machine's disks are kept together in a numbered set. The guest has
 * the live one, and each checkpoint is another. `next` only goes up, so a number
 * is one set's for the machine's lifetime, and a set that nothing here names is
 * one that was never finished.
 */
export interface DiskSets {
	readonly live: number;
	readonly next: number;
	/** Oldest first. */
	readonly checkpoints: readonly Checkpoint[];
}

/** A checkpoint that is being saved. */
export interface Saving {
	readonly name: CheckpointName;
	readonly set: number;
	readonly percent: number;
}

/** The most a guest kernel can address. */
export const MAX_MEM_MIB = 4096;

export interface NicSpec {
	readonly net: SwitchName | "none";
	/** What the lab sets on it at every boot. Null leaves it up with none. */
	readonly address: Address | null;
}

interface Hardware {
	readonly disks: Disks;
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
	/** For one machine. Left out, each is `node<n>`. */
	readonly name?: MachineName;
}

/** What a machine's kernel stopping leads to. */
export type Next = "off" | "reboot";

/**
 * The lifecycle is the type. A failed machine has no plugs, so it cannot hold
 * a port. An off machine keeps its cables in, so its ports are its own, but
 * its links are down. A removing machine keeps its ports (links already down)
 * until it is gone, so nobody can take them mid-teardown. `plugs` and `ports`
 * have one for each NIC, eth0 first. `attempt` stamps every runtime event and
 * goes up with each boot under one name, so a late message from a replaced
 * worker, or from the last machine of that name, is ignored.
 *
 * Stopping lasts until the worker is gone and its disks are saved. A guest
 * that is asked to stop still has its links until then.
 *
 * Restoring copies a checkpoint to a new set of disks beside the live one, which
 * the machine then boots from. Until then nothing has changed but that it is
 * down. A checkpoint that is being saved ends with the phase it was started in.
 */
export type Lifecycle =
	| {
			readonly phase: "booting";
			readonly attempt: number;
			readonly since: number;
			readonly stage: string;
			readonly plugs: readonly Plug[];
	  }
	| {
			readonly phase: "ready";
			readonly attempt: number;
			readonly bootMs: number;
			readonly plugs: readonly Plug[];
			/** NICs that are gone from the running guest. They are back at its next boot. */
			readonly lost?: readonly NicNo[];
			readonly saving?: Saving;
	  }
	| {
			readonly phase: "stopping";
			readonly attempt: number;
			readonly next: Next;
			readonly plugs: readonly Plug[];
			/** It had been ready, so its links are up. */
			readonly linked: boolean;
			/** The shells that closed because of it. */
			readonly closed: readonly SessionId[];
	  }
	| {
			readonly phase: "off";
			readonly attempt: number;
			readonly plugs: readonly Plug[];
			readonly saving?: Saving;
	  }
	| {
			readonly phase: "restoring";
			readonly attempt: number;
			readonly from: Checkpoint;
			/** The set that will be live. */
			readonly set: number;
			readonly percent: number;
			readonly plugs: readonly Plug[];
			/** The shells that closed because of it. */
			readonly closed: readonly SessionId[];
	  }
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
	/** How its last stop went: whether the guest shut down, or had to be cut short. Null when it has not stopped with its cables in. */
	readonly lastStop: "clean" | "forced" | null;
	readonly sets: DiskSets;
	/** Why the last checkpoint that was asked for could not be saved. */
	readonly unsaved: { readonly set: number; readonly reason: string } | null;
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
	/** The frame selected in the maximised capture, by its seq. */
	readonly selected: number | null;
}

export type Policy = "run" | "ask" | "off";
export type ToolName =
	| "lab_help"
	| "machines_list"
	| "topology_read"
	| "machines_spawn"
	| "machines_boot"
	| "machines_reboot"
	| "machines_poweroff"
	| "machines_remove"
	| "switch_add"
	| "switch_remove"
	| "switch_cable"
	| "switch_uncable"
	| "port_vlan"
	| "port_trunk"
	| "checkpoint_save"
	| "checkpoint_restore"
	| "checkpoint_remove"
	| "shell_exec"
	| "shell_read"
	| "file_write"
	| "link_set"
	| "cable_plug"
	| "cable_unplug"
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
	/** How the agent reached the lab: the browser's WebMCP, or `npx unlab.run mcp` through the CLI. */
	readonly via: "webmcp" | "cli";
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

/** The link with the CLI on this computer. */
export type CliLink =
	/** The lab does not look for one. */
	| { readonly kind: "off" }
	| { readonly kind: "waiting" }
	/** The browser does not let the lab reach this computer. */
	| { readonly kind: "blocked" }
	/** It is there and does not take this lab. One sentence. */
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "linked" };

export interface LogEntry {
	readonly id: number;
	readonly line: string;
	readonly source: Source;
	readonly at: number;
	readonly outcome: "ok" | "failed";
}

export type View = "lab" | "spawn";

/** The panels under the panes, left to right, which is also their order in the panel bar. */
export const PANELS = ["capture", DEFAULT_SWITCH] as const;
export type PanelName = (typeof PANELS)[number];

export interface Panels {
	/** In `PANELS` order. The others are parked. */
	readonly open: readonly PanelName[];
	/** While one panel is maximised it stands in for the panes and the other panels. Always an open one. */
	readonly maximised: PanelName | null;
}

export interface Departed {
	readonly n: number;
	readonly attempt: number;
}

export interface LabState {
	/** ms since the lab started; advanced by `tick` and stamped events. */
	readonly now: number;
	/** The n of the next machine. Only goes up. */
	readonly nextN: number;
	readonly machines: Readonly<Partial<Record<MachineName, Machine>>>;
	/** Rail order is spawn order. ⌘K then a digit indexes this. */
	readonly rail: readonly MachineName[];
	/** The last machine of each name that is gone. Frames still name it, and the name's next machine boots on from its attempt. */
	readonly departed: Readonly<Partial<Record<MachineName, Departed>>>;
	/** In the order they are shown. */
	readonly switches: readonly [typeof DEFAULT_SWITCH, ...SwitchName[]];
	/** Those that are gone, until a machine or a switch takes the name. Frames still name them. */
	readonly departedSwitches: readonly SwitchName[];
	/** The one whose faceplate is on the page. Always one of `switches`. */
	readonly shownSwitch: SwitchName;
	/** The cables between switches, in the order they were put in. No two share a port, with each other or with a NIC. */
	readonly switchCables: readonly SwitchCable[];
	/** The ports that something is in and that are not access ports of VLAN 1, one each. A free port is in VLAN 1. */
	readonly portVlans: readonly VlanPort[];
	/** The switches that are storming now, as the runtime last said. Never saved. */
	readonly storms: Readonly<Partial<Record<SwitchName, Storm>>>;
	readonly sessions: Readonly<Partial<Record<SessionId, Session>>>;
	readonly panes: Panes;
	readonly keyboard: Keyboard;
	readonly view: View;
	readonly agentPanel: boolean;
	readonly panels: Panels;
	readonly capture: CaptureUi;
	readonly agent: AgentState;
	readonly cli: CliLink;
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

export interface BootPlan {
	readonly machine: MachineName;
	/** Those an off machine holds. For a failed one the lowest free ports, for the NICs that were spawned plugged in. */
	readonly ports: NicPorts;
}

export interface RestorePlan extends BootPlan {
	/** The checkpoint's. */
	readonly set: number;
}

export interface SwitchPlan {
	readonly name: SwitchName;
}

/** Who already has a name that was chosen. */
interface NameTaken<N> {
	readonly kind: "name-taken";
	readonly name: N;
	readonly by: "machine" | "switch";
}

export type SwitchPlanError = { readonly kind: "no-switch-room" } | NameTaken<SwitchName>;

export interface LinkChange extends NicRef {
	readonly up: boolean;
	readonly port: PortRef;
	/** `link up` on an unplugged NIC takes the default switch's lowest free port. */
	readonly newPort: boolean;
}

/** Where a NIC's cable will be, or null for a NIC that will have none. */
export interface PlugPlan extends NicRef {
	readonly to: PortRef | null;
}

interface NoPorts {
	readonly kind: "no-ports";
	readonly switch: SwitchName;
	readonly free: number;
	readonly wanted: number;
}

/** What is in a port already: a NIC's cable, or one from another port of a switch. */
interface PortTaken {
	readonly kind: "port-taken";
	readonly port: PortRef;
	readonly by: NicRef | PortRef;
}

export type PlugPlanError = NoPorts | PortTaken;

/** The two ports a cable between switches will be in. */
export interface CablePlan {
	readonly ends: SwitchCable["ends"];
}

export type CablePlanError = NoPorts | PortTaken | { readonly kind: "one-port"; readonly port: PortRef };

/** A cable, by a port that it is in, and the conditions it is to have. */
export interface ConditionsChange {
	readonly port: PortRef;
	readonly conditions: Conditions;
}

/** A cable between switches, by either of its ports, and whether its link is to be up. */
export interface CableChange {
	readonly port: PortRef;
	readonly up: boolean;
}

export type PlanError =
	| NoPorts
	/** `limit` is what leaves no more room: the machines a lab holds, or the numbers it can give them, which are never used twice. */
	| { readonly kind: "no-room"; readonly free: number; readonly wanted: number; readonly limit: "machines" | "numbers" }
	| { readonly kind: "unknown-image"; readonly image: string }
	| NameTaken<MachineName>
	| { readonly kind: "address-taken"; readonly address: Address; readonly by: NicRef }
	/** Two of one machine's NICs would be in overlapping subnets. */
	| { readonly kind: "address-overlap"; readonly nics: readonly [NicNo, NicNo] }
	| { readonly kind: "address-gateway"; readonly address: Address; readonly subnet: Address };

// ───────────────────────────── events: one union, five producers ─────────────────────────────

/** Dispatched only by the runtime engine. Attempt-stamped. */
export type RuntimeEvent =
	| { readonly type: "vm/stage"; readonly machine: MachineName; readonly attempt: number; readonly stage: string }
	| { readonly type: "vm/ready"; readonly machine: MachineName; readonly attempt: number; readonly bootMs: number }
	| { readonly type: "vm/failed"; readonly machine: MachineName; readonly attempt: number; readonly reason: string }
	/** The guest shut down or rebooted by itself. Its worker still has disks to save. */
	| {
			readonly type: "vm/halted";
			readonly machine: MachineName;
			readonly attempt: number;
			readonly next: Next;
			/** Shells the guest ended as it went down. */
			readonly closed: readonly SessionId[];
	  }
	/** The worker is gone, and it has let go of its disks. */
	| {
			readonly type: "vm/stopped";
			readonly machine: MachineName;
			readonly attempt: number;
			/** The guest shut down, and every disk was saved. */
			readonly clean: boolean;
			readonly at: number;
	  }
	| {
			readonly type: "vm/nic-lost";
			readonly machine: MachineName;
			readonly attempt: number;
			readonly nic: NicNo;
			/** One sentence. */
			readonly reason: string;
	  }
	| {
			readonly type: "checkpoint/progress";
			readonly machine: MachineName;
			readonly attempt: number;
			/** The set that is being written. */
			readonly set: number;
			readonly percent: number;
	  }
	| {
			readonly type: "checkpoint/saved";
			readonly machine: MachineName;
			readonly attempt: number;
			readonly set: number;
			readonly bytes: number;
	  }
	/** Nothing of it is left. */
	| {
			readonly type: "checkpoint/unsaved";
			readonly machine: MachineName;
			readonly attempt: number;
			readonly set: number;
			/** One sentence. */
			readonly reason: string;
	  }
	| {
			readonly type: "checkpoint/restored";
			readonly machine: MachineName;
			readonly attempt: number;
			readonly set: number;
			readonly at: number;
	  }
	/** A switch began to storm, its storm goes on with these numbers, or with null it is over. */
	| { readonly type: "switch/storm"; readonly switch: SwitchName; readonly storm: Storm | null }
	| { readonly type: "session/opened"; readonly session: SessionId }
	| { readonly type: "session/ended"; readonly session: SessionId }
	| { readonly type: "session/shell"; readonly session: SessionId; readonly shell: "prompt" | "running" }
	| { readonly type: "session/marked"; readonly session: SessionId; readonly source: "bar" | "agent" }
	| { readonly type: "tick"; readonly now: number };

/** Dispatched only by command `execute` functions. */
export type CommandEvent =
	| { readonly type: "cmd/spawn"; readonly plan: SpawnPlan; readonly at: number }
	| { readonly type: "cmd/remove"; readonly machines: readonly MachineName[]; readonly cause: Cause }
	| { readonly type: "cmd/switch-add"; readonly plan: SwitchPlan }
	| { readonly type: "cmd/switch-remove"; readonly switch: SwitchName; readonly cause: Cause }
	| { readonly type: "cmd/boot"; readonly machines: readonly BootPlan[]; readonly at: number }
	| { readonly type: "cmd/power"; readonly machines: readonly MachineName[]; readonly next: Next }
	| { readonly type: "cmd/checkpoint"; readonly machine: MachineName; readonly name: CheckpointName }
	| { readonly type: "cmd/restore"; readonly plan: RestorePlan }
	| { readonly type: "cmd/forget"; readonly machine: MachineName; readonly set: number }
	| { readonly type: "cmd/link"; readonly changes: readonly LinkChange[]; readonly cause: Cause }
	| { readonly type: "cmd/plug"; readonly plan: PlugPlan; readonly cause: Cause }
	| { readonly type: "cmd/cable"; readonly plan: CablePlan; readonly cause: Cause }
	| { readonly type: "cmd/uncable"; readonly port: PortRef; readonly cause: Cause }
	| { readonly type: "cmd/cable-link"; readonly changes: readonly CableChange[]; readonly cause: Cause }
	| { readonly type: "cmd/vlan"; readonly port: PortRef; readonly vlan: PortVlan }
	| { readonly type: "cmd/conditions"; readonly changes: readonly ConditionsChange[] }
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
	| { readonly type: "ui/panel-unparked"; readonly panel: PanelName }
	| { readonly type: "ui/panel-parked"; readonly panel: PanelName }
	| { readonly type: "ui/panel-maximised"; readonly panel: PanelName }
	| { readonly type: "ui/switch-shown"; readonly switch: SwitchName }
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

/** Dispatched only by link/. */
export type LinkEvent = { readonly type: "cli/link"; readonly cli: CliLink };

export type LabEvent = RuntimeEvent | CommandEvent | UiEvent | AgentEvent | LinkEvent;

// ───────────────────────────── effects: what the shell must do ─────────────────────────────

export interface HostEntry {
	readonly ip: string;
	readonly name: string;
}

export interface BootConfig {
	readonly identity: Identity;
	readonly spec: MachineSpec;
	/** The disks it boots from. */
	readonly set: number;
	readonly hosts: readonly HostEntry[];
}

/** One set of a machine's disks to copy to another. */
export interface DiskCopy {
	readonly machine: MachineName;
	readonly attempt: number;
	readonly n: number;
	readonly extras: number;
	readonly checkpoint: CheckpointName;
	readonly from: number;
	readonly to: number;
}

/** `drop` loses what is not saved yet. The others save every disk, and `off` and `reboot` have the guest shut down first. */
export type StopHow = "drop" | "save" | Next;

/** A cable that is moved while its link is down, and why it is. */
export interface DeadCable {
	readonly way: "in" | "out";
	readonly cut: boolean;
	/** What its machine is doing, when that keeps its links down. */
	readonly machine: Exclude<Phase, "ready" | "removing" | "failed"> | null;
}

export type Effect =
	| { readonly type: "vm/boot"; readonly machine: MachineName; readonly attempt: number; readonly config: BootConfig }
	/** Stop the worker as `how` says, then report vm/stopped. Idempotent, and `drop` hurries a slower stop. */
	| { readonly type: "vm/stop"; readonly machine: MachineName; readonly attempt: number; readonly how: StopHow }
	/** Nothing can ask for these disks again. */
	| { readonly type: "disks/delete"; readonly n: number; readonly sets: readonly number[] }
	/** Of a guest that runs, or of disks that no one has open. Reports checkpoint/saved or checkpoint/unsaved. */
	| { readonly type: "checkpoint/save"; readonly copy: DiskCopy }
	/** Once the worker is gone. Reports checkpoint/restored, or vm/failed with the live disks as they were. */
	| { readonly type: "checkpoint/restore"; readonly copy: DiskCopy }
	| { readonly type: "port/attach"; readonly port: PortRef; readonly machine: MachineName; readonly nic: NicNo }
	| { readonly type: "port/detach"; readonly port: PortRef }
	/** After its ports are detached. Nothing that the switch had learned or counted is left. */
	| { readonly type: "switch/remove"; readonly switch: SwitchName }
	/** Changes the switch link and writes the capture event row, in that order. */
	| {
			readonly type: "link/set";
			readonly port: PortRef;
			readonly machine: MachineName;
			readonly nic: NicNo;
			readonly up: boolean;
			readonly cause: Cause;
			/** The cable was put in the port or taken out of it, and not cut or reconnected. */
			readonly plug?: true;
	  }
	/** Writes the capture event row of a cable that was put in the port or taken out of it while its link was down. */
	| {
			readonly type: "capture/dead-cable";
			readonly port: PortRef;
			readonly machine: MachineName;
			readonly nic: NicNo;
			readonly cause: Cause;
			readonly dead: DeadCable;
	  }
	/** Puts a cable between two ports of switches, link down. The link is another effect. */
	| { readonly type: "cable/attach"; readonly ends: SwitchCable["ends"] }
	/** Takes it out of both. Each switch forgets what it learned over it. */
	| { readonly type: "cable/detach"; readonly ends: SwitchCable["ends"] }
	/** Changes the link at both ends and writes the capture event row, in that order. */
	| {
			readonly type: "cable/link";
			readonly ends: SwitchCable["ends"];
			readonly up: boolean;
			readonly cause: Cause;
			/** The cable was put in or taken out, and not cut or reconnected. */
			readonly plug?: true;
			/** It was cut when it was taken out, so no link changed. */
			readonly cut?: true;
	  }
	/** What the port carries from now on. The switch forgets what it learned on it. */
	| { readonly type: "port/vlan"; readonly port: PortRef; readonly vlan: PortVlan }
	/** How the cable in the port treats frames from now on. One between switches is told at both its ports. */
	| { readonly type: "port/conditions"; readonly port: PortRef; readonly conditions: Conditions }
	| { readonly type: "pty/open"; readonly session: SessionId }
	| { readonly type: "pty/close"; readonly session: SessionId }
	| { readonly type: "screen/create"; readonly session: SessionId }
	| { readonly type: "screen/dispose"; readonly session: SessionId }
	/** A line from the lab in the terminal of a guest that has ended. */
	| { readonly type: "screen/note"; readonly session: SessionId; readonly text: string }
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
/** How long a guest that is asked to shut down has for it. */
export const SHUTDOWN_MS = 10_000;
export const LOG_LIMIT = 200;
export const AGENT_IDLE_MS = 5 * 60_000;
