// What a capture row shows, built from an entry only when the row is on
// screen: decoding runs per visible row, never per frame.

import {
	type CableDrop,
	type Cause,
	type DeadCable,
	type DropReason,
	type MachineName,
	PORTS,
	type PortNo,
	type PortRef,
	portText,
	type SwitchName,
} from "../model/index.ts";
import {
	arpAddrs,
	decode,
	ipAddrs,
	isGroupMac,
	type NicName,
	nameOf,
	nicLabel,
	nicName,
	nicOfMac,
} from "../net/index.ts";
import type { CableEntry, CaptureCounters, CaptureEntry, FrameEntry, LinkEntry, StormEntry } from "./log.ts";

/** What a row has to name for the lab that it is read in. */
export interface RowNames {
	/** Whether a machine has more than one NIC, so that its name alone does not say which. */
	severalNics(machine: MachineName): boolean;
	/** What to name a switch's ports with, or null when a port's number alone says which. */
	switchLabel(on: SwitchName): SwitchName | null;
}

/** One NIC to a machine, and one switch. */
export const PLAIN_NAMES: RowNames = { severalNics: () => false, switchLabel: () => null };

/**
 * A machine by the name it had (painted in its hue while machine `n` exists),
 * broadcast, or an address the lab cannot name. `nic` is there when the name
 * alone does not say which NIC it was.
 */
export type RouteEnd =
	| { readonly kind: "machine"; readonly n: number; readonly name: MachineName; readonly nic?: NicName }
	| { readonly kind: "everyone" }
	| { readonly kind: "raw"; readonly text: string };

export interface FrameRow {
	readonly kind: "frame";
	readonly seq: number;
	/** The one that carried it, when there are several, and then the port it came in by and those it went out of. */
	readonly switch?: SwitchName;
	readonly in?: PortNo;
	readonly out?: readonly PortNo[];
	/** Seconds since the lab started, two decimals. */
	readonly time: string;
	readonly proto: string;
	readonly from: RouteEnd;
	readonly to: RouteEnd;
	readonly len: number;
	readonly info: string;
	/** The lab's commentary after the info, or null. */
	readonly note: string | null;
	/** There when it had come back to a switch that it had left. */
	readonly looped?: true;
	/** The VLAN that carried it, there when that is not VLAN 1 or it had a tag. */
	readonly vlan?: number;
	/** The ports it had an 802.1Q tag on, there when it had one. */
	readonly tagged?: readonly PortNo[];
	/** The cables that dropped it, each by its port and with the reason, there when one did. */
	readonly dropped?: readonly CableDrop[];
}

export interface LinkRow {
	readonly kind: "link";
	readonly seq: number;
	readonly time: string;
	/** The port's, when there are several. */
	readonly switch?: SwitchName;
	readonly port: PortNo;
	readonly up: boolean;
	/** `port 3 link down`, `lan port 3 link down`. */
	readonly text: string;
	/** `Cable to node3 cut by the agent.`, or `node3 stopped.` */
	readonly cause: string;
}

/** A cable between two ports of switches was put in, cut, reconnected or taken out. */
export interface CableRow {
	readonly kind: "cable";
	readonly seq: number;
	readonly time: string;
	readonly ends: readonly [PortRef, PortRef];
	readonly up: boolean;
	/** `lan port 3 and wan port 1 link down`. */
	readonly text: string;
	/** `Cable between them cut by you.` */
	readonly cause: string;
}

/** Looped frames began to come into a switch, or have stopped. */
export interface StormRow {
	readonly kind: "storm";
	readonly seq: number;
	readonly time: string;
	readonly switch: SwitchName;
	readonly over: boolean;
	/** `lan is storming`, `lan storm over`. */
	readonly text: string;
	readonly cause: string;
}

/** A row that says what happened to the lab, among the frames. */
export type EventRow = LinkRow | CableRow | StormRow;

export type CaptureRow = FrameRow | EventRow;

export function captureRow(e: CaptureEntry, names: RowNames = PLAIN_NAMES): CaptureRow {
	switch (e.kind) {
		case "frame":
			return frameRow(e, names);
		case "link":
			return linkRow(e, names);
		case "cable":
			return cableRow(e, names);
		case "storm":
			return stormRow(e);
	}
}

const seconds = (ms: number): string => (ms / 1000).toFixed(2);

function frameRow(e: FrameEntry, names: RowNames): FrameRow {
	const d = decode(e.bytes);
	const on = names.switchLabel(e.switch);
	return {
		kind: "frame",
		seq: e.seq,
		...(on === null ? {} : { switch: on, in: e.from, out: portsIn(e.to) }),
		time: seconds(e.t),
		proto: d.proto,
		from: routeEnd(e, "src", d.src, names),
		to: isGroupMac(e.bytes) ? { kind: "everyone" } : routeEnd(e, "dst", d.dst, names),
		len: e.bytes.length,
		info: d.info,
		note: note(e, on),
		...(e.looped ? { looped: true } : {}),
		...(e.vlan !== 1 || e.tagged !== 0 ? { vlan: e.vlan } : {}),
		...(e.tagged !== 0 ? { tagged: portsIn(e.tagged) } : {}),
		...(e.dropped.length > 0 ? { dropped: e.dropped } : {}),
	};
}

/** By the MAC, which says which NIC, or by the IP address when the guest changed its MAC. */
function routeEnd(e: FrameEntry, end: "src" | "dst", raw: string, names: RowNames): RouteEnd {
	const at = nicOfMac(e.bytes, end === "src" ? 6 : 0);
	if (at) {
		const name = nameOf(e.names, at.n);
		const shown = at.nic > 0 || names.severalNics(name);
		return { kind: "machine", n: at.n, name, ...(shown ? { nic: nicName(at.nic) } : {}) };
	}
	const ip = addressOf(e.bytes, end);
	const n = ip === null ? undefined : e.names.addresses.get(ip)?.n;
	return n === undefined ? { kind: "raw", text: raw } : { kind: "machine", n, name: nameOf(e.names, n) };
}

function addressOf(f: Uint8Array, end: "src" | "dst"): number | null {
	const ip = ipAddrs(f);
	if (ip) return end === "src" ? ip.src : ip.dst;
	const arp = arpAddrs(f);
	if (arp) return end === "src" ? arp.spa : arp.tpa;
	return null;
}

const portsIn = (mask: number): readonly PortNo[] => PORTS.filter((port) => mask & (1 << (port - 1)));

function portList(mask: number, on: SwitchName | null): string {
	const of = on === null ? "" : `${on} `;
	const ports = portsIn(mask);
	if (ports.length === 0) return `flooded, no other ${of}port is up`;
	if (ports.length === 1) return `flooded to ${of}port ${ports[0]}`;
	return `flooded to ${of}ports ${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}`;
}

/** `vlan 10`, or `802.1Q vlan 10 on port 8` for a frame that had a tag there. */
function vlanNote(e: FrameEntry, on: SwitchName | null): string | null {
	if (e.vlan === 1 && e.tagged === 0) return null;
	if (e.tagged === 0) return `vlan ${e.vlan}`;
	const tagged = portsIn(e.tagged);
	const of = on === null ? "" : `${on} `;
	const where =
		tagged.length === 1 ? `port ${tagged[0]}` : `ports ${tagged.slice(0, -1).join(", ")} and ${tagged.at(-1)}`;
	return `802.1Q vlan ${e.vlan} on ${of}${where}`;
}

/** As a row says why a cable dropped a frame. */
export const DROP_REASON: Readonly<Record<DropReason, string>> = { loss: "loss", rate: "rate", mtu: "MTU" };

/** `dropped by the cable out of port 3: loss`, or `into port 1` for one that never reached the switch. */
function dropNote(e: FrameEntry, { port, reason }: CableDrop, on: SwitchName | null): string {
	const way = port === e.from ? "into" : "out of";
	return `dropped by the cable ${way} ${portText(on, port)}: ${DROP_REASON[reason]}`;
}

function note(e: FrameEntry, on: SwitchName | null): string | null {
	const parts: string[] = [];
	if (e.looped) parts.push("looped");
	const vlan = vlanNote(e, on);
	if (vlan) parts.push(vlan);
	if (e.flood === "group") parts.push(portList(e.to, on));
	if (e.flood === "unknown") parts.push(`unknown destination, ${portList(e.to, on)}`);
	for (const drop of e.dropped) parts.push(dropNote(e, drop, on));
	if (e.noReply) parts.push("no reply");
	return parts.length ? parts.join(" · ") : null;
}

/** The lab raises a link only when a machine comes up with a cable it did not have, so that is a plug-in, not a reconnect. */
function linkVerb(e: LinkEntry): string {
	if (e.dead) return e.dead.way === "in" ? "plugged in" : "unplugged";
	if (e.plug) return e.up ? "plugged in" : "unplugged";
	if (!e.up) return "cut";
	return e.cause === "runtime" ? "plugged in" : "reconnected";
}

const WHO: Readonly<Record<Exclude<Cause, "power">, string>> = {
	agent: "the agent",
	bar: "you",
	button: "you",
	cli: "the CLI",
	runtime: "the lab",
};

const DOING: Readonly<Record<NonNullable<DeadCable["machine"]>, string>> = {
	booting: "booting",
	stopping: "stopping",
	off: "off",
	restoring: "being restored",
};

/** `Cable to node3`, `Cut cable to node3`, `Cable to node3, which is off,`. */
function cableText({ dead }: LinkEntry, to: string): string {
	const cable = `${dead?.cut ? "Cut cable" : "Cable"} to ${to}`;
	return dead?.machine ? `${cable}, which is ${DOING[dead.machine]},` : cable;
}

function linkRow(e: LinkEntry, names: RowNames): LinkRow {
	const cable = nicLabel(e.machine, e.nic, names.severalNics(e.machine));
	const on = names.switchLabel(e.port.switch);
	return {
		kind: "link",
		seq: e.seq,
		time: seconds(e.t),
		...(on === null ? {} : { switch: on }),
		port: e.port.port,
		up: e.up,
		text: `${portText(on, e.port.port)} link ${e.up ? "up" : "down"}`,
		cause:
			e.cause === "power"
				? `${e.machine} ${e.up ? "booted" : "stopped"}.`
				: `${cableText(e, cable)} ${linkVerb(e)} by ${WHO[e.cause]}.`,
	};
}

function cableVerb(e: CableEntry): string {
	if (e.plug) return e.up ? "plugged in" : "unplugged";
	return e.up ? "reconnected" : "cut";
}

function cableRow(e: CableEntry, names: RowNames): CableRow {
	const [a, b] = e.ends.map(({ switch: on, port }) => portText(names.switchLabel(on), port));
	const who = e.cause === "power" ? WHO.runtime : WHO[e.cause];
	return {
		kind: "cable",
		seq: e.seq,
		time: seconds(e.t),
		ends: e.ends,
		up: e.up,
		text: `${a} and ${b} link ${e.up ? "up" : "down"}`,
		cause: `${e.cut ? "Cut cable" : "Cable"} between them ${cableVerb(e)} by ${who}.`,
	};
}

function stormRow(e: StormEntry): StormRow {
	const row = { kind: "storm", seq: e.seq, time: seconds(e.t), switch: e.switch, over: e.over } as const;
	if (!e.over) {
		const cause = "Frames that go round a loop of cables keep coming into it, until a cable of the loop is cut.";
		return { ...row, text: `${e.switch} is storming`, cause };
	}
	const took = `It took ${e.looped} looped frames in ${(e.ms / 1000).toFixed(1)} s`;
	const dropped = e.dropped === 0 ? "" : `, and did not send on ${e.dropped} more that the lab had no room for`;
	return { ...row, text: `${e.switch} storm over`, cause: `${took}${dropped}. It has forgotten its MAC table.` };
}

/** The footer, in the prototype's wording: `182 in · 183 delivered · 1 flooded`. */
export function formatCounters(c: CaptureCounters): string {
	return `${c.in} in · ${c.delivered} delivered · ${c.flooded} flooded`;
}
