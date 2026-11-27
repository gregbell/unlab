// One switch's part in the rapid spanning tree protocol, with no clock, timer
// or wire of its own: whoever owns it passes the time in, hands it the
// messages its ports receive, and calls `run` when `due` says so.
//
// It follows 802.1D-2004 clause 17, whose state machines are the procedures
// here, each a list of the standard's transitions, run in turn until none of
// them fires. A timer is kept as the time it runs out, so one that has run
// out is a time that has passed. What a switch in a lab never meets is left
// out: a port that is shared by more than two bridges, a dispute over a cable
// that carries one way only, and sending classic spanning tree to a bridge
// that speaks no other. A classic message is read, as a designated port's.
// Two things are not the standard's. One is how many messages a port may send
// in a second, which `TX_HOLD` says why. The other is that a port takes an
// agreement only from a bridge that names the port's own root, where the
// standard takes any that is no better than what the port holds.
//
// A port is safe from the moment it is enabled: it neither learns nor forwards
// until the procedures have said that it may.

import {
	type BridgePriority,
	DEFAULT_COST,
	DEFAULT_PRIORITY,
	type PathCost,
	type PortNo,
	type Tree,
	type TreePort,
	type TreeRole,
} from "../model/index.ts";
import {
	type Bpdu,
	type BridgeId,
	bridgeAddress,
	bridgeIdOf,
	bridgePriority,
	decodeBpdu,
	encodeBpdu,
} from "../net/index.ts";

/** How often a designated port says what it knows. */
export const HELLO_MS = 2000;
/** How long a port stays in each of discarding and learning when no neighbour agrees to less. */
export const FORWARD_DELAY_MS = 15_000;
/** How many bridges the root's word may cross. */
const MAX_AGE_S = 20;
/** How long a port that proposes waits for another bridge to answer before it takes its cable to end at none. */
export const EDGE_DELAY_MS = 3000;
/**
 * Messages a port sends in a second, after which it sends one a second. The standard has six, to spare a bridge's
 * processor. Here that would hold a handshake back whenever cables change in quick succession, and when a ring
 * loses its root, word of the old one goes round until it has crossed twenty bridges: at six a second that takes
 * up to twelve seconds, in which two cables between a pair of switches can both carry. So this is only a bound on
 * a mistake, far above what the protocol needs.
 */
export const TX_HOLD = 1000;
/** The most that a way to the root can cost, which is what a message has four bytes for. A dearer way costs this. */
export const MOST_COST = 0xffff_ffff;
const PORT_PRIORITY = 0x80;
const PORTS = 8;
/** What a message says three hellos after the last of it. */
const INFO_HELLOS = 3;

type Role = TreeRole | "disabled";

/** Whose word a port holds: none, its neighbour's that has run out, its own bridge's, or its neighbour's. */
type InfoIs = "disabled" | "aged" | "mine" | "received";

/** A root, what the way to it costs, and the bridge and port that say so. The lower of two is the better. */
interface Vector {
	readonly root: BridgeId;
	readonly cost: number;
	readonly bridge: BridgeId;
	readonly port: number;
	/** The four as one text, which compares as they do. */
	readonly key: string;
}

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, "0");

function vector(root: BridgeId, cost: number, bridge: BridgeId, port: number): Vector {
	return { root, cost, bridge, port, key: root + hex(cost, 8) + bridge + hex(port, 4) };
}

interface Times {
	readonly age: number;
	readonly maxAge: number;
	readonly hello: number;
	readonly forwardDelay: number;
}

const sameTimes = (a: Times, b: Times): boolean =>
	a.age === b.age && a.maxAge === b.maxAge && a.hello === b.hello && a.forwardDelay === b.forwardDelay;

const OWN_TIMES: Times = { age: 0, maxAge: MAX_AGE_S, hello: HELLO_MS / 1000, forwardDelay: FORWARD_DELAY_MS / 1000 };

const address = (id: BridgeId): string => id.slice(4);
const portNumber = (id: number): number => id & 0x0fff;

class Port {
	readonly no: number;
	/** Its priority and then its number, as a message has it. */
	readonly id: number;
	cost: PathCost = DEFAULT_COST;
	/** Its link is up. */
	enabled = false;
	/** Its cable ends at no bridge, as far as it has heard. */
	edge = false;
	/** Its cable is a machine's, which starts it as an edge. */
	adminEdge = false;
	role: Role = "disabled";
	selectedRole: Role = "disabled";
	infoIs: InfoIs = "disabled";
	/** What it holds: its neighbour's word, or its own bridge's. */
	held: Vector;
	heldTimes: Times = OWN_TIMES;
	/** What its bridge would say on it. */
	designated: Vector;
	/** A message that waits to be read. */
	message: Bpdu | null = null;
	learn = false;
	forward = false;
	proposing = false;
	proposed = false;
	agree = false;
	agreed = false;
	sync = false;
	/** It closes no loop under what its bridge now knows. A port with no link closes none. */
	synced = true;
	reRoot = false;
	reselect = true;
	selected = false;
	updtInfo = false;
	newInfo = false;
	rcvdTc = false;
	tcProp = false;
	/** Where it is in telling its neighbours of a change: not in the tree, in it, or in it and forwarding. */
	change: "inactive" | "learning" | "active" = "inactive";
	helloAt = 0;
	/** When it may next go on towards forwarding without a neighbour's word. */
	forwardAt = 0;
	/** When what it received runs out. */
	infoAt = 0;
	/** Until when it counts as lately the root port. */
	recentRootAt = 0;
	/** Until when it counts as lately a backup port. */
	recentBackupAt = 0;
	edgeAt = 0;
	/** Until when it says that the topology has changed. */
	changeAt = 0;
	sent = 0;

	constructor(no: number, own: Vector) {
		this.no = no;
		this.id = (PORT_PRIORITY << 8) | no;
		this.held = own;
		this.designated = own;
	}
}

export interface Wire {
	/** Put a frame on the cable in the port. */
	send(port: PortNo, frame: Uint8Array, now: number): void;
	/** Forget every address learned on the port. */
	flush(port: PortNo): void;
}

export class Bridge {
	readonly #wire: Wire;
	readonly #address: number;
	#id: BridgeId;
	#own: Vector;
	readonly #ports: Port[];
	#root: Vector;
	#rootTimes: Times = OWN_TIMES;
	#now = 0;
	/** When the second that the ports' sent messages are counted in began. */
	#secondAt = 0;
	#stamp = "";
	/** Something was told to it since it last ran. */
	pending = true;
	/** When a timer of its next runs out, or infinity. */
	due = Number.POSITIVE_INFINITY;
	/** Goes up when what `reading` returns has changed. */
	version = 0;

	/** `address` is the switch's MAC as one number, which is the lower part of its ID. */
	constructor(address: number, wire: Wire, priority: BridgePriority = DEFAULT_PRIORITY) {
		this.#wire = wire;
		this.#address = address;
		this.#id = bridgeIdOf(priority, address);
		this.#own = vector(this.#id, 0, this.#id, 0);
		this.#root = this.#own;
		this.#ports = Array.from({ length: PORTS }, (_, i) => new Port(i + 1, this.#own));
	}

	#port(no: number): Port {
		return this.#ports[no - 1];
	}

	/** A link came up in the port. `edge` says that its cable is a machine's, which forwards at once until a bridge is heard on it. */
	enable(no: PortNo, edge: boolean): void {
		const port = this.#fresh(no);
		port.enabled = true;
		port.adminEdge = edge;
		port.edge = edge;
	}

	/** The port's link went down, or its cable is out. */
	disable(no: PortNo): void {
		this.#fresh(no);
	}

	/** The switch's priority from now on. Each port works out again what it is, as 17.13 has it. */
	setPriority(priority: BridgePriority): void {
		const id = bridgeIdOf(priority, this.#address);
		if (id === this.#id) return;
		this.#id = id;
		this.#own = vector(id, 0, id, 0);
		for (const port of this.#ports) this.#reselect(port);
	}

	/** What the port adds to the way to the root through it, from now on. The port works out again what it is. */
	setCost(no: PortNo, cost: PathCost): void {
		const port = this.#port(no);
		if (port.cost === cost) return;
		port.cost = cost;
		this.#reselect(port);
	}

	#reselect(port: Port): void {
		port.reselect = true;
		port.selected = false;
		this.pending = true;
	}

	/** The port as a new one, which takes no frame until it is run. */
	#fresh(no: number): Port {
		const { cost } = this.#port(no);
		const port = new Port(no, this.#own);
		port.cost = cost;
		this.#ports[no - 1] = port;
		this.pending = true;
		return port;
	}

	/** A frame for the bridges' address came in by the port. One that holds no message is dropped. */
	receive(no: PortNo, frame: Uint8Array, now: number): void {
		const port = this.#port(no);
		const message = decodeBpdu(frame);
		if (!port.enabled || !message) return;
		port.message = message;
		// A bridge is at the far end, so the port is no edge, and its cable has another moment to prove it.
		port.edge = false;
		port.edgeAt = now + EDGE_DELAY_MS;
		this.pending = true;
	}

	/** Whether the port takes addresses from the frames that come in by it. */
	learns(no: number): boolean {
		return this.#port(no).learn;
	}

	/** Whether frames go in and out of the port. */
	forwards(no: number): boolean {
		return this.#port(no).forward;
	}

	reading(): Tree {
		const ref = (id: BridgeId) => ({ priority: bridgePriority(id), address: bridgeAddress(id) });
		return {
			bridge: ref(this.#id),
			root: ref(this.#root.root),
			cost: this.#root.cost,
			ports: this.#ports.flatMap((port): TreePort[] => {
				if (port.role === "disabled") return [];
				const state = port.forward ? "forwarding" : port.learn ? "learning" : "discarding";
				return [{ port: port.no as PortNo, role: port.role, state }];
			}),
		};
	}

	/** Reads what came in, moves each port as far as it can go at `now`, and sends what there is to say. */
	run(now: number): void {
		this.#now = now;
		this.pending = false;
		const seconds = Math.floor((now - this.#secondAt) / 1000);
		if (seconds > 0) {
			for (const port of this.#ports) port.sent = Math.max(0, port.sent - seconds);
			this.#secondAt += seconds * 1000;
		}
		// Each transition undoes its own condition, so the procedures come to rest. The bound is for a mistake in them.
		for (let turn = 0, moved = true; moved && turn < 1000; turn++) {
			moved = false;
			for (const port of this.#ports) moved = this.#information(port) || moved;
			if (this.#ports.some((port) => port.reselect)) {
				this.#select();
				moved = true;
			}
			for (const port of this.#ports) {
				moved = this.#transition(port) || moved;
				moved = this.#topologyChange(port) || moved;
				moved = this.#detectEdge(port) || moved;
			}
		}
		for (const port of this.#ports) this.#transmit(port);
		this.due = this.#next();
		const stamp = JSON.stringify(this.reading());
		if (stamp === this.#stamp) return;
		this.#stamp = stamp;
		this.version++;
	}

	/** 17.21 and 17.27: what the port holds, from its neighbour or its own bridge. */
	#information(port: Port): boolean {
		const now = this.#now;
		if (!port.enabled) return false;
		if (port.infoIs === "disabled") {
			port.forwardAt = now + FORWARD_DELAY_MS;
			port.infoIs = "aged";
			port.reselect = true;
			port.selected = false;
			return true;
		}
		if (port.selected && port.updtInfo) {
			port.proposing = port.proposed = false;
			port.agreed = port.agreed && port.infoIs === "mine" && port.designated.key <= port.held.key;
			port.synced = port.synced && port.agreed;
			port.held = port.designated;
			port.heldTimes = this.#rootTimes;
			port.updtInfo = false;
			port.infoIs = "mine";
			port.newInfo = true;
			return true;
		}
		if (port.infoIs === "aged") return false;
		const message = port.message;
		if (message && !port.updtInfo) {
			port.message = null;
			this.#read(port, message);
			return true;
		}
		if (port.infoIs === "received" && port.infoAt <= now && !port.updtInfo) {
			port.infoIs = "aged";
			port.reselect = true;
			port.selected = false;
			return true;
		}
		return false;
	}

	#read(port: Port, message: Bpdu): void {
		const said = vector(message.root, message.cost, message.bridge, message.port);
		const times: Times = {
			age: message.age,
			maxAge: message.maxAge,
			hello: message.hello,
			forwardDelay: message.forwardDelay,
		};
		const fresh = (): void => {
			// A word that has crossed as many bridges as it may is run out as it arrives.
			port.infoAt = Math.ceil(message.age) + 1 <= message.maxAge ? this.#now + INFO_HELLOS * HELLO_MS : this.#now;
		};
		const noted = (): void => {
			if (message.role === "designated" && message.proposal) port.proposed = true;
			if (message.topologyChange) port.rcvdTc = true;
		};
		if (message.role === "designated") {
			const sameSender =
				address(said.bridge) === address(port.held.bridge) && portNumber(said.port) === portNumber(port.held.port);
			const same = said.key === port.held.key;
			if (said.key < port.held.key || (sameSender && !same) || (same && !sameTimes(times, port.heldTimes))) {
				port.agreed = port.proposing = false;
				noted();
				port.agree = port.agree && port.infoIs === "received" && said.key <= port.held.key;
				port.synced = false;
				port.held = said;
				port.heldTimes = times;
				fresh();
				port.infoIs = "received";
				port.reselect = true;
				port.selected = false;
			} else if (same) {
				noted();
				fresh();
			} else if (port.role === "designated") {
				// A bridge that knows less than this port does is told now, and not at the next hello.
				port.newInfo = true;
			}
			return;
		}
		// A root or alternate port answers a proposal with what it holds, which is no better than what was proposed.
		if (message.role !== "unknown" && said.key >= port.held.key) {
			// A bridge that answers what this port said has this port's root. One that names another answered what the
			// port said before, and that answer was on its way while word of a root that is gone went round.
			const answers = message.agreement && said.root === port.held.root;
			port.agreed = answers;
			if (answers) port.proposing = false;
			if (message.topologyChange) port.rcvdTc = true;
		}
	}

	/** 17.21.25: the root, the way to it, and from those what each port is to be. */
	#select(): void {
		let best = this.#own;
		let rootPort: Port | null = null;
		for (const port of this.#ports) {
			port.reselect = false;
			if (port.infoIs !== "received" || address(port.held.bridge) === address(this.#id)) continue;
			const { root, cost, bridge, port: sender } = port.held;
			const through = vector(root, Math.min(cost + port.cost, MOST_COST), bridge, sender);
			// Of two ports that hear the same, the lower is the first here, and stays.
			if (through.key < best.key) {
				best = through;
				rootPort = port;
			}
		}
		this.#root = best;
		this.#rootTimes = rootPort ? { ...rootPort.heldTimes, age: rootPort.heldTimes.age + 1 } : OWN_TIMES;
		for (const port of this.#ports) {
			port.designated = vector(best.root, best.cost, this.#id, port.id);
			port.selected = true;
			if (port.infoIs === "disabled") {
				port.selectedRole = "disabled";
			} else if (port.infoIs === "aged") {
				port.selectedRole = "designated";
				port.updtInfo = true;
			} else if (port.infoIs === "mine") {
				port.selectedRole = "designated";
				if (port.held.key !== port.designated.key || !sameTimes(port.heldTimes, this.#rootTimes)) port.updtInfo = true;
			} else if (port === rootPort) {
				port.selectedRole = "root";
				port.updtInfo = false;
			} else if (port.designated.key < port.held.key) {
				port.selectedRole = "designated";
				port.updtInfo = true;
			} else {
				// What it holds is as good as its own bridge's word: from another bridge, or from another port of this one.
				port.selectedRole = address(port.held.bridge) === address(this.#id) ? "backup" : "alternate";
				port.updtInfo = false;
			}
		}
	}

	/** 17.29: the port takes its role, and goes towards forwarding or away from it as the role and its neighbours let it. */
	#transition(port: Port): boolean {
		if (!port.selected || port.updtInfo) return false;
		const now = this.#now;
		if (port.role !== port.selectedRole) {
			port.role = port.selectedRole;
			if (port.role === "root") {
				port.recentRootAt = now + FORWARD_DELAY_MS;
			} else if (port.role !== "designated") {
				port.learn = port.forward = false;
				port.forwardAt = now + FORWARD_DELAY_MS;
				port.synced = true;
				port.recentRootAt = 0;
				port.sync = port.reRoot = false;
			}
			return true;
		}
		switch (port.role) {
			case "root":
				return this.#rootPortMoves(port);
			case "designated":
				return this.#designatedPortMoves(port);
			default:
				return this.#blockedPortMoves(port);
		}
	}

	#syncAll(): void {
		for (const port of this.#ports) port.sync = true;
	}

	/** 17.20.3, as 802.1Q has it: every other port that could close a loop under this one is in step with its bridge. */
	#allSynced(port: Port): boolean {
		return this.#ports.every((other) => {
			if (!other.selected || other.role !== other.selectedRole || other.updtInfo) return false;
			const spared = port.role === "designated" ? other === port : other.role === "root";
			return spared || other.synced;
		});
	}

	#rootPortMoves(port: Port): boolean {
		const now = this.#now;
		port.recentRootAt = now + FORWARD_DELAY_MS;
		if (port.proposed && !port.agree) {
			this.#syncAll();
			port.proposed = false;
			return true;
		}
		if ((this.#allSynced(port) && !port.agree) || (port.proposed && port.agree)) {
			port.proposed = port.sync = false;
			port.agree = true;
			port.newInfo = true;
			return true;
		}
		if (port.sync) {
			port.sync = false;
			return true;
		}
		if (!port.forward && !port.reRoot) {
			for (const other of this.#ports) other.reRoot = true;
			return true;
		}
		if (port.reRoot && port.forward) {
			port.reRoot = false;
			return true;
		}
		// No port that was lately the root port still forwards, so this one closes no loop.
		const reRooted = this.#ports.every((other) => other === port || other.recentRootAt <= now);
		const may = port.forwardAt <= now || (reRooted && port.recentBackupAt <= now);
		if (may && !port.learn) {
			port.forwardAt = now + FORWARD_DELAY_MS;
			port.learn = true;
			return true;
		}
		if (may && !port.forward) {
			port.forwardAt = 0;
			port.forward = true;
			return true;
		}
		return false;
	}

	#designatedPortMoves(port: Port): boolean {
		const now = this.#now;
		if (!port.forward && !port.agreed && !port.proposing && !port.edge) {
			port.proposing = true;
			port.edgeAt = now + EDGE_DELAY_MS;
			port.newInfo = true;
			return true;
		}
		const quiet = !port.learn && !port.forward;
		if (((quiet || port.agreed || port.edge) && !port.synced) || (port.sync && port.synced)) {
			port.recentRootAt = 0;
			port.synced = true;
			port.sync = false;
			return true;
		}
		if (port.recentRootAt <= now && port.reRoot) {
			port.reRoot = false;
			return true;
		}
		const stale = (port.sync && !port.synced) || (port.reRoot && port.recentRootAt > now);
		if (stale && !port.edge && !quiet) {
			port.learn = port.forward = false;
			port.forwardAt = now + FORWARD_DELAY_MS;
			return true;
		}
		const may =
			(port.forwardAt <= now || port.agreed || port.edge) && (port.recentRootAt <= now || !port.reRoot) && !port.sync;
		if (may && !port.learn) {
			port.learn = true;
			port.forwardAt = now + FORWARD_DELAY_MS;
			return true;
		}
		if (may && !port.forward) {
			port.forward = true;
			port.forwardAt = 0;
			port.agreed = true;
			return true;
		}
		return false;
	}

	/** An alternate, backup or disabled port. */
	#blockedPortMoves(port: Port): boolean {
		const now = this.#now;
		if (port.role === "disabled") return false;
		if (port.proposed && !port.agree) {
			this.#syncAll();
			port.proposed = false;
			return true;
		}
		if ((this.#allSynced(port) && !port.agree) || (port.proposed && port.agree)) {
			port.proposed = false;
			port.agree = true;
			port.newInfo = true;
			return true;
		}
		if (port.sync || port.reRoot || !port.synced) {
			port.synced = true;
			port.recentRootAt = 0;
			port.sync = port.reRoot = false;
			return true;
		}
		port.forwardAt = now + FORWARD_DELAY_MS;
		if (port.role === "backup") port.recentBackupAt = now + 2 * HELLO_MS;
		return false;
	}

	/**
	 * 17.31: a port that begins to forward says so for a while, and has every
	 * other port of its bridge forget what it learned and pass that on. So does
	 * a port that hears it. A port that leaves the tree forgets too.
	 */
	#topologyChange(port: Port): boolean {
		const inTree = port.role === "root" || port.role === "designated";
		const heard = port.rcvdTc || port.tcProp;
		switch (port.change) {
			case "inactive":
				if (port.learn) {
					port.change = "learning";
					port.rcvdTc = port.tcProp = false;
					return true;
				}
				if (!heard) return false;
				port.rcvdTc = port.tcProp = false;
				return true;
			case "learning":
				if (inTree && port.forward && !port.edge) {
					this.#sayChange(port);
					this.#tellOthers(port);
					port.newInfo = true;
					port.change = "active";
					return true;
				}
				if (heard) {
					port.rcvdTc = port.tcProp = false;
					return true;
				}
				if (inTree || port.learn) return false;
				this.#wire.flush(port.no as PortNo);
				port.changeAt = 0;
				port.change = "inactive";
				return true;
			case "active":
				if (!inTree || port.edge) {
					port.change = "learning";
					port.rcvdTc = port.tcProp = false;
					return true;
				}
				if (port.rcvdTc) {
					port.rcvdTc = false;
					this.#tellOthers(port);
					return true;
				}
				if (!port.tcProp) return false;
				this.#sayChange(port);
				this.#wire.flush(port.no as PortNo);
				port.tcProp = false;
				return true;
		}
	}

	#sayChange(port: Port): void {
		if (port.changeAt > this.#now) return;
		port.changeAt = this.#now + HELLO_MS + 1000;
		port.newInfo = true;
	}

	#tellOthers(port: Port): void {
		for (const other of this.#ports) if (other !== port) other.tcProp = true;
	}

	/** 17.25: a port that has proposed for a while to no bridge has none at the end of its cable. */
	#detectEdge(port: Port): boolean {
		if (!port.enabled || port.edge || port.role !== "designated" || !port.proposing) return false;
		if (port.edgeAt > this.#now) return false;
		port.edge = true;
		return true;
	}

	/** 17.26: what there is to say, and at each hello what a designated port knows. */
	#transmit(port: Port): void {
		const now = this.#now;
		if (!port.enabled) return;
		if (port.helloAt <= now) {
			port.newInfo ||= port.role === "designated" || (port.role === "root" && port.changeAt > now);
			port.helloAt = now + HELLO_MS;
		}
		if (!port.newInfo || !port.selected || port.updtInfo || port.sent >= TX_HOLD) return;
		port.newInfo = false;
		if (port.role === "disabled") return;
		port.sent++;
		const { root, cost, bridge } = port.designated;
		const bpdu: Bpdu = {
			rapid: true,
			root,
			cost,
			bridge,
			port: port.id,
			role: port.role === "backup" ? "alternate" : port.role,
			proposal: port.role === "designated" && port.proposing,
			agreement: port.agree,
			learning: port.learn,
			forwarding: port.forward,
			topologyChange: port.changeAt > now,
			...this.#rootTimes,
			hello: OWN_TIMES.hello,
		};
		this.#wire.send(port.no as PortNo, encodeBpdu(bpdu, this.#address), now);
	}

	/** The soonest of the timers that have not run out, or infinity. */
	#next(): number {
		const now = this.#now;
		let at = Number.POSITIVE_INFINITY;
		const consider = (time: number): void => {
			if (time > now && time < at) at = time;
		};
		for (const port of this.#ports) {
			if (!port.enabled) continue;
			consider(port.helloAt);
			consider(port.forwardAt);
			consider(port.recentRootAt);
			consider(port.recentBackupAt);
			if (port.infoIs === "received") consider(port.infoAt);
			if (port.proposing && !port.edge) consider(port.edgeAt);
			if (port.newInfo && port.sent >= TX_HOLD) consider(this.#secondAt + 1000);
		}
		return at;
	}
}
