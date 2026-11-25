// What a capture row shows, built from an entry only when the row is on
// screen: decoding runs per visible row, never per frame.

import { type Cause, type MachineName, type PortNo, portText, type SwitchName } from "../model/index.ts";
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
import type { CaptureCounters, CaptureEntry, FrameEntry, LinkEntry } from "./log.ts";

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
	/** The one that carried it, when there are several. */
	readonly switch?: SwitchName;
	/** Seconds since the lab started, two decimals. */
	readonly time: string;
	readonly proto: string;
	readonly from: RouteEnd;
	readonly to: RouteEnd;
	readonly len: number;
	readonly info: string;
	/** The lab's commentary after the info, or null. */
	readonly note: string | null;
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

export type CaptureRow = FrameRow | LinkRow;

export function captureRow(e: CaptureEntry, names: RowNames = PLAIN_NAMES): CaptureRow {
	return e.kind === "frame" ? frameRow(e, names) : linkRow(e, names);
}

const seconds = (ms: number): string => (ms / 1000).toFixed(2);

function frameRow(e: FrameEntry, names: RowNames): FrameRow {
	const d = decode(e.bytes);
	const on = names.switchLabel(e.switch);
	return {
		kind: "frame",
		seq: e.seq,
		...(on === null ? {} : { switch: on }),
		time: seconds(e.t),
		proto: d.proto,
		from: routeEnd(e, "src", d.src, names),
		to: isGroupMac(e.bytes) ? { kind: "everyone" } : routeEnd(e, "dst", d.dst, names),
		len: e.bytes.length,
		info: d.info,
		note: note(e, on),
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

function portList(mask: number, on: SwitchName | null): string {
	const of = on === null ? "" : `${on} `;
	const ports: number[] = [];
	for (let p = 1; p <= 8; p++) if (mask & (1 << (p - 1))) ports.push(p);
	if (ports.length === 0) return `flooded, no other ${of}port is up`;
	if (ports.length === 1) return `flooded to ${of}port ${ports[0]}`;
	return `flooded to ${of}ports ${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}`;
}

function note(e: FrameEntry, on: SwitchName | null): string | null {
	const parts: string[] = [];
	if (e.flood === "group") parts.push(portList(e.to, on));
	if (e.flood === "unknown") parts.push(`unknown destination, ${portList(e.to, on)}`);
	if (e.noReply) parts.push("no reply");
	return parts.length ? parts.join(" · ") : null;
}

/** The lab raises a link only when a machine comes up with a cable it did not have, so that is a plug-in, not a reconnect. */
function linkVerb(e: LinkEntry): string {
	if (e.plug) return e.up ? "plugged in" : "unplugged";
	if (!e.up) return "cut";
	return e.cause === "runtime" ? "plugged in" : "reconnected";
}

const WHO: Readonly<Record<Exclude<Cause, "power">, string>> = {
	agent: "the agent",
	bar: "you",
	button: "you",
	runtime: "the lab",
};

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
				: `Cable to ${cable} ${linkVerb(e)} by ${WHO[e.cause]}.`,
	};
}

/** The footer, in the prototype's wording: `182 in · 183 delivered · 1 flooded`. */
export function formatCounters(c: CaptureCounters): string {
	return `${c.in} in · ${c.delivered} delivered · ${c.flooded} flooded`;
}
