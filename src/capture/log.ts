// The capture log: every frame the switch handles, at thousands a second.
// Frames never enter the reducer. The log is a fixed ring indexed by a
// monotonic seq, with an incremental index of the seqs that pass the filter:
// an append tests only the new entry, eviction trims the index's front, and a
// filter change rebuilds it once. Subscribers hear at most once per scheduled
// flush, whatever the frame rate.

import type { Cause, MachineName, PortNo } from "../model/index.ts";
import {
	type AddressBook,
	arpAddrs,
	type CaptureFilter,
	ETH_ARP,
	type Flood,
	MATCH_ALL,
	type NicNo,
	NO_ADDRESSES,
} from "../net/index.ts";
import { type CaptureRow, captureRow, type HasSeveralNics } from "./rows.ts";

export interface FrameEntry {
	readonly kind: "frame";
	readonly seq: number;
	/** On the log's clock: ms since the lab started. */
	readonly t: number;
	readonly from: PortNo;
	/** Delivered ports as a mask: bit p-1 for port p. */
	readonly to: number;
	readonly flood: Flood | null;
	/** The switch's snapshot. Never mutated. */
	readonly bytes: Uint8Array;
	/** Whose addresses were whose when it was captured. A later machine can be given one of them. */
	readonly names: AddressBook;
	/** An ARP request that went a second unanswered. */
	readonly noReply: boolean;
}

export interface LinkEntry {
	readonly kind: "link";
	readonly seq: number;
	readonly t: number;
	readonly port: PortNo;
	readonly machine: MachineName;
	readonly nic: NicNo;
	readonly up: boolean;
	readonly cause: Cause;
	readonly names: AddressBook;
}

export type CaptureEntry = FrameEntry | LinkEntry;

/** One frame as the switch's tap reports it. */
export interface SwitchedFrame {
	readonly from: PortNo;
	readonly to: number;
	readonly flood: Flood | null;
	readonly frame: Uint8Array;
}

export interface LinkEvent {
	readonly port: PortNo;
	readonly machine: MachineName;
	readonly nic: NicNo;
	readonly up: boolean;
	readonly cause: Cause;
}

export interface CaptureCounters {
	/** Frames the switch accepted. */
	readonly in: number;
	/** Copies handed to ports: a flood to two ports counts two. */
	readonly delivered: number;
	readonly flooded: number;
}

/** What elements and the agent read. */
export interface CaptureView {
	/** Bumped by every change a reader can see. Compare it to decide whether to render. */
	readonly revision: number;
	/** Entries in the buffer, frames and link rows. */
	readonly size: number;
	/** Frames in the buffer: the 191 of `9 of 191 frames`. */
	readonly frameCount: number;
	/** Entries in the filtered view, link rows included. */
	readonly matchCount: number;
	/** Frames in the filtered view: the 9 of `9 of 191 frames`. */
	readonly matchedFrames: number;
	/** Since the log was created. Clear does not reset them. */
	readonly counters: CaptureCounters;
	/** The newest k rows of the filtered view, oldest first. */
	tail(k: number): readonly CaptureRow[];
	/** Rows [from, from + count) of the filtered view. */
	window(from: number, count: number): readonly CaptureRow[];
	/** The position of seq in the filtered view, or -1. */
	indexOf(seq: number): number;
	entry(seq: number): CaptureEntry | null;
	/** Every frame in the buffer, ignoring the filter: Save .pcap and capture_read. */
	frames(): Iterable<FrameEntry>;
	subscribe(fn: () => void): () => void;
}

/** The engine's side: the only writer. */
export interface CaptureLog extends CaptureView {
	appendFrame(f: SwitchedFrame): void;
	appendLink(e: LinkEvent): void;
	setFilter(filter: CaptureFilter): void;
	/** While paused, the switch keeps forwarding and the counters keep running, but no rows are added. */
	setPaused(paused: boolean): void;
	/** Mark ARP requests older than a second with no reply. Run on the clock tick, with the log's clock. */
	sweep(now: number): void;
	/** Empty the list. Counters keep running; seqs are never reused. */
	clear(): void;
}

export interface CaptureOptions {
	/** Entries kept. Default 10 000. */
	readonly limit?: number;
	/** Run fn once, soon: requestAnimationFrame in the page. */
	readonly schedule: (fn: () => void) => void;
	/** ms since the lab started. */
	readonly now: () => number;
	/** The addresses the lab has set, as they are now. Default none. */
	readonly addresses?: () => AddressBook;
	/** Rows name a NIC of these machines, and of any other machine's only past eth0. Default none. */
	readonly severalNics?: HasSeveralNics;
}

export const NO_REPLY_MS = 1000;

type StoredFrame = Omit<FrameEntry, "noReply"> & { noReply: boolean };
type Stored = StoredFrame | LinkEntry;
interface OpenRequest {
	readonly frame: StoredFrame;
	readonly key: string;
	/** Its place among ARP frames: a reply with a later tick answers it. */
	readonly tick: number;
}

const arpKey = (asker: number, asked: number): string => `${asker}>${asked}`;

export function createCaptureLog(opts: CaptureOptions): CaptureLog {
	const limit = opts.limit ?? 10_000;
	const { schedule, now, severalNics, addresses = () => NO_ADDRESSES } = opts;

	const ring: (Stored | undefined)[] = new Array(limit);
	let first = 1;
	let next = 1;
	let frameCount = 0;

	// A circular buffer of matching seqs in order. It never holds more than the ring does.
	const matches = new Float64Array(limit);
	let matchHead = 0;
	let matchLen = 0;
	let matchedFrames = 0;

	let filter = MATCH_ALL;
	let paused = false;
	let revision = 0;
	const counters = { in: 0, delivered: 0, flooded: 0 };

	// Requests in arrival order, and the tick of the latest reply to each question.
	const pending: OpenRequest[] = [];
	let pendingHead = 0;
	const replies = new Map<string, number>();
	let arpTick = 0;

	const listeners = new Set<() => void>();
	let scheduled = false;
	const flush = () => {
		scheduled = false;
		for (const fn of [...listeners]) fn();
	};
	const changed = () => {
		revision++;
		if (!scheduled && listeners.size) {
			scheduled = true;
			schedule(flush);
		}
	};

	const at = (seq: number): Stored | undefined => (seq >= first && seq < next ? ring[seq % limit] : undefined);
	const matchAt = (i: number): number => matches[(matchHead + i) % limit];
	const passes = (e: Stored): boolean =>
		e.kind === "frame"
			? filter.matchesFrame(e.bytes, e.from, e.to, e.names)
			: filter.matchesLink(e.port, e.machine, e.nic, e.names);
	const index = (e: Stored) => {
		if (!passes(e)) return;
		matches[(matchHead + matchLen) % limit] = e.seq;
		matchLen++;
		if (e.kind === "frame") matchedFrames++;
	};

	const push = (e: Stored) => {
		if (next - first === limit) {
			const old = ring[first % limit];
			if (old?.kind === "frame") frameCount--;
			if (matchLen && matchAt(0) === first) {
				matchHead = (matchHead + 1) % limit;
				matchLen--;
				if (old?.kind === "frame") matchedFrames--;
			}
			first++;
		}
		ring[e.seq % limit] = e;
		next++;
		if (e.kind === "frame") frameCount++;
		index(e);
	};

	const rebuild = () => {
		matchHead = 0;
		matchLen = 0;
		matchedFrames = 0;
		for (let seq = first; seq < next; seq++) {
			const e = ring[seq % limit];
			if (e) index(e);
		}
	};

	const rows = (from: number, count: number): CaptureRow[] => {
		const start = Math.max(0, Math.min(from, matchLen));
		const end = Math.max(start, Math.min(matchLen, from + count));
		const out: CaptureRow[] = [];
		for (let i = start; i < end; i++) {
			const e = at(matchAt(i));
			if (e) out.push(captureRow(e, severalNics));
		}
		return out;
	};

	return {
		get revision() {
			return revision;
		},
		get size() {
			return next - first;
		},
		get frameCount() {
			return frameCount;
		},
		get matchCount() {
			return matchLen;
		},
		get matchedFrames() {
			return matchedFrames;
		},
		get counters() {
			return { ...counters };
		},
		tail: (k) => rows(matchLen - k, k),
		window: rows,
		indexOf(seq) {
			let lo = 0;
			let hi = matchLen - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >>> 1;
				const s = matchAt(mid);
				if (s === seq) return mid;
				if (s < seq) lo = mid + 1;
				else hi = mid - 1;
			}
			return -1;
		},
		entry: (seq) => at(seq) ?? null,
		*frames() {
			for (let seq = first; seq < next; seq++) {
				const e = ring[seq % limit];
				if (e?.kind === "frame") yield e;
			}
		},
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},

		appendFrame({ from, to, flood, frame }) {
			counters.in++;
			for (let m = to; m; m &= m - 1) counters.delivered++;
			if (flood) counters.flooded++;

			const arp = frame.length >= 42 && frame[12] === ETH_ARP >> 8 && frame[13] === (ETH_ARP & 255);
			const addrs = arp ? arpAddrs(frame) : null;
			if (addrs) arpTick++;
			if (addrs?.op === 2) replies.set(arpKey(addrs.tpa, addrs.spa), arpTick);

			if (paused) {
				changed();
				return;
			}
			const e: StoredFrame = {
				kind: "frame",
				seq: next,
				t: now(),
				from,
				to,
				flood,
				bytes: frame,
				names: addresses(),
				noReply: false,
			};
			if (addrs?.op === 1 && addrs.spa !== addrs.tpa) {
				pending.push({ frame: e, key: arpKey(addrs.spa, addrs.tpa), tick: arpTick });
			}
			push(e);
			changed();
		},

		appendLink({ port, machine, nic, up, cause }) {
			if (paused) return;
			push({ kind: "link", seq: next, t: now(), port, machine, nic, up, cause, names: addresses() });
			changed();
		},

		setFilter(f) {
			if (f === filter) return;
			filter = f;
			rebuild();
			changed();
		},

		setPaused(p) {
			paused = p;
		},

		sweep(t) {
			let marked = false;
			while (pendingHead < pending.length && t - pending[pendingHead].frame.t >= NO_REPLY_MS) {
				const r = pending[pendingHead++];
				if ((replies.get(r.key) ?? 0) > r.tick) continue;
				r.frame.noReply = true;
				if (at(r.frame.seq) === r.frame) marked = true;
			}
			if (pendingHead === pending.length) {
				pending.length = 0;
				pendingHead = 0;
				replies.clear();
			} else if (pendingHead > 1024) {
				pending.splice(0, pendingHead);
				pendingHead = 0;
			}
			if (marked) changed();
		},

		clear() {
			ring.fill(undefined);
			first = next;
			frameCount = 0;
			matchHead = 0;
			matchLen = 0;
			matchedFrames = 0;
			pending.length = 0;
			pendingHead = 0;
			replies.clear();
			changed();
		},
	};
}
