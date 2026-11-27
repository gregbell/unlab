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
// first VLAN is a loop. Looped frames wait their turn at a pace.
//
// The copies of a frame that a switch flooded share where they have come in.
// The first to come into a switch in a VLAN goes on at once. One that comes in
// after it goes on in its turn, at the pace, and is not marked: it has taken
// another way, and may never loop. So one broadcast costs no more at once than
// a flood for each switch and VLAN it reaches, however the lab is wired, and a
// lab where a frame has one way to each switch waits for nothing.
//
// A frame is classified into a VLAN at the port it comes in by: the VLAN of its
// tag, or the port's own when it has none. A port drops a frame of a VLAN that
// it does not carry. The frame goes out only of ports that carry its VLAN, so
// each VLAN floods within itself and has a table of its own. On a cable between
// switches it is as it would be on the wire: tagged, but for a trunk's native
// VLAN. A tag that a trunk puts on comes off at the next port or the frame is
// dropped there, so no wiring makes a frame longer. A port also drops a frame
// that is longer than Ethernet carries, wherever it came from.
//
// A cable can have conditions, the same in both directions: a delay, a share
// of frames that it loses, a share that skips the delay and so overtakes, a
// rate, and an MTU. They are kept at the port the cable is in, as what a port
// carries is, and a frame meets them once on its way along the cable: where it
// leaves a switch, and, from a machine, before it comes into one. Delay, rate
// and reordering only choose when a frame is due. Loss, the MTU and a rate
// with no room left drop it, which the cable counts and the tap says. So a
// NIC's cable with conditions is a queue in each direction too, and is a call
// again once it has none and nothing waits in it.
//
// A switch can take part in a spanning tree, which is one protocol for every
// VLAN. It then sends and reads the protocol's messages as frames along its
// cables, to machines too, and a port that the tree keeps out of use takes
// and sends nothing else. `rstp.ts` is the protocol. Its timers run when
// `drain` is called, and `timer` says when the next of them is due. A frame for
// the bridges' own address is never sent on: a switch with spanning tree off
// drops it, as a bridge that keeps to 802.1D does, so two switches do not
// hear each other through a third that takes no part.
//
// Addresses are numbers here. They are text only where someone reads a table.

import {
	type CableCounters,
	type CableDrop,
	type Conditions,
	type DropReason,
	ETH_MTU,
	hasConditions,
	type PortNo,
	type PortVlan,
	type Tree,
} from "../model/index.ts";
import {
	BRIDGE_GROUP,
	ETH_HDR,
	ETH_MAX,
	type Flood,
	PRIORITY_ONLY,
	RESERVED_VLAN,
	TAG_BYTES,
	vlanTag,
	withoutTag,
	withTag,
} from "../net/index.ts";
import { Bridge } from "./rstp.ts";

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
	/** Frames it did not put on a cable, because as many as the lab lets wait there were waiting. */
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

/** One frame a switch accepted, or one from a machine that its cable dropped on the way, for capture. */
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
	/**
	 * The cables that dropped it, each by the port it is in. One of a port in `to` dropped it after the switch
	 * sent it. One at `from` dropped it before the switch had it, so the switch took nothing in and `to` is none.
	 */
	readonly dropped: readonly CableDrop[];
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
	/** A switch's part in the spanning tree has changed: its root, or what one of its ports is or does. */
	tree?(slot: number, reading: Tree): void;
}

/** A switch as the spanning tree is to know it. */
export interface BridgeConfig {
	/** Its MAC as one number, which no other switch of the lab has. */
	readonly address: number;
	/** Left out, 32768. */
	readonly priority?: number;
}

export interface FabricOptions {
	/** Age out MAC table entries after this long. Default 5 minutes. Flushed entries never age. */
	readonly macAgeMs?: number;
	/**
	 * Makes a stream of numbers from 0 up to 1. Each direction of a cable has one for the frames it loses and one
	 * for those it reorders, and draws once a frame, so which frames those are depends only on their place in that
	 * direction. Default `Math.random`.
	 */
	readonly random?: () => () => number;
}

/** One port of one switch, by the switch's slot. */
export interface SlotPort {
	readonly slot: number;
	readonly port: PortNo;
}

/** As many switches as a frame's mark has bits for. The lab has no more. */
export const SLOTS = 8;
const PORTS = 8;
/** Frames that wait on one direction of a cable, of those that go at once. More are dropped. */
export const QUEUE_LIMIT = 256;
/** Frames that wait their turn on one direction. More are dropped, which is what keeps a storm from growing. */
export const PACED_LIMIT = 64;
/** Frames that wait on one direction of a cable with conditions, for their delay or for its rate. More are dropped. */
export const HELD_LIMIT = 8192;
/** Bytes that wait for a cable's rate in one direction. A frame that would make them more is dropped. */
export const RATE_QUEUE_BYTES = 64 * 1024;
/** One frame that waits its turn a millisecond in each direction: 1,000 a second. */
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

/** A switch in a VLAN, as one number. */
const place = (slot: number, vlan: number): number => slot * 4096 + vlan;

/** What a switch gives the copies of a frame that it sends on. */
interface Sent {
	/** Null once it has looped, which it stays. */
	readonly trail: Trail | null;
	readonly looped: boolean;
	/** It waits its turn: it has looped, or another copy had come into the switch in its VLAN. */
	readonly paced: boolean;
	/**
	 * Where a copy of the frame has come in over a cable, since a switch first flooded it. Its copies share it. Null
	 * for a frame that has gone only by the table, and once it has looped.
	 */
	readonly reached: Set<number> | null;
}

/** What every copy of a frame that has looped is given. */
const LOOPED: Sent = { trail: null, looped: true, paced: true, reached: null };
/** What a frame from a machine has: it has been nowhere. */
const FRESH: Sent = { trail: null, looped: false, paced: false, reached: null };

interface Waiting extends Sent {
	due: number;
	readonly frame: Uint8Array;
}

/** A cable's conditions, ready for the frames. */
interface Wear {
	readonly delay: number;
	/** From 0 to 1. */
	readonly loss: number;
	readonly reorder: number;
	/** How long a byte takes at its rate, in ms, or 0 with none. */
	readonly msPerByte: number;
	/** The longest frame it carries, before any tag. */
	readonly longest: number;
}

function wearOf(conditions: Conditions): Wear | null {
	if (!hasConditions(conditions)) return null;
	const { delay = 0, loss = 0, reorder = 0, rate, mtu = ETH_MTU } = conditions;
	return {
		delay,
		loss: loss / 100,
		reorder: reorder / 100,
		msPerByte: rate === undefined ? 0 : 8000 / rate,
		longest: ETH_HDR + mtu,
	};
}

/** What a cable has carried. The two ports of one between switches share it. */
interface Tally {
	delivered: number;
	loss: number;
	rate: number;
	mtu: number;
}

const newTally = (): Tally => ({ delivered: 0, loss: 0, rate: 0, mtu: 0 });

/** What became of a frame that was to go along a cable: it went, there was no link or no room, or the cable dropped it. */
type Outcome = "sent" | "unsent" | DropReason;

const NO_DROPS: readonly CableDrop[] = [];

interface Way {
	readonly fromSlot: number;
	readonly toSlot: number;
	readonly toPort: number;
	/** The port of the machine at its end, or null for one that ends at a switch. */
	readonly machine: Port | null;
	/** It runs from one switch to another, so what it carries has been somewhere, and can loop. */
	readonly between: boolean;
	readonly tally: Tally;
	readonly random: () => () => number;
}

/** One way along a cable: between two switches, or to or from a machine whose cable has conditions. */
class Direction {
	q: Waiting[] = [];
	head = 0;
	/** In the round of those with a frame that is due. */
	ready = false;
	/** Its cable is out. */
	gone = false;
	/** Those that wait their turn. */
	waitingPaced = 0;
	/** When the last of them is due. */
	paced = 0;
	/** Its cable is whole. */
	up = true;
	/** When the frame before has gone, at its cable's rate. */
	free = 0;
	readonly fromSlot: number;
	readonly toSlot: number;
	readonly toPort: number;
	readonly machine: Port | null;
	readonly between: boolean;
	readonly tally: Tally;
	/** A number for each frame: under the cable's loss, the frame is lost. */
	readonly lost: () => number;
	/** A number for each frame: under the cable's reordering, the frame skips the delay. */
	readonly skips: () => number;
	constructor({ fromSlot, toSlot, toPort, machine, between, tally, random }: Way) {
		this.fromSlot = fromSlot;
		this.toSlot = toSlot;
		this.toPort = toPort;
		this.machine = machine;
		this.between = between;
		this.tally = tally;
		this.lost = random();
		this.skips = random();
	}
	get waiting(): number {
		return this.q.length - this.head;
	}
	/** Loses what waits in it, and says how many frames that was. */
	empty(): number {
		const lost = this.waiting;
		this.q = [];
		this.head = 0;
		this.waitingPaced = 0;
		this.paced = 0;
		this.free = 0;
		return lost;
	}
	/** What waits for a delay or a rate is due at once, in the order it was to come. What waits its turn in a storm keeps it. */
	release(): void {
		const waiting = this.q.slice(this.head);
		for (const item of waiting) if (!item.paced) item.due = 0;
		this.q = [...waiting.filter((item) => !item.paced), ...waiting.filter((item) => item.paced)];
		this.head = 0;
		this.free = 0;
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
	/** The way out along its cable: to another switch, or to its machine once the cable has had conditions. */
	out: Direction | null;
	/** The way in from its machine, once the cable has had conditions. */
	in: Direction | null;
	readonly counters: PortCounters;
	readonly tally: Tally;
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
	/** The conditions of the cable in each port, or null for none. Kept while nothing is in it, as a mode is. */
	readonly wear: (Wear | null)[] = new Array<Wear | null>(PORTS + 1).fill(null);
	/** A table for each VLAN that has had a frame. */
	readonly tables = new Map<number, Map<number, Learned>>();
	readonly totals = { in: 0, delivered: 0, flooded: 0, dropped: 0 };
	agedAt = 0;
	/** When a looped frame last came in. */
	loopedAt = 0;
	storm: Storm | null = null;
	/** Its part in the spanning tree, or null while it takes none. */
	tree: Bridge | null = null;
	/** The reading of its tree that its owner was last told, by its version. */
	treeTold = 0;
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
	readonly #random: () => () => number;
	readonly #switches: (Switch | undefined)[] = new Array<Switch | undefined>(SLOTS).fill(undefined);
	#dirs: Direction[] = [];
	/** The directions with a frame that is due, in the order they are served. */
	#ready: Direction[] = [];
	#readyHead = 0;
	/** How many switches storm. */
	#storming = 0;
	#waiting = 0;
	/** Those of them that wait their turn. */
	#pacedWaiting = 0;
	/** How many switches take part in a spanning tree. */
	#trees = 0;

	constructor(events: FabricEvents = {}, options: FabricOptions = {}) {
		this.#events = events;
		this.#macAgeMs = options.macAgeMs ?? 5 * 60_000;
		this.#random = options.random ?? (() => Math.random);
	}

	/**
	 * A new switch with nothing plugged in, at the lowest slot that is free. A
	 * frame that still waits somewhere can have left the switch that had the
	 * slot before, or have a copy that came into it, and is then taken for
	 * looped here, or for the second to come: it is paced for nothing.
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
		if (sw.tree) this.#trees--;
		if (!sw.storm) return;
		this.#storming--;
		this.#events.storm?.(slot, readingOf(sw.storm, now), true);
	}

	/** Plug a machine into a port, link up. */
	attach(slot: number, port: PortNo, sink: SwitchPort): void {
		this.#free(slot, port)[port] = { up: true, sink, out: null, in: null, counters: newCounters(), tally: newTally() };
		this.#fit(slot, port);
		this.#switches[slot]?.tree?.enable(port, true);
	}

	/** A NIC's cable that has conditions is a queue in each direction, from then on. */
	#fit(slot: number, port: number): void {
		const sw = this.#switches[slot];
		const held = sw?.ports[port];
		if (!sw || !held?.sink || held.out || sw.wear[port] === null) return;
		const way = { fromSlot: slot, toSlot: slot, toPort: port, between: false, tally: held.tally, random: this.#random };
		held.in = new Direction({ ...way, machine: null });
		held.out = new Direction({ ...way, machine: held });
		held.in.up = held.up;
		held.out.up = held.up;
		this.#dirs.push(held.in, held.out);
	}

	/** Put a cable between two ports, link up. Both can be of one switch. */
	cable(a: SlotPort, b: SlotPort): void {
		if (a.slot === b.slot && a.port === b.port) throw new Error("a cable has two ends");
		const portsA = this.#free(a.slot, a.port);
		const portsB = this.#free(b.slot, b.port);
		const way = { machine: null, between: true, tally: newTally(), random: this.#random };
		const ab = new Direction({ ...way, fromSlot: a.slot, toSlot: b.slot, toPort: b.port });
		const ba = new Direction({ ...way, fromSlot: b.slot, toSlot: a.slot, toPort: a.port });
		const end = { up: true, sink: null, in: null, tally: way.tally };
		portsA[a.port] = { ...end, out: ab, counters: newCounters() };
		portsB[b.port] = { ...end, out: ba, counters: newCounters() };
		this.#dirs.push(ab, ba);
		for (const { slot, port } of [a, b]) this.#switches[slot]?.tree?.enable(port, false);
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
		return out?.between ? { slot: out.toSlot, port: out.toPort as PortNo } : null;
	}

	/** Unplug the port and forget every address learned on it. A cable to another switch comes out of both its ports. */
	detach(slot: number, port: PortNo): void {
		const sw = this.#switches[slot];
		const held = sw?.ports[port];
		if (!sw || !held) return;
		this.#unplug(sw, port);
		const { out } = held;
		const far = out?.between ? this.#switches[out.toSlot] : undefined;
		const back = out && far ? far.ports[out.toPort]?.out : held.in;
		if (out && far) this.#unplug(far, out.toPort);
		for (const dir of [out, back]) {
			if (!dir) continue;
			dir.gone = true;
			this.#lose(dir);
		}
		this.#dirs = this.#dirs.filter((dir) => !dir.gone);
	}

	#unplug(sw: Switch, port: number): void {
		sw.ports[port] = undefined;
		forget(sw, port);
		sw.tree?.disable(port as PortNo);
	}

	/**
	 * The switch takes part in the spanning tree as this bridge from now on, or with null takes none, and every port
	 * of it carries frames again. One that begins forgets what it learned, and no port of it carries a frame until
	 * `drain` has run its tree: a machine's then does at once, and a cable to a switch when the two have agreed.
	 */
	setTree(slot: number, bridge: BridgeConfig | null): void {
		const sw = this.#switches[slot];
		if (!sw) return;
		if (sw.tree) this.#trees--;
		sw.tree = null;
		if (!bridge) return;
		const tree = new Bridge(
			bridge.address,
			{
				send: (p, frame, now) => {
					const port = sw.ports[p];
					if (port) this.#send(sw, p, port, frame, now, FRESH);
				},
				flush: (p) => forget(sw, p),
			},
			bridge.priority,
		);
		this.#trees++;
		sw.tree = tree;
		sw.treeTold = 0;
		sw.tables.clear();
		for (let p = 1; p <= PORTS; p++) {
			const port = sw.ports[p];
			if (port?.up) tree.enable(p as PortNo, port.sink !== null);
		}
	}

	/** The switch's part in the spanning tree, or null for one that takes none. */
	tree(slot: number): Tree | null {
		return this.#switches[slot]?.tree?.reading() ?? null;
	}

	/** What the port carries from now on. The switch forgets what it had learned on it. */
	setVlan(slot: number, port: PortNo, vlan: PortVlan): void {
		const sw = this.#switches[slot];
		if (!sw) return;
		sw.modes[port] = modeOf(vlan);
		forget(sw, port);
	}

	/**
	 * How the cable in the port treats frames from now on, and the next cable in it until this says otherwise. One
	 * between switches is told at each of its ports, for the frames that leave by that one. What was on its way
	 * arrives at once, in order, so nothing that is sent after a change overtakes what was sent before it.
	 */
	setConditions(slot: number, port: PortNo, conditions: Conditions): void {
		const sw = this.#switches[slot];
		if (!sw) return;
		sw.wear[port] = wearOf(conditions);
		const held = sw.ports[port];
		if (!held) return;
		this.#fit(slot, port);
		held.out?.release();
		held.in?.release();
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
		if (!held.out?.between) return;
		const far = this.#switches[held.out.toSlot];
		const farPort = far?.ports[held.out.toPort];
		if (far && farPort) this.#setEnd(far, held.out.toPort, farPort, up);
	}

	#setEnd(sw: Switch, port: number, held: Port, up: boolean): void {
		if (held.up !== up) {
			if (up) sw.tree?.enable(port as PortNo, held.sink !== null);
			else sw.tree?.disable(port as PortNo);
		}
		held.up = up;
		for (const dir of [held.out, held.in]) {
			if (!dir) continue;
			dir.up = up;
			if (!up) this.#lose(dir);
		}
		if (up) return;
		for (const table of sw.tables.values()) for (const e of table.values()) if (e.port === port) e.flushed = true;
	}

	/** What waits in the direction is lost. */
	#lose(dir: Direction): void {
		this.#pacedWaiting -= dir.waitingPaced;
		this.#waiting -= dir.empty();
	}

	isUp(slot: number, port: PortNo): boolean {
		return this.#switches[slot]?.ports[port]?.up ?? false;
	}

	counters(slot: number, port: PortNo): PortCounters | undefined {
		return this.#switches[slot]?.ports[port]?.counters;
	}

	/** What the cable in the port has carried, both ways, since it was put in. */
	carried(slot: number, port: PortNo): CableCounters | undefined {
		const tally = this.#switches[slot]?.ports[port]?.tally;
		if (!tally) return undefined;
		const { delivered, loss, rate, mtu } = tally;
		return { delivered, dropped: { loss, rate, mtu } };
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

	/** Frames that wait in cables. */
	get waiting(): number {
		return this.#waiting;
	}

	/** Whether `drain` has anything to do, now or later, but for the spanning tree's timers, which `timer` has. */
	get busy(): boolean {
		return this.#waiting > 0 || this.#storming > 0 || this.#treePending();
	}

	/** Whether a switch's tree was told something that it has not yet worked out. */
	#treePending(): boolean {
		if (this.#trees === 0) return false;
		for (const sw of this.#switches) if (sw?.tree?.pending) return true;
		return false;
	}

	/**
	 * When a spanning tree timer next runs out, or -1 with none. The protocol counts in seconds, so whoever calls
	 * `drain` then needs to be no more exact than a timer is.
	 */
	timer(): number {
		let at = Number.POSITIVE_INFINITY;
		if (this.#trees > 0) for (const sw of this.#switches) if (sw?.tree && sw.tree.due < at) at = sw.tree.due;
		return Number.isFinite(at) ? at : -1;
	}

	#runTree(sw: Switch, slot: number, now: number): void {
		const { tree } = sw;
		if (!tree) return;
		tree.run(now);
		if (tree.version === sw.treeTold) return;
		sw.treeTold = tree.version;
		this.#events.tree?.(slot, tree.reading());
	}

	/**
	 * A frame for the bridges' own address goes to the switch's tree and no further. The tap has it as a frame that
	 * went to no port, in the first VLAN, which a row leaves unsaid: it is in none.
	 */
	#toBridge(sw: Switch, slot: number, from: PortNo, src: Port, frame: Uint8Array, now: number): void {
		const { tree } = sw;
		if (!tree) {
			src.counters.dropped++;
			return;
		}
		sw.totals.in++;
		try {
			const snapshot = frame.slice();
			this.#events.tap?.(slot, {
				from,
				to: 0,
				flood: null,
				frame: snapshot,
				looped: false,
				vlan: 1,
				tagged: 0,
				dropped: NO_DROPS,
			});
		} catch {
			// A broken inspector must never break the wire.
		}
		tree.receive(from, frame, now);
		this.#runTree(sw, slot, now);
	}

	/** A machine put a frame on the wire. */
	receive(slot: number, from: PortNo, frame: Uint8Array, now: number): void {
		const sw = this.#switches[slot];
		const src = sw?.ports[from];
		const dir = src?.in;
		if (!sw || !src?.up || !dir || (sw.wear[from] === null && dir.waiting === 0)) {
			this.#forward(slot, from, frame, now, null);
			return;
		}
		const how = this.#enqueue(dir, sw.wear[from], frame, now, FRESH);
		if (how === "unsent") src.counters.dropped++;
		else if (how !== "sent") this.#lost(sw, slot, from, frame, how);
	}

	/** Tells the tap of a frame from a machine that its cable dropped, as the port would have taken it in. */
	#lost(sw: Switch, slot: number, from: PortNo, frame: Uint8Array, reason: DropReason): void {
		const tap = this.#events.tap;
		if (!tap) return;
		const tag = vlanTag(frame);
		const vlan = tag === null || tag === PRIORITY_ONLY ? sw.modes[from].vlan : tag;
		const tagged = tag === vlan ? 1 << (from - 1) : 0;
		const plain = tag === null ? frame : withoutTag(frame);
		const dropped = [{ port: from, reason }];
		try {
			tap(slot, { from, to: 0, flood: null, frame: plain, looped: false, vlan, tagged, dropped });
		} catch {
			// A broken inspector must never break the wire.
		}
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
		src.tally.delivered++;
		if (frame[0] & 1 && macAt(frame, 0) === BRIDGE_GROUP) {
			this.#toBridge(sw, slot, from as PortNo, src, frame, now);
			return;
		}

		// An access port reads a tag as a trunk does, so it takes a frame tagged with its own VLAN and no other.
		const mode = sw.modes[from];
		const tag = vlanTag(frame);
		const vlan = tag === null || tag === PRIORITY_ONLY ? mode.vlan : tag;
		const longest = tag === null ? ETH_MAX : ETH_MAX + TAG_BYTES;
		if (vlan === RESERVED_VLAN || !carries(mode, vlan) || frame.length > longest) {
			src.counters.dropped++;
			return;
		}
		// A port that the spanning tree keeps out of use takes no frame, and one on its way into use only learns from it.
		const { tree } = sw;
		if (tree && !tree.forwards(from)) {
			src.counters.dropped++;
			if (tree.learns(from)) this.#learn(sw, tableOf(sw, vlan), macAt(frame, 6), from, now);
			return;
		}
		const looped = came !== null && (came.looped || hasLeft(came.trail, slot, vlan));
		// A frame that had looped waited for its turn, and is counted at it: that is what the pace holds to.
		if (came && looped) this.#stormed(sw, slot, vlan, now, came.looped ? came.due : now);
		// Another copy of the frame came into this switch in this VLAN first, by another way.
		const here = place(slot, vlan);
		const second = !looped && came?.reached?.has(here) === true;
		if (!looped) came?.reached?.add(here);
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
		/** Made for the first copy, when the switch knows whether it floods. */
		let sent: Sent | null = null;
		let dropped = NO_DROPS;
		const out = (p: number, port: Port): boolean => {
			const egress = sw.modes[p];
			if (!carries(egress, vlan) || (tree && !tree.forwards(p))) return false;
			sent ??= looped
				? LOOPED
				: {
						trail: { slot, vlan, before: came?.trail ?? null },
						looped,
						paced: second,
						reached: came?.reached ?? (flood ? new Set() : null),
					};
			const untagged = !egress.trunk || egress.vlan === vlan;
			if (!untagged) tagged ??= withTag(plain, vlan);
			const how = this.#send(sw, p, port, untagged ? plain : (tagged ?? plain), now, sent);
			if (how === "unsent") return false;
			if (!untagged) tags |= 1 << (p - 1);
			if (how !== "sent") dropped = [...dropped, { port: p as PortNo, reason: how }];
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
			tap(slot, { from: from as PortNo, to, flood, frame: snapshot, looped, vlan, tagged: tags, dropped });
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

	/** A frame that its cable dropped was sent all the same: the switch put it on the cable. */
	#send(sw: Switch, p: number, port: Port, frame: Uint8Array, now: number, sent: Sent): Outcome {
		const c = port.counters;
		if (!port.up) {
			c.dropped++;
			return "unsent";
		}
		const wear = sw.wear[p];
		const dir = port.out;
		// A NIC's cable is a call while it has no conditions and nothing still waits in it.
		if (!dir || (!dir.between && wear === null && dir.waiting === 0)) {
			c.txFrames++;
			c.txBytes += frame.length;
			if (!this.#hand(port, frame)) return "unsent";
			sw.totals.delivered++;
			return "sent";
		}
		const how = this.#enqueue(dir, wear, frame, now, sent);
		if (how === "unsent") {
			c.dropped++;
			sw.totals.dropped++;
			if (sw.storm) sw.storm.dropped++;
			return how;
		}
		c.txFrames++;
		c.txBytes += frame.length;
		sw.totals.delivered++;
		return how;
	}

	/** Gives a machine a frame at the end of its cable. */
	#hand(port: Port, frame: Uint8Array): boolean {
		try {
			port.sink?.deliver(frame);
		} catch {
			port.counters.dropped++;
			return false;
		}
		port.tally.delivered++;
		return true;
	}

	/**
	 * Puts a frame on its way along a cable. The cable's conditions say whether it goes and when it is due, and a
	 * frame that waits its turn in a storm is due no sooner than that. Unsent when as many as may wait there are
	 * waiting.
	 */
	#enqueue(dir: Direction, wear: Wear | null, frame: Uint8Array, now: number, sent: Sent): Outcome {
		const { q, tally } = dir;
		// What a switch hands a machine has waited its turn already, on the cable that brought it.
		const paced = sent.paced && dir.between;
		const room = paced
			? dir.waitingPaced < PACED_LIMIT
			: dir.waiting - dir.waitingPaced < (wear ? HELD_LIMIT : QUEUE_LIMIT);
		if (!room) return "unsent";
		let due = 0;
		if (wear) {
			// The MTU is of what a frame holds, so a tag is not counted in it.
			if (frame.length > wear.longest + (vlanTag(frame) === null ? 0 : TAG_BYTES)) {
				tally.mtu++;
				return "mtu";
			}
			if (wear.loss > 0 && dir.lost() < wear.loss) {
				tally.loss++;
				return "loss";
			}
			due = now;
			if (wear.msPerByte > 0) {
				// One frame at a time, each as long on its way out as its bytes take at the rate.
				const start = Math.max(now, dir.free);
				if ((start - now) / wear.msPerByte + frame.length > RATE_QUEUE_BYTES) {
					tally.rate++;
					return "rate";
				}
				dir.free = start + frame.length * wear.msPerByte;
				due = dir.free;
			}
			if (wear.delay > 0 && !(wear.reorder > 0 && dir.skips() < wear.reorder)) due += wear.delay;
		}
		if (paced) {
			dir.waitingPaced++;
			this.#pacedWaiting++;
			// From when the one before it is due, not from now, so the pace holds however late a turn comes.
			dir.paced = Math.max(now, dir.paced) + PACE_MS;
			due = Math.max(due, dir.paced);
		}
		const item: Waiting = { due, frame, trail: sent.trail, looped: sent.looped, paced, reached: sent.reached };
		this.#waiting++;
		if (dir.waiting === 0 || q[q.length - 1].due <= due) {
			q.push(item);
		} else {
			// After the last that is due no later, so a frame that skips the delay is ahead of those that take it.
			let lo = dir.head;
			let hi = q.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (q[mid].due <= due) lo = mid + 1;
				else hi = mid;
			}
			q.splice(lo, 0, item);
		}
		this.#arm(dir, now);
		return "sent";
	}

	#arm(dir: Direction, now: number): void {
		if (dir.ready || dir.head === dir.q.length || dir.q[dir.head].due > now) return;
		dir.ready = true;
		this.#ready.push(dir);
	}

	/**
	 * Carry up to `most` frames that are due across their cables, one from each
	 * direction in turn, and end the storms that have gone quiet. Before that,
	 * run each spanning tree that was told something or has a timer that ran
	 * out, so that what it sends is carried in the same call. Returns how many
	 * turns it took: zero when no frame was due.
	 */
	drain(now: number, most: number): number {
		this.#settle(now);
		if (this.#trees > 0) {
			for (let slot = 0; slot < SLOTS; slot++) {
				const sw = this.#switches[slot];
				if (sw?.tree && (sw.tree.pending || sw.tree.due <= now)) this.#runTree(sw, slot, now);
			}
		}
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
			if (item.paced) {
				dir.waitingPaced--;
				this.#pacedWaiting--;
			}
			this.#waiting--;
			this.#arm(dir, now);
			if (dir.machine) this.#hand(dir.machine, item.frame);
			else this.#forward(dir.toSlot, dir.toPort, item.frame, now, dir.between ? item : null);
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

	/** Whether a frame that has looped, or may yet, waits on a cable that still leads to the switch, by whatever way. */
	#stillComing(slot: number): boolean {
		if (this.#pacedWaiting === 0) return false;
		let reached = 1 << slot;
		for (let grew = true; grew; ) {
			grew = false;
			for (const dir of this.#dirs) {
				if (!dir.up || (reached & (1 << dir.fromSlot)) === 0) continue;
				if (dir.waitingPaced > 0) return true;
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

	/** When `drain` next has something to do, but for a spanning tree's timer: 0 for now, or -1 when nothing waits. */
	next(): number {
		if (this.#readyHead < this.#ready.length || this.#treePending()) return 0;
		let at = -1;
		for (const dir of this.#dirs) {
			if (dir.head === dir.q.length) continue;
			const { due } = dir.q[dir.head];
			if (at < 0 || due < at) at = due;
		}
		if (this.#storming === 0) return at;
		// While a frame waits its turn, carrying it is what there is to do next, however long a storm has been quiet.
		const soonest = this.#pacedWaiting > 0 ? at : -1;
		for (const sw of this.#switches) {
			if (!sw?.storm) continue;
			const quiet = Math.max(soonest, sw.loopedAt + STORM_QUIET_MS);
			if (at < 0 || quiet < at) at = quiet;
		}
		return at;
	}
}
