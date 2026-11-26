// The capture log: every frame the switches handle, at thousands a second.
// Frames never enter the reducer. The log is a fixed ring indexed by a
// monotonic seq, with an incremental index of the seqs that pass the filter:
// an append tests only the new entry, eviction trims the index's front, and a
// filter change rebuilds it once. Subscribers hear at most once per scheduled
// flush, whatever the frame rate.

import type { Cause, DeadCable, MachineName, PortNo, PortRef, SwitchName } from "../model/index.ts";
import {
	arpAddrs,
	type CaptureFilter,
	ETH_ARP,
	type Flood,
	MATCH_ALL,
	type NameBook,
	type NicNo,
	NO_NAMES,
} from "../net/index.ts";
import { type CaptureRow, captureRow, PLAIN_NAMES, type RowNames } from "./rows.ts";

export interface FrameEntry {
	readonly kind: "frame";
	readonly seq: number;
	/** On the log's clock: ms since the lab started. */
	readonly t: number;
	/** The switch that carried it, whose ports `from` and `to` are. */
	readonly switch: SwitchName;
	readonly from: PortNo;
	/** Delivered ports as a mask: bit p-1 for port p. */
	readonly to: number;
	readonly flood: Flood | null;
	/** The switch's snapshot. Never mutated. */
	readonly bytes: Uint8Array;
	/** Who was who when it was captured. A later machine can be given the same address or name. */
	readonly names: NameBook;
	/** An ARP request that went a second unanswered. */
	readonly noReply: boolean;
	/** It had come back to a switch that it had left, round a loop of cables. */
	readonly looped: boolean;
}

export interface LinkEntry extends LinkEvent {
	readonly kind: "link";
	readonly seq: number;
	readonly t: number;
	readonly names: NameBook;
}

export interface CableEntry extends CableEvent {
	readonly kind: "cable";
	readonly seq: number;
	readonly t: number;
}

export interface StormEntry extends StormEvent {
	readonly kind: "storm";
	readonly seq: number;
	readonly t: number;
}

export type CaptureEntry = FrameEntry | LinkEntry | CableEntry | StormEntry;

function isOn(entry: CaptureEntry, on: SwitchName): boolean {
	switch (entry.kind) {
		case "frame":
		case "storm":
			return entry.switch === on;
		case "link":
			return entry.port.switch === on;
		case "cable":
			return entry.ends.some((end) => end.switch === on);
	}
}

/** One frame as a switch's tap reports it. */
export interface SwitchedFrame {
	readonly switch: SwitchName;
	readonly from: PortNo;
	readonly to: number;
	readonly flood: Flood | null;
	readonly frame: Uint8Array;
	readonly looped?: boolean;
}

/** A change to a cable between two ports of switches, or to its link. */
export interface CableEvent {
	readonly ends: readonly [PortRef, PortRef];
	readonly up: boolean;
	readonly cause: Cause;
	/** The cable was put in or taken out, and not cut or reconnected. */
	readonly plug?: true;
	/** It was cut when it was taken out. */
	readonly cut?: true;
}

/** Looped frames began to come into a switch, which is its storm, or the storm is over. */
export interface StormEvent {
	readonly switch: SwitchName;
	readonly over: boolean;
	/** What the storm has come to: the looped frames the switch took, those it did not send on, and how long it has lasted. */
	readonly looped: number;
	readonly dropped: number;
	readonly ms: number;
}

export interface LinkEvent {
	readonly port: PortRef;
	readonly machine: MachineName;
	readonly nic: NicNo;
	readonly up: boolean;
	readonly cause: Cause;
	/** The cable was put in the port or taken out of it, and not cut or reconnected. */
	readonly plug?: true;
	/** That was done to a cable whose link was down, and stays down. */
	readonly dead?: DeadCable;
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
	tail(k: number, on?: SwitchName): readonly CaptureRow[];
	/** Rows [from, from + count) of the filtered view. */
	window(from: number, count: number): readonly CaptureRow[];
	/** The position of seq in the filtered view, or -1. */
	indexOf(seq: number): number;
	entry(seq: number): CaptureEntry | null;
	/** The one that the view is filtered by. */
	readonly filter: CaptureFilter;
	/** Every frame in the buffer, ignoring the filter. */
	frames(): Iterable<FrameEntry>;
	/** Every frame in the filtered view. */
	matched(): Iterable<FrameEntry>;
	subscribe(fn: () => void): () => void;
}

/** The engine's side: the only writer. */
export interface CaptureLog extends CaptureView {
	appendFrame(f: SwitchedFrame): void;
	appendLink(e: LinkEvent): void;
	appendCable(e: CableEvent): void;
	appendStorm(e: StormEvent): void;
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
	/** Who is who in the lab now. Default no one. */
	readonly names?: () => NameBook;
	/** A row names eth0 of a machine that has others, and a switch of several. Default neither. */
	readonly rowNames?: Partial<RowNames>;
}

export const NO_REPLY_MS = 1000;

type StoredFrame = Omit<FrameEntry, "noReply"> & { noReply: boolean };
type Stored = StoredFrame | Exclude<CaptureEntry, FrameEntry>;
/** What a machine asked of an address, however often. */
interface Question {
	readonly key: string;
	/** Requests that still wait for an answer or for the sweep. */
	open: number;
	/** The tick of the latest reply. */
	answered: number;
}
interface OpenRequest {
	readonly frame: StoredFrame;
	readonly question: Question;
	/** Its place among ARP frames: a reply with a later tick answers it. */
	readonly tick: number;
}

const arpKey = (asker: number, asked: number): string => `${asker}>${asked}`;

export function createCaptureLog(opts: CaptureOptions): CaptureLog {
	const limit = opts.limit ?? 10_000;
	const { schedule, now, names = () => NO_NAMES } = opts;
	const rowNames: RowNames = { ...PLAIN_NAMES, ...opts.rowNames };

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

	// Requests in arrival order, and what they asked. Only those still in the ring, so there are never more than it
	// holds: a sweep can be a minute away, and a storm would fill the page's memory with the others.
	const pending: (OpenRequest | undefined)[] = new Array(limit);
	let pendingHead = 0;
	let pendingLen = 0;
	const questions = new Map<string, Question>();
	let arpTick = 0;
	const ask = (frame: StoredFrame, key: string) => {
		const question = questions.get(key) ?? { key, open: 0, answered: 0 };
		questions.set(key, question);
		question.open++;
		for (let old = oldest(); old && old.frame.seq < first; old = oldest()) settle(old);
		pending[(pendingHead + pendingLen) % limit] = { frame, question, tick: arpTick };
		pendingLen++;
	};
	const oldest = (): OpenRequest | undefined => pending[pendingHead];
	const settle = ({ question }: OpenRequest) => {
		pending[pendingHead] = undefined;
		pendingHead = (pendingHead + 1) % limit;
		pendingLen--;
		if (--question.open === 0) questions.delete(question.key);
	};

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
	const passes = (e: Stored): boolean => {
		switch (e.kind) {
			case "frame":
				return filter.matchesFrame(e);
			case "link":
				return filter.matchesLink(e);
			case "cable":
				return filter.matchesPlaces(e.ends);
			case "storm":
				return filter.matchesPlaces([{ switch: e.switch, port: null }]);
		}
	};
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
			if (e) out.push(captureRow(e, rowNames));
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
		tail(k, on) {
			if (on === undefined) return rows(matchLen - k, k);
			const out: CaptureRow[] = [];
			for (let i = matchLen - 1; i >= 0 && out.length < k; i--) {
				const entry = at(matchAt(i));
				if (entry && isOn(entry, on))
					out.push(captureRow(entry, rowNames));
			}
			return out.reverse();
		},
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
		get filter() {
			return filter;
		},
		*matched() {
			for (let i = 0; i < matchLen; i++) {
				const e = at(matchAt(i));
				if (e?.kind === "frame") yield e;
			}
		},
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

		appendFrame({ switch: on, from, to, flood, frame, looped = false }) {
			counters.in++;
			for (let m = to; m; m &= m - 1) counters.delivered++;
			if (flood) counters.flooded++;

			const arp = frame.length >= 42 && frame[12] === ETH_ARP >> 8 && frame[13] === (ETH_ARP & 255);
			const addrs = arp ? arpAddrs(frame) : null;
			if (addrs) arpTick++;
			if (addrs?.op === 2) {
				const question = questions.get(arpKey(addrs.tpa, addrs.spa));
				if (question) question.answered = arpTick;
			}

			if (paused) {
				changed();
				return;
			}
			const e: StoredFrame = {
				kind: "frame",
				seq: next,
				t: now(),
				switch: on,
				from,
				to,
				flood,
				bytes: frame,
				names: names(),
				noReply: false,
				looped,
			};
			push(e);
			if (addrs?.op === 1 && addrs.spa !== addrs.tpa) ask(e, arpKey(addrs.spa, addrs.tpa));
			changed();
		},

		appendLink({ port, machine, nic, up, cause, plug, dead }) {
			if (paused) return;
			push({ kind: "link", seq: next, t: now(), port, machine, nic, up, cause, plug, dead, names: names() });
			changed();
		},

		appendCable(e) {
			if (paused) return;
			push({ kind: "cable", seq: next, t: now(), ...e });
			changed();
		},

		appendStorm(e) {
			if (paused) return;
			push({ kind: "storm", seq: next, t: now(), ...e });
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
			for (let r = oldest(); r && t - r.frame.t >= NO_REPLY_MS; r = oldest()) {
				settle(r);
				if (r.question.answered > r.tick) continue;
				r.frame.noReply = true;
				if (at(r.frame.seq) === r.frame) marked = true;
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
			pending.fill(undefined);
			pendingHead = 0;
			pendingLen = 0;
			questions.clear();
			changed();
		},
	};
}
