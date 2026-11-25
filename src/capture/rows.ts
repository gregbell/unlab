// What a capture row shows, built from an entry only when the row is on
// screen: decoding runs per visible row, never per frame.

import type { Cause, MachineName, PortNo } from "../model/index.ts";
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

/** Whether a machine has more than one NIC, so that its name alone does not say which. */
export type HasSeveralNics = (machine: MachineName) => boolean;

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
	readonly port: PortNo;
	readonly up: boolean;
	/** `port 3 link down`. */
	readonly text: string;
	/** `Cable to node3 cut by the agent.`, or `node3 stopped.` */
	readonly cause: string;
}

export type CaptureRow = FrameRow | LinkRow;

export function captureRow(e: CaptureEntry, several: HasSeveralNics = () => false): CaptureRow {
	return e.kind === "frame" ? frameRow(e, several) : linkRow(e, several);
}

const seconds = (ms: number): string => (ms / 1000).toFixed(2);

function frameRow(e: FrameEntry, several: HasSeveralNics): FrameRow {
	const d = decode(e.bytes);
	return {
		kind: "frame",
		seq: e.seq,
		time: seconds(e.t),
		proto: d.proto,
		from: routeEnd(e, "src", d.src, several),
		to: isGroupMac(e.bytes) ? { kind: "everyone" } : routeEnd(e, "dst", d.dst, several),
		len: e.bytes.length,
		info: d.info,
		note: note(e),
	};
}

/** By the MAC, which says which NIC, or by the IP address when the guest changed its MAC. */
function routeEnd(e: FrameEntry, end: "src" | "dst", raw: string, several: HasSeveralNics): RouteEnd {
	const at = nicOfMac(e.bytes, end === "src" ? 6 : 0);
	if (at) {
		const name = nameOf(e.names, at.n);
		const shown = at.nic > 0 || several(name);
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

function portList(mask: number): string {
	const ports: number[] = [];
	for (let p = 1; p <= 8; p++) if (mask & (1 << (p - 1))) ports.push(p);
	if (ports.length === 0) return "flooded, no other port is up";
	if (ports.length === 1) return `flooded to port ${ports[0]}`;
	return `flooded to ports ${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1]}`;
}

function note(e: FrameEntry): string | null {
	const parts: string[] = [];
	if (e.flood === "group") parts.push(portList(e.to));
	if (e.flood === "unknown") parts.push(`unknown destination, ${portList(e.to)}`);
	if (e.noReply) parts.push("no reply");
	return parts.length ? parts.join(" · ") : null;
}

/** The lab raises a link only when a machine comes up with a cable it did not have, so that is a plug-in, not a reconnect. */
function linkVerb(e: LinkEntry): string {
	if (!e.up) return "cut";
	return e.cause === "runtime" ? "plugged in" : "reconnected";
}

const WHO: Readonly<Record<Exclude<Cause, "power">, string>> = {
	agent: "the agent",
	bar: "you",
	button: "you",
	runtime: "the lab",
};

function linkRow(e: LinkEntry, several: HasSeveralNics): LinkRow {
	const cable = nicLabel(e.machine, e.nic, several(e.machine));
	return {
		kind: "link",
		seq: e.seq,
		time: seconds(e.t),
		port: e.port,
		up: e.up,
		text: `port ${e.port} link ${e.up ? "up" : "down"}`,
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
