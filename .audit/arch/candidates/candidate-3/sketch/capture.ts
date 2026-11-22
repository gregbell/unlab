// src/capture/* and src/net/filter.ts — the frame stream. Frames never enter
// the reducer: a ping storm is thousands of frames a second and an immutable
// update per frame is O(state) churn for no reader.
//
// Cost model (the contract this module is tested against):
//   append(frame)          O(1) amortised + O(filter terms)   — no allocation beyond the stored snapshot
//   notify subscribers     at most once per animation frame, whatever the frame rate
//   dock render            O(8)       — last eight entries
//   wire render            O(visible) — virtualised over the match index
//   filter change          O(buffer) once, then O(1) per frame again
//   "9 of 191 frames"      O(1)       — matches.length / size

import type { Cause, LabState, MachineName, PortNo } from "./model.ts";

// ───────────────────────────── entries ─────────────────────────────

export type Annotation =
	| { kind: "flooded"; ports: number } // broadcast/multicast: "flooded to port 2"
	| { kind: "unknown-flooded"; ports: number } // unicast to an unlearned MAC: "unknown destination, flooded to port 2"
	| { kind: "no-reply" }; // ARP request unanswered for 1 s

export interface FrameEntry {
	readonly kind: "frame";
	readonly seq: number;
	readonly t: number; // ms since lab start
	readonly from: PortNo;
	readonly to: number; // bitmask over ports 1..8; bit (p-1)
	readonly bytes: Uint8Array; // the switch's pre-delivery snapshot; never mutated
	/** Mutable once, by the ARP tracker (no-reply). Bumps the log revision when it changes. */
	annotation: Annotation | null;
}

export interface LinkEntry {
	readonly kind: "link";
	readonly seq: number;
	readonly t: number;
	readonly port: PortNo;
	readonly machine: MachineName;
	readonly up: boolean;
	readonly cause: Cause; // "Cable to node3 cut by the agent."
}

export type CaptureEntry = FrameEntry | LinkEntry;

/** What a row shows. Built lazily for visible rows only: decode.ts runs O(visible), not O(frames). */
export interface CaptureRow {
	readonly seq: number;
	readonly time: string; // "12.34"
	readonly proto: string;
	readonly from: RouteEnd;
	readonly to: RouteEnd;
	readonly len: number;
	readonly info: string;
	readonly note: string | null; // the annotation sentence
}
export type RouteEnd =
	| { kind: "machine"; name: MachineName; live: boolean } // live → paint in its hue; removed → plain
	| { kind: "everyone" }
	| { kind: "raw"; text: string };

// ───────────────────────────── filter (src/net/filter.ts, pure) ─────────────────────────────

/**
 * Grammar: terms separated by spaces are AND; the word `or` splits OR groups.
 * term := proto | nodeN | a.b.c.d | aa:bb:cc:dd:ee:ff | port:N   (case-insensitive)
 * Compiles to a predicate over raw bytes plus ingress/egress ports — no decode,
 * no string building per frame.
 */
export type FilterTerm =
	| { kind: "proto"; proto: "arp" | "icmp" | "tcp" | "udp" | "ipv4" | "ipv6" | "dhcp" | "dns" }
	| { kind: "machine"; name: MachineName } // matches either end, by MAC or IP arithmetic
	| { kind: "ip"; ip: number }
	| { kind: "mac"; mac: Uint8Array }
	| { kind: "port"; port: PortNo };

export interface CompiledFilter {
	readonly source: string;
	readonly groups: readonly (readonly FilterTerm[])[]; // OR of ANDs; empty = match all
	test(e: FrameEntry): boolean;
}
export interface FilterError {
	readonly token: number;
	readonly message: string; // "Capture cannot read nod3."
}
export function compileFilter(source: string): CompiledFilter | FilterError {
	throw new Error("not implemented");
}
/** Link rows always show (they are context, not traffic) — unless a port:N term names another port. */
export function matchesEntry(f: CompiledFilter, e: CaptureEntry): boolean {
	throw new Error("not implemented");
}

// ───────────────────────────── the log ─────────────────────────────

export interface CaptureLimits {
	readonly maxEntries: number; // default 10_000 (open question)
	readonly maxBytes: number; // default 16 MiB; evict by whichever bound hits first
}

export interface CaptureView {
	/** Bumped on append, evict, clear, annotation. Subscribers compare it; it is the only thing they compare. */
	readonly revision: number;
	readonly size: number;
	readonly matchCount: number;
	/** Newest k rows of the filtered view (dock). */
	tail(k: number): readonly CaptureRow[];
	/** Rows [from, from+count) of the filtered view (wire virtualiser). */
	window(from: number, count: number): readonly CaptureRow[];
	entry(seq: number): CaptureEntry | null;
	/** Every frame, ignoring the filter: Save .pcap and capture_read. */
	frames(): Iterable<FrameEntry>;
	/** rAF-coalesced. */
	subscribe(fn: () => void): () => void;
}

/**
 * Single writer: the engine (tap handler; link/set and capture/clear effects).
 * Readers (elements, capture_read) get CaptureView only.
 *
 * Structure:
 *   ring: CaptureEntry[] of fixed capacity, head/tail indices, seq monotonic
 *         (so seq - firstSeq is the ring offset: entry(seq) is O(1)).
 *   matches: a growable Int32Array of seqs that pass the current filter, in
 *         order. Append tests only the new entry; eviction drops from the front
 *         while matches[0] < firstSeq; filter change rebuilds once.
 *   arp: Map<"spa>tpa", seq> of open ARP requests; a reply deletes its key;
 *         sweep(now) annotates requests older than 1 s as no-reply. sweep runs
 *         on the clock tick, not per frame, and only when the map is non-empty.
 */
export interface CaptureLog extends CaptureView {
	appendFrame(e: Omit<FrameEntry, "seq" | "annotation">, flooded: boolean, knownDst: boolean): void;
	appendLink(e: Omit<LinkEntry, "seq" | "kind">): void;
	sweep(now: number): void;
	clear(): void;
}

/**
 * Paused and the filter are store state (state.capture), not log state. The
 * log *pulls* them: appendFrame reads config().paused (one property read; the
 * switch keeps forwarding while paused), and every read or append compares
 * config().filter by reference with the filter its match index was built
 * for, rebuilding once when it differs. Nothing is pushed into the log, so
 * there is no second copy to fall out of sync. selectCaptureFilter memoises
 * compileFilter on the source text, so the reference is stable until the
 * text changes; a FilterError keeps the last good filter and the field turns red.
 */
export interface CaptureConfig {
	readonly paused: boolean;
	readonly filter: CompiledFilter;
}
export declare const selectCaptureConfig: (s: LabState) => CaptureConfig & { error: FilterError | null };

export function createCaptureLog(
	limits: CaptureLimits,
	config: () => CaptureConfig,
	resolve: { live: (name: MachineName) => boolean },
	schedule: (fn: () => void) => void /* requestAnimationFrame; injectable for tests */,
): CaptureLog {
	throw new Error("not implemented");
}

/** src/net/pcap.ts: libpcap file, LINKTYPE_ETHERNET, microsecond timestamps from entry.t + lab start. */
export function toPcap(frames: Iterable<FrameEntry>, labStartEpochMs: number): Uint8Array {
	throw new Error("not implemented");
}
