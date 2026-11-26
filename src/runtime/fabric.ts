// Every switch of the lab and the cables between them, with no clock, timer or
// DOM of its own: whoever owns it passes the time in, and calls `drain` when
// `next` says so.
//
// A switch forwards inside the call that brought it the frame, and a machine's
// port is handed its frame in that call too. A cable between two switches is a
// queue in each direction. So a loop of cables cannot recurse, one direction
// that is full takes nothing from another, and a switch's tap has reported a
// frame before the next switch takes it.
//
// A frame carries the switches it has left, each with the VLAN it was in
// there, as lab metadata that is never on the wire. One that comes back to a
// switch in a VLAN it has been in there has looped, and stays so: a cable from
// one VLAN to another is crossed once, and a way round that comes back to the
// first VLAN is a loop. Looped frames wait their turn at a pace, and nothing
// else is slowed.
//
// A frame is classified into a VLAN at the port it comes in by, and goes out
// only of ports that carry that VLAN, so each VLAN floods within itself and
// has a table of its own. On a cable between switches it is as it would be on
// the wire: tagged, but for a trunk's native VLAN.
//
// Addresses are numbers here. They are text only where someone reads a table.

import type { PortNo, PortVlan } from "../model/index.ts";
import { type Flood, PRIORITY_ONLY, RESERVED_VLAN, vlanTag, withoutTag, withTag } from "../net/index.ts";

export interface PortCounters {
	rxFrames: number;
	rxBytes: number;
	txFrames: number;
	txBytes: number;
	dropped: number;
	flooded: number;
}

/** What a switch has carried since it was made, whatever has been unplugged from it. */
export interface SwitchCounters {
	/** Frames it accepted. */
	readonly in: number;
	/** Copies handed to ports: a flood to two ports counts two. */
	readonly delivered: number;
	readonly flooded: number;
	/** Frames it did not put on a cable to another switch, because as many as the lab lets wait there were waiting. */
	readonly dropped: number;
}

export interface SwitchPort {
	/**
	 * Hand a frame to the attached machine. The frame is shared with every
	 * other recipient of this flood, so a port must neither retain it nor
	 * detach its buffer: copy first if it transfers the bytes elsewhere.
	 */
	deliver(frame: Uint8Array): void;
}

/** One frame a switch accepted, for capture. */
export interface TapEvent {
	readonly from: PortNo;
	/** The ports it was handed to, as a mask: bit p-1 for port p. */
	readonly to: number;
	/** Why it went to every other port, or null when it was forwarded (or filtered) by the table. */
	readonly flood: Flood | null;
	/** Taken before delivery, so a port that transfers its copy cannot change what capture sees. */
	readonly frame: Uint8Array;
	/** It had come back to a switch, in a VLAN that the switch had carried it in. */
	readonly looped: boolean;
	/** The VLAN the switch carried it in. `frame` is without its tag. */
	readonly vlan: number;
	/** The ports it had an 802.1Q tag on, as a mask: the one it came in by, those it went out of, or none. */
	readonly tagged: number;
}

export interface MacEntry {
	readonly vlan: number;
	readonly mac: string;
	readonly port: PortNo;
	/** When the address was last seen, on the clock that is passed in. */
	readonly seen: number;
	/** Learned on a port whose link went down. Kept for the table, never used for forwarding. */
	readonly flushed: boolean;
}

/** A switch that looped frames come into: one on a loop of cables, or one that such a loop reaches. */
export interface StormReading {
	readonly since: number;
	/** Looped frames a second, as they came in over the last second. */
	readonly rate: number;
	/** Looped frames that came in since it began. */
	readonly looped: number;
	/** Frames it did not put on a cable since it began, because as many as the lab lets wait there were waiting. */
	readonly dropped: number;
}

export interface FabricEvents {
	/** After the switch has handed the frame on. */
	tap?(slot: number, e: TapEvent): void;
	/** A switch began to storm, or its storm is over: the reading is then what it came to. */
	storm?(slot: number, reading: StormReading, over: boolean): void;
}

export interface FabricOptions {
	/** Age out MAC table entries after this long. Default 5 minutes. Flushed entries never age. */
	readonly macAgeMs?: number;
}

/** One port of one switch, by the switch's slot. */
export interface SlotPort {
	readonly slot: number;
	readonly port: PortNo;
}

/** As many switches as a frame's mark has bits for. The lab has no more. */
export const SLOTS = 8;
const PORTS = 8;
/** Frames that wait on one direction of a cable, of those that have not looped. More are dropped. */
export const QUEUE_LIMIT = 256;
/** Looped frames that wait on one direction. More are dropped, which is what keeps a storm from growing. */
export const LOOPED_LIMIT = 64;
/** One looped frame a millisecond in each direction: 1,000 a second. */
export const PACE_MS = 1;
/** A storm is over when no looped frame has come in for this long. */
export const STORM_QUIET_MS = 100;
const RATE_BUCKETS = 10;
const RATE_BUCKET_MS = 1000 / RATE_BUCKETS;
/** The tenths of the second before the one that `now` is in, and that one. */
const RATE_SLOTS = RATE_BUCKETS + 1;
/** A storm moves every address with every frame, so a table is aged no more often than this. */
const AGE_EVERY_MS = 1000;

const BROADCAST = 0xffff_ffff_ffff;

/** The six bytes at `at`, as one number. */
function macAt(f: Uint8Array, at: number): number {
	return (
		((f[at] << 8) | f[at + 1]) * 0x1_0000_0000 +
		(((f[at + 2] << 24) | (f[at + 3] << 16) | (f[at + 4] << 8) | f[at + 5]) >>> 0)
	);
}

function macText(mac: number): string {
	const hex = mac.toString(16).padStart(12, "0");
	return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10)}`;
}

interface Learned {
	port: number;
	seen: number;
	flushed: boolean;
}

/** A switch that a frame has left, with the VLAN it carried it in, and those before. */
interface Trail {
	readonly slot: number;
	readonly vlan: number;
	readonly before: Trail | null;
}

function hasLeft(trail: Trail | null, slot: number, vlan: number): boolean {
	for (let at = trail; at; at = at.before) if (at.slot === slot && at.vlan === vlan) return true;
	return false;
}

interface Waiting {
	readonly due: number;
	readonly frame: Uint8Array;
	/** Null once it has looped, which it stays. */
	readonly trail: Trail | null;
	readonly looped: boolean;
}

/** One way along a cable between two switches. */
class Direction {
	q: Waiting[] = [];
	head = 0;
	/** In the round of those with a frame that is due. */
	ready = false;
	/** Its cable is out. */
	gone = false;
	waitingLooped = 0;
	/** When the last looped frame put on it is due. */
	paced = 0;
	/** Its cable is whole. */
	up = true;
	readonly fromSlot: number;
	readonly toSlot: number;
	readonly toPort: number;
	constructor(fromSlot: number, toSlot: number, toPort: number) {
		this.fromSlot = fromSlot;
		this.toSlot = toSlot;
		this.toPort = toPort;
	}
	/** Loses what waits in it, and says how many frames that was. */
	empty(): number {
		const lost = this.q.length - this.head;
		this.q = [];
		this.head = 0;
		this.waitingLooped = 0;
		this.paced = 0;
		return lost;
	}
}

/** What a port carries, ready for the frames. */
interface Mode {
	readonly trunk: boolean;
	/** An access port's VLAN, or a trunk's native one. */
	readonly vlan: number;
	/** A trunk's VLANs, a bit each, or null for all of them. */
	readonly allows: Uint8Array | null;
}

const ACCESS_1: Mode = { trunk: false, vlan: 1, allows: null };

function modeOf(vlan: PortVlan): Mode {
	if (vlan.mode === "access") return vlan.vlan === 1 ? ACCESS_1 : { trunk: false, vlan: vlan.vlan, allows: null };
	if (vlan.allowed === "all") return { trunk: true, vlan: vlan.native, allows: null };
	const allows = new Uint8Array(512);
	for (const id of vlan.allowed) allows[id >> 3] |= 1 << (id & 7);
	return { trunk: true, vlan: vlan.native, allows };
}

const allows = ({ allows }: Mode, vlan: number): boolean =>
	allows === null || (allows[vlan >> 3] & (1 << (vlan & 7))) !== 0;

/** Whether a frame of the VLAN goes out of a port of this mode. */
const carries = (mode: Mode, vlan: number): boolean => (mode.trunk ? allows(mode, vlan) : mode.vlan === vlan);

interface Port {
	up: boolean;
	/** Where a machine's port hands its frames. */
	readonly sink: SwitchPort | null;
	/** The way out of a port that a cable to another switch is in. */
	readonly out: Direction | null;
	readonly counters: PortCounters;
}

interface Storm {
	readonly since: number;
	/** Those that looped frames came in. */
	readonly vlans: Set<number>;
	looped: number;
	dropped: number;
	/** Looped frames in the tenth of a second that the newest are in, and in each of the ten before it. */
	readonly recent: Uint32Array;
	tenth: number;
}

class Switch {
	readonly ports: (Port | undefined)[] = new Array<Port | undefined>(PORTS + 1).fill(undefined);
	/** What each port carries, whether or not something is in it. */
	readonly modes: Mode[] = new Array<Mode>(PORTS + 1).fill(ACCESS_1);
	/** A table for each VLAN that has had a frame. */
	readonly tables = new Map<number, Map<number, Learned>>();
	readonly totals = { in: 0, delivered: 0, flooded: 0, dropped: 0 };
	agedAt = 0;
	/** When a looped frame last came in. */
	loopedAt = 0;
	storm: Storm | null = null;
}

function tableOf(sw: Switch, vlan: number): Map<number, Learned> {
	let table = sw.tables.get(vlan);
	if (!table) {
		table = new Map();
		sw.tables.set(vlan, table);
	}
	return table;
}

/** Every address learned on the port, in each VLAN. */
function forget(sw: Switch, port: number): void {
	for (const table of sw.tables.values()) for (const [mac, e] of table) if (e.port === port) table.delete(mac);
}

function newCounters(): PortCounters {
	return { rxFrames: 0, rxBytes: 0, txFrames: 0, txBytes: 0, dropped: 0, flooded: 0 };
}

/** Leaves only the tenth of a second that `now` is in, and the whole tenths of the second before it. */
function roll(storm: Storm, now: number): void {
	const tenth = Math.floor(now / RATE_BUCKET_MS);
	const passed = Math.min(RATE_SLOTS, tenth - storm.tenth);
	for (let i = 1; i <= passed; i++) storm.recent[(storm.tenth + i) % RATE_SLOTS] = 0;
	if (passed > 0) storm.tenth = tenth;
}

/**
 * The rate is of the whole tenths of the last second that the storm has had. A
 * tenth holds the frames that were due in it, wherever the page got to carry
 * them, so a paced stream reads as its pace and no more. A storm younger than
 * a whole tenth has its frames so far, over a tenth.
 */
function readingOf(storm: Storm, now: number): StormReading {
	roll(storm, now);
	const tenths = Math.min(RATE_BUCKETS, storm.tenth - Math.floor(storm.since / RATE_BUCKET_MS));
	const newest = storm.recent[storm.tenth % RATE_SLOTS];
	let counted = newest;
	if (tenths > 0) {
		counted = -newest;
		for (const frames of storm.recent) counted += frames;
	}
	const rate = Math.round((counted * 1000) / (Math.max(1, tenths) * RATE_BUCKET_MS));
	return { since: storm.since, rate, looped: storm.looped, dropped: storm.dropped };
}

export class Fabric {
	readonly #events: FabricEvents;
	readonly #macAgeMs: number;
	readonly #switches: (Switch | undefined)[] = new Array<Switch | undefined>(SLOTS).fill(undefined);
	#dirs: Direction[] = [];
	/** The directions with a frame that is due, in the order they are served. */
	#ready: Direction[] = [];
	#readyHead = 0;
	/** How many switches storm. */
	#storming = 0;
	#waiting = 0;
	/** Those of them that have looped. */
	#loopedWaiting = 0;

	constructor(events: FabricEvents = {}, options: FabricOptions = {}) {
		this.#events = events;
		this.#macAgeMs = options.macAgeMs ?? 5 * 60_000;
	}

	/**
	 * A new switch with nothing plugged in, at the lowest slot that is free. A
	 * frame that still waits somewhere can have left the switch that had the
	 * slot before, and is then taken for looped here: it is paced for nothing.
	 */
	addSwitch(): number {
		const slot = this.#switches.indexOf(undefined);
		if (slot < 0) throw new Error(`the fabric holds ${SLOTS} switches`);
		this.#switches[slot] = new Switch();
		return slot;
	}

	/** The switch, what was plugged into it and what it had learned and counted are gone. Its storm is over. */
	removeSwitch(slot: number, now: number): void {
		const sw = this.#switches[slot];
		if (!sw) return;
		for (let port = 1; port <= PORTS; port++) this.detach(slot, port as PortNo);
		this.#switches[slot] = undefined;
		if (!sw.storm) return;
		this.#storming--;
		this.#events.storm?.(slot, readingOf(sw.storm, now), true);
	}

	/** Plug a machine into a port, link up. */
	attach(slot: number, port: PortNo, sink: SwitchPort): void {
		this.#free(slot, port)[port] = { up: true, sink, out: null, counters: newCounters() };
	}

	/** Put a cable between two ports, link up. Both can be of one switch. */
	cable(a: SlotPort, b: SlotPort): void {
		if (a.slot === b.slot && a.port === b.port) throw new Error("a cable has two ends");
		const portsA = this.#free(a.slot, a.port);
		const portsB = this.#free(b.slot, b.port);
		const ab = new Direction(a.slot, b.slot, b.port);
		const ba = new Direction(b.slot, a.slot, a.port);
		portsA[a.port] = { up: true, sink: null, out: ab, counters: newCounters() };
		portsB[b.port] = { up: true, sink: null, out: ba, counters: newCounters() };
		this.#dirs.push(ab, ba);
	}

	#free(slot: number, port: PortNo): (Port | undefined)[] {
		const sw = this.#switches[slot];
		if (!sw) throw new Error(`no switch in slot ${slot}`);
		if (sw.ports[port]) throw new Error(`port ${port} is already attached`);
		return sw.ports;
	}

	/** Where the cable in a port goes, or null for a port that has none to another switch. */
	farEnd(slot: number, port: PortNo): SlotPort | null {
		const out = this.#switches[slot]?.ports[port]?.out;
		return out ? { slot: out.toSlot, port: out.toPort as PortNo } : null;
	}

	/** Unplug the port and forget every address learned on it. A cable to another switch comes out of both its ports. */
	detach(slot: number, port: PortNo): void {
		const sw = this.#switches[slot];
		const held = sw?.ports[port];
		if (!sw || !held) return;
		this.#unplug(sw, port);
		if (!held.out) return;
		const far = this.#switches[held.out.toSlot];
		const back = far?.ports[held.out.toPort]?.out;
		if (far) this.#unplug(far, held.out.toPort);
		for (const dir of [held.out, back]) {
			if (!dir) continue;
			dir.gone = true;
			this.#lose(dir);
		}
		this.#dirs = this.#dirs.filter((dir) => !dir.gone);
	}

	#unplug(sw: Switch, port: number): void {
		sw.ports[port] = undefined;
		forget(sw, port);
	}

	/** What the port carries from now on. The switch forgets what it had learned on it. */
	setVlan(slot: number, port: PortNo, vlan: PortVlan): void {
		const sw = this.#switches[slot];
		if (!sw) return;
		sw.modes[port] = modeOf(vlan);
		forget(sw, port);
	}

	/**
	 * Cut or reconnect the cable. A cut flushes the addresses learned over it,
	 * at both its ends when it goes to another switch, and what waited in it is
	 * lost. Relearning waits for the next frame.
	 */
	setLink(slot: number, port: PortNo, up: boolean): void {
		const sw = this.#switches[slot];
		const held = sw?.ports[port];
		if (!sw || !held) return;
		this.#setEnd(sw, port, held, up);
		if (!held.out) return;
		const far = this.#switches[held.out.toSlot];
		const farPort = far?.ports[held.out.toPort];
		if (far && farPort) this.#setEnd(far, held.out.toPort, farPort, up);
	}

	#setEnd(sw: Switch, port: number, held: Port, up: boolean): void {
		held.up = up;
		if (held.out) held.out.up = up;
		if (up) return;
		if (held.out) this.#lose(held.out);
		for (const table of sw.tables.values()) for (const e of table.values()) if (e.port === port) e.flushed = true;
	}

	/** What waits in the direction is lost. */
	#lose(dir: Direction): void {
		this.#loopedWaiting -= dir.waitingLooped;
		this.#waiting -= dir.empty();
	}

	isUp(slot: number, port: PortNo): boolean {
		return this.#switches[slot]?.ports[port]?.up ?? false;
	}

	counters(slot: number, port: PortNo): PortCounters | undefined {
		return this.#switches[slot]?.ports[port]?.counters;
	}

	/** Every port's, those that are unplugged by now too. */
	totals(slot: number): SwitchCounters {
		return { ...(this.#switches[slot]?.totals ?? { in: 0, delivered: 0, flooded: 0, dropped: 0 }) };
	}

	macTable(slot: number, now: number): readonly MacEntry[] {
		const sw = this.#switches[slot];
		if (!sw) return [];
		this.#age(sw, now);
		return Array.from(sw.tables).flatMap(([vlan, table]) =>
			Array.from(table, ([mac, e]) => ({
				vlan,
				mac: macText(mac),
				port: e.port as PortNo,
				seen: e.seen,
				flushed: e.flushed,
			})),
		);
	}

	/** Null for a switch that no looped frame comes into. */
	storm(slot: number, now: number): StormReading | null {
		const storm = this.#switches[slot]?.storm;
		return storm ? readingOf(storm, now) : null;
	}

	/** Frames that wait in cables between switches. */
	get waiting(): number {
		return this.#waiting;
	}

	/** Whether `drain` has anything to do, now or later. */
	get busy(): boolean {
		return this.#waiting > 0 || this.#storming > 0;
	}

	/** A machine put a frame on the wire. */
	receive(slot: number, from: PortNo, frame: Uint8Array, now: number): void {
		this.#forward(slot, from, frame, now, null);
	}

	/** `came` is what waited on the cable that brought it, or null for a frame from a machine. */
	#forward(slot: number, from: number, frame: Uint8Array, now: number, came: Waiting | null): void {
		const sw = this.#switches[slot];
		const src = sw?.ports[from];
		if (!sw || !src) return;
		src.counters.rxFrames++;
		src.counters.rxBytes += frame.length;
		if (!src.up || frame.length < 14) {
			src.counters.dropped++;
			return;
		}

		// An access port carries whatever comes in as its VLAN's, tag and all, as a switch that knows no VLANs would.
		const mode = sw.modes[from];
		const tag = mode.trunk ? vlanTag(frame) : null;
		const vlan = tag === null || tag === PRIORITY_ONLY ? mode.vlan : tag;
		if (mode.trunk && (vlan === RESERVED_VLAN || !allows(mode, vlan))) {
			src.counters.dropped++;
			return;
		}
		const looped = came !== null && (came.looped || hasLeft(came.trail, slot, vlan));
		// A frame that had looped waited for its turn, and is counted at it: that is what the pace holds to.
		if (came && looped) this.#stormed(sw, slot, vlan, now, came.looped ? came.due : now);
		const plain = tag === null ? frame : withoutTag(frame);
		/** The frame as it goes out of a trunk, made when the first needs it. */
		let tagged = tag === vlan ? frame : null;

		sw.totals.in++;
		const tap = this.#events.tap;
		const snapshot = tap ? plain.slice() : plain;
		const table = tableOf(sw, vlan);
		this.#learn(sw, table, macAt(plain, 6), from, now);

		let flood: Flood | null = null;
		let to = 0;
		let tags = tag === vlan ? 1 << (from - 1) : 0;
		const left = looped ? null : { slot, vlan, before: came?.trail ?? null };
		const out = (p: number, port: Port): boolean => {
			const egress = sw.modes[p];
			if (!carries(egress, vlan)) return false;
			if (!egress.trunk || egress.vlan === vlan) return this.#send(sw, port, plain, now, left, looped);
			tagged ??= withTag(plain, vlan);
			if (!this.#send(sw, port, tagged, now, left, looped)) return false;
			tags |= 1 << (p - 1);
			return true;
		};
		if (plain[0] & 1) {
			flood = "group";
		} else {
			const entry = table.get(macAt(plain, 0));
			if (!entry || entry.flushed || this.#aged(entry, now)) {
				flood = "unknown";
			} else if (entry.port !== from) {
				const target = sw.ports[entry.port];
				if (target && out(entry.port, target)) to = 1 << (entry.port - 1);
			}
		}
		if (flood) {
			src.counters.flooded++;
			sw.totals.flooded++;
			for (let p = 1; p <= PORTS; p++) {
				const port = sw.ports[p];
				if (p !== from && port && out(p, port)) to |= 1 << (p - 1);
			}
		}

		if (!tap) return;
		try {
			tap(slot, { from: from as PortNo, to, flood, frame: snapshot, looped, vlan, tagged: tags });
		} catch {
			// A broken inspector must never break the wire.
		}
	}

	#aged(entry: Learned, now: number): boolean {
		return this.#macAgeMs > 0 && now - entry.seen > this.#macAgeMs;
	}

	#learn(sw: Switch, table: Map<number, Learned>, mac: number, port: number, now: number): void {
		if (mac === BROADCAST) return;
		const known = table.get(mac);
		if (known) {
			const moved = known.port !== port;
			known.port = port;
			known.seen = now;
			known.flushed = false;
			if (!moved) return;
		} else {
			table.set(mac, { port, seen: now, flushed: false });
		}
		if (table.size > 1 && now - sw.agedAt >= AGE_EVERY_MS) this.#age(sw, now);
	}

	#age(sw: Switch, now: number): void {
		sw.agedAt = now;
		for (const table of sw.tables.values()) {
			for (const [mac, e] of table) if (!e.flushed && this.#aged(e, now)) table.delete(mac);
		}
	}

	#send(sw: Switch, port: Port, frame: Uint8Array, now: number, left: Trail | null, looped: boolean): boolean {
		const c = port.counters;
		if (!port.up) {
			c.dropped++;
			return false;
		}
		if (port.out) {
			if (!this.#enqueue(port.out, frame, now, left, looped)) {
				c.dropped++;
				sw.totals.dropped++;
				if (sw.storm) sw.storm.dropped++;
				return false;
			}
			c.txFrames++;
			c.txBytes += frame.length;
		} else {
			c.txFrames++;
			c.txBytes += frame.length;
			try {
				port.sink?.deliver(frame);
			} catch {
				c.dropped++;
				return false;
			}
		}
		sw.totals.delivered++;
		return true;
	}

	/** False when as many as may wait there are waiting. */
	#enqueue(dir: Direction, frame: Uint8Array, now: number, trail: Trail | null, looped: boolean): boolean {
		const { q } = dir;
		let due = 0;
		if (looped) {
			if (dir.waitingLooped >= LOOPED_LIMIT) return false;
			dir.waitingLooped++;
			this.#loopedWaiting++;
			// From when the one before it is due, not from now, so the pace holds however late a turn comes.
			dir.paced = Math.max(now, dir.paced) + PACE_MS;
			due = dir.paced;
		} else if (q.length - dir.head - dir.waitingLooped >= QUEUE_LIMIT) {
			return false;
		}
		const item: Waiting = { due, frame, trail, looped };
		this.#waiting++;
		q.push(item);
		for (let i = q.length - 1; i > dir.head && q[i - 1].due > due; i--) {
			q[i] = q[i - 1];
			q[i - 1] = item;
		}
		this.#arm(dir, now);
		return true;
	}

	#arm(dir: Direction, now: number): void {
		if (dir.ready || dir.head === dir.q.length || dir.q[dir.head].due > now) return;
		dir.ready = true;
		this.#ready.push(dir);
	}

	/**
	 * Carry up to `most` frames that are due across their cables, one from each
	 * direction in turn, and end the storms that have gone quiet. Returns how
	 * many turns it took: zero when nothing was due.
	 */
	drain(now: number, most: number): number {
		this.#settle(now);
		for (const dir of this.#dirs) this.#arm(dir, now);
		let turns = 0;
		for (; turns < most && this.#readyHead < this.#ready.length; turns++) {
			const dir = this.#ready[this.#readyHead++];
			if (this.#readyHead === this.#ready.length) {
				this.#ready.length = 0;
				this.#readyHead = 0;
			} else if (this.#readyHead > 1024) {
				this.#ready.splice(0, this.#readyHead);
				this.#readyHead = 0;
			}
			dir.ready = false;
			if (dir.gone || dir.head === dir.q.length) continue;
			const item = dir.q[dir.head];
			if (item.due > now) continue;
			dir.head++;
			if (dir.head === dir.q.length) {
				dir.q.length = 0;
				dir.head = 0;
			} else if (dir.head > 256) {
				dir.q.splice(0, dir.head);
				dir.head = 0;
			}
			if (item.looped) {
				dir.waitingLooped--;
				this.#loopedWaiting--;
			}
			this.#waiting--;
			this.#arm(dir, now);
			this.#forward(dir.toSlot, dir.toPort, item.frame, now, item);
		}
		return turns;
	}

	/** A looped frame that was due at `due` has come into the switch in the VLAN. Its storm begins with the first. */
	#stormed(sw: Switch, slot: number, vlan: number, now: number, due: number): void {
		sw.loopedAt = now;
		if (!sw.storm) {
			this.#storming++;
			sw.storm = {
				since: due,
				vlans: new Set(),
				looped: 0,
				dropped: 0,
				recent: new Uint32Array(RATE_SLOTS),
				tenth: Math.floor(now / RATE_BUCKET_MS),
			};
			this.#events.storm?.(slot, readingOf(sw.storm, now), false);
		}
		const { storm } = sw;
		storm.vlans.add(vlan);
		roll(storm, now);
		const tenth = Math.floor(due / RATE_BUCKET_MS);
		if (due >= storm.since && storm.tenth - tenth < RATE_SLOTS) storm.recent[tenth % RATE_SLOTS]++;
		storm.looped++;
	}

	/** Whether a looped frame waits on a cable that still leads to the switch, by whatever way. */
	#stillComing(slot: number): boolean {
		if (this.#loopedWaiting === 0) return false;
		let reached = 1 << slot;
		for (let grew = true; grew; ) {
			grew = false;
			for (const dir of this.#dirs) {
				if (!dir.up || (reached & (1 << dir.fromSlot)) === 0) continue;
				if (dir.waitingLooped > 0) return true;
				if ((reached & (1 << dir.toSlot)) !== 0) continue;
				reached |= 1 << dir.toSlot;
				grew = true;
			}
		}
		return false;
	}

	/**
	 * A storm is over once no looped frame has come in for a while, and none
	 * waits that could: whoever calls `drain` can be kept from it for longer
	 * than that while, and the storm is still on. The switch then forgets the
	 * tables of the VLANs that looped frames came in: every address in them may
	 * be on the port that the loop last brought it by. A VLAN that no looped
	 * frame came in learned only from frames that crossed once, so its table is
	 * right, and keeping it spares its machines a flood. Forgetting when the
	 * loop is cut would be too early, because frames that still wait would teach
	 * the wrong port again.
	 */
	#settle(now: number): void {
		if (this.#storming === 0) return;
		for (let slot = 0; slot < SLOTS; slot++) {
			const sw = this.#switches[slot];
			const storm = sw?.storm;
			if (!sw || !storm || now - sw.loopedAt < STORM_QUIET_MS || this.#stillComing(slot)) continue;
			sw.storm = null;
			this.#storming--;
			for (const vlan of storm.vlans) sw.tables.delete(vlan);
			this.#events.storm?.(slot, readingOf(storm, now), true);
		}
	}

	/** When `drain` next has something to do: 0 for now, or -1 when nothing waits. */
	next(): number {
		if (this.#readyHead < this.#ready.length) return 0;
		let at = -1;
		for (const dir of this.#dirs) {
			if (dir.head === dir.q.length) continue;
			const { due } = dir.q[dir.head];
			if (at < 0 || due < at) at = due;
		}
		if (this.#storming === 0) return at;
		// While a looped frame waits, carrying it is what there is to do next, however long a storm has been quiet.
		const soonest = this.#loopedWaiting > 0 ? at : -1;
		for (const sw of this.#switches) {
			if (!sw?.storm) continue;
			const quiet = Math.max(soonest, sw.loopedAt + STORM_QUIET_MS);
			if (at < 0 || quiet < at) at = quiet;
		}
		return at;
	}
}
