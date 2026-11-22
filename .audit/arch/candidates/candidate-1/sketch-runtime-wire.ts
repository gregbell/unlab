// src/runtime/** : the only code that touches Workers and the switch.
// src/wire/**    : the capture ring, its annotations, the filter grammar, pcap.
//
// runtime imports: domain (ids, RuntimeEvent), wire/frames.ts.   Nothing imports runtime
// except app.ts and test/kernel (commands see it through `LabPort`, sketch-commands.ts).
// wire imports: domain (ids, events).

import type { Cause, MacEntry, MachineName, MachineSpec, PortNo, RuntimeEvent, SessionId, State, WireEvent, WireTotals } from "./sketch-domain.ts";

const NI = (): never => {
	throw new Error("not implemented");
};

// ───────────────────────── runtime/switch.ts (reshaped LabSwitch) ─────────────────────────
// Kept: the forwarding core, transport-agnostic ports, per-port counters, Node-testable.
// Changed: ports are numbers 1..8 owned here; flushed MAC entries are retained; the tap
// says WHY it flooded; link changes go out on the same ordered feed as frames.

/** What crossed the switch, in switch order. This (not TapEvent) is the domain type. */
export type WireItem =
	| {
			kind: "frame";
			seq: number;
			/** ms since the lab started. */
			t: number;
			ingress: PortNo;
			egress: readonly PortNo[];
			/** `group`: broadcast/multicast. `unknown`: unicast to a MAC the table does not hold. */
			flood: "no" | "group" | "unknown";
			bytes: Uint8Array;
	  }
	| { kind: "link"; seq: number; t: number; port: PortNo; up: boolean; machine: MachineName; cause: Cause };

export interface PortOptions {
	name: MachineName;
	deliver: (frame: Uint8Array) => void;
}

export class LabSwitch {
	constructor(_opts?: { macAgeMs?: number; now?: () => number }) {}
	/** Lowest free port, or null when all eight are taken. The one place port numbers are allocated. */
	lowestFree(): PortNo | null {
		return NI();
	}
	attach(_port: PortNo, _opts: PortOptions): void {
		NI();
	}
	/** Frees the port and forgets its MAC entries, flushed ones included. */
	detach(_port: PortNo): void {
		NI();
	}
	/** Down: entries learned on the port become `flushed` (kept for display, ignored for forwarding). Emits a link item. */
	setLink(_port: PortNo, _up: boolean, _cause: Cause): void {
		NI();
	}
	receive(_from: PortNo, _frame: Uint8Array): void {
		NI();
	}
	onWire(_fn: (item: WireItem) => void): () => void {
		return NI();
	}
	macTable(): MacEntry[] {
		return NI();
	}
	totals(): WireTotals {
		return NI();
	}
	counters(_port: PortNo): { rx: number; tx: number } | undefined {
		return NI();
	}
}

// ───────────────────────── runtime/machine-process.ts (was Machine + Session) ─────────────────────────
// Private to runtime/. Owns one Worker and speaks protocol.ts; holds no display state.
// `Session` shrinks to a byte pipe; scrollback, marks and prompt state moved to terminal/.

/** The page's `Worker` or Node's `worker_threads.Worker`, adapted. Injected so runtime runs in Node. */
export interface WorkerLike {
	post(message: unknown, transfer?: Transferable[]): void;
	onMessage(fn: (message: unknown) => void): void;
	onError(fn: (message: string) => void): void;
	terminate(): void;
}

/** Bytes of one session. A terminal attaches once and keeps it for the session's life. */
export interface SessionPipe {
	readonly id: SessionId;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Delivers everything buffered since the session opened, then live bytes. One subscriber. */
	attach(onBytes: (bytes: Uint8Array) => void): () => void;
}

// ───────────────────────── runtime/lab-runtime.ts (was Lab) ─────────────────────────

export class LabError extends Error {}

export interface LabRuntimeOptions {
	manifest: { distros: readonly { name: string; file: string; size: number }[] };
	cidr?: string;
	/** No prompt within this → `machine/failed` with reason "No prompt after 30 s." */
	bootTimeoutMs?: number;
	spawnWorker: (name: MachineName) => WorkerLike;
	clock?: { now(): number; after(ms: number, fn: () => void): () => void };
	/** Low-rate facts. Called synchronously, in order, as the world changes. */
	onEvent: (e: RuntimeEvent) => void;
	/** High-rate feed: every frame and link change, in switch order. */
	onWire: (item: WireItem) => void;
}

/**
 * The lab as a physical thing: machines, cables, shells. One facade, eight methods.
 * Hidden behind it: workers and the wire protocol, image fetch-once, address and MAC
 * assignment, the monotonic name counter, lowest-free-port allocation, boot timeout,
 * /etc/hosts sync across guests, the stop-then-terminate teardown, session numbering.
 *
 * Every method is idempotent or throws LabError before changing anything. Commands
 * validate against State first; LabError is the backstop, never the user's message.
 */
export class LabRuntime {
	constructor(_opts: LabRuntimeOptions) {}

	/**
	 * Names are `node<n>` from a counter that only goes up. With `spec.net`, each takes the
	 * lowest free port now (reserved while booting). Emits `machine/spawned` per machine
	 * before returning, so the store already holds them all, booting.
	 */
	spawn(_count: number, _spec: MachineSpec): MachineName[] {
		return NI();
	}
	/** failed → booting: new worker, same name/image/memory, lowest free port if `spec.net`. No-op unless failed. */
	bootAgain(_name: MachineName): void {
		NI();
	}
	/**
	 * `machine/removing`, link down (so neighbours and capture see it leave), stop, terminate
	 * after 250 ms, detach the port, `machine/gone`. Resolves at gone. Second call returns the
	 * same promise.
	 */
	remove(_name: MachineName): Promise<void> {
		return NI();
	}
	/** `up` on an unplugged machine plugs it into the lowest free port. Same state again is a no-op. */
	setLink(_name: MachineName, _up: boolean, _cause: Cause): void {
		NI();
	}
	/** Returns `node2:sh3` at once; `session/ready` follows when the guest has the pty. */
	openShell(_name: MachineName): SessionId {
		return NI();
	}
	closeSession(_id: SessionId): void {
		NI();
	}
	session(_id: SessionId): SessionPipe {
		return NI();
	}
	/** Side channel (vm.exec): never touches a console. Used by guest setup and health checks, not by the `exec` verb. */
	execQuiet(_name: MachineName, _cmd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
		return NI();
	}
	readonly switch: Pick<LabSwitch, "macTable" | "totals" | "counters"> = NI();
}

// ───────────────────────── wire/capture.ts ─────────────────────────

export type Endpoint = { is: "machine"; name: MachineName } | { is: "everyone" } | { is: "raw"; addr: string };

export type Row =
	| {
			kind: "frame";
			seq: number;
			t: number;
			len: number;
			proto: string;
			src: Endpoint;
			dst: Endpoint;
			srcMac: string;
			dstMac: string;
			srcIp: string | null;
			dstIp: string | null;
			ingress: PortNo;
			egress: readonly PortNo[];
			flood: "no" | "group" | "unknown";
			/** `flooded to port 2` | `unknown destination, flooded to port 2` | `no reply` | … Set at push, or later for `no reply`. */
			note: string | null;
			bytes: Uint8Array;
	  }
	| { kind: "link"; seq: number; t: number; port: PortNo; up: boolean; machine: MachineName; /** `Cable to node3 cut by the agent.` */ text: string };

export interface CaptureOptions {
	/** Rows kept. Default 10 000 (open question in the handoff). */
	capacity?: number;
	/** ARP request unanswered this long gets `no reply`. Default 1000. */
	arpReplyMs?: number;
	/** O(1) reads of the two bits of state the hot path needs. */
	paused: () => boolean;
	nameOf: (mac: string) => MachineName | null;
	/** requestAnimationFrame in the page; manual in tests. */
	frame: (fn: () => void) => void;
	clock: { now(): number; after(ms: number, fn: () => void): () => void };
	/** Totals, MAC table and per-port counters, read once per tick (O(ports)). */
	sample: () => Pick<WireEvent, "totals" | "mac" | "frames">;
	onTick: (e: WireEvent) => void;
}

/**
 * A fixed ring of rows plus the commentary only a whole-wire view can add.
 *
 * Cost per frame, on the switch's call stack: fixed-offset header reads, one ring slot
 * write, one Map op when the frame is ARP. No decode string, no filter, no listener, no
 * allocation proportional to the buffer. Everything a human sees happens at the tick:
 * at most once per animation frame, `onTick` reports the new `head`, and each view
 * extends itself over `[lastHead, head)`.
 *
 * `no reply`: an ARP request is queued (FIFO, so expiry is O(1)) with its deadline; a
 * matching reply removes it; on expiry the request's row gets the note and `rev` bumps.
 */
export class CaptureLog {
	constructor(_opts: CaptureOptions) {}
	/** The hot path. Paused: the row is dropped but the tick still runs so counters move. */
	push(_item: WireItem): void {
		NI();
	}
	clear(): void {
		NI();
	}
	readonly first: number = 0;
	readonly head: number = 0;
	/** O(1). undefined once evicted. */
	row(_seq: number): Row | undefined {
		return NI();
	}
	/** The one-line decode, computed on first read (only rows on screen ever pay for it). */
	info(_row: Row): string {
		return NI();
	}
	/** A filtered window that grows incrementally. One per `<unlab-capture>` and one per `capture_read` call. */
	view(_filter: Filter): CaptureView {
		return NI();
	}
	/** Whole buffer, ignoring the filter, as a classic pcap (LINKTYPE_ETHERNET). */
	pcap(): Blob {
		return NI();
	}
}

export interface CaptureView {
	/** Extend the match index over rows pushed since the last call; drop evicted seqs. O(new rows). */
	sync(): void;
	readonly count: number;
	/** Matching seqs `[from, to)` by match position, for a virtual list; negative `from` counts from the end. */
	slice(from: number, to?: number): readonly number[];
}

// ───────────────────────── wire/filter.ts ─────────────────────────

/** Compiled once per edit. Space = and, `or` = or; terms: proto, machine name, IPv4, MAC, `port:3`. */
export type Filter = (row: Row) => boolean;
export function parseFilter(_text: string, _names: readonly MachineName[]): Filter | { error: string } {
	return NI();
}

// ───────────────────────── wire/explain.ts ─────────────────────────

/** `what switch0 did`, one or two sentences, for the frame detail panel. Pure over a row. */
export function explain(_row: Row, _state: State): string[] {
	return NI();
}
/** The annotation text for a frame at push time. */
export function floodNote(_flood: "no" | "group" | "unknown", _egress: readonly PortNo[]): string | null {
	return NI();
}
