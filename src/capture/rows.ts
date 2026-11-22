// What a capture row shows, built from an entry only when the row is on
// screen: decoding runs per visible row, never per frame.

import type { Cause, MachineName, PortNo } from "../model/types.ts";
import { arpAddrs, decode, ipAddrs, isGroupMac, nodeOfIp, nodeOfMac } from "../net/index.ts";
import type { CaptureCounters, CaptureEntry, FrameEntry, LinkEntry } from "./log.ts";

/** A machine name (painted in its hue while the machine exists), broadcast, or an address the lab cannot name. */
export type RouteEnd =
	| { readonly kind: "machine"; readonly name: MachineName }
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
	/** `Cable to node3 cut by the agent.` */
	readonly cause: string;
}

export type CaptureRow = FrameRow | LinkRow;

export function captureRow(e: CaptureEntry): CaptureRow {
	return e.kind === "frame" ? frameRow(e) : linkRow(e);
}

const seconds = (ms: number): string => (ms / 1000).toFixed(2);

function frameRow(e: FrameEntry): FrameRow {
	const d = decode(e.bytes);
	return {
		kind: "frame",
		seq: e.seq,
		time: seconds(e.t),
		proto: d.proto,
		from: routeEnd(e.bytes, "src", d.src),
		to: isGroupMac(e.bytes) ? { kind: "everyone" } : routeEnd(e.bytes, "dst", d.dst),
		len: e.bytes.length,
		info: d.info,
		note: note(e),
	};
}

function routeEnd(f: Uint8Array, end: "src" | "dst", raw: string): RouteEnd {
	const name = nodeOfMac(f, end === "src" ? 6 : 0) ?? nodeOfAddress(f, end);
	return name ? { kind: "machine", name } : { kind: "raw", text: raw };
}

function nodeOfAddress(f: Uint8Array, end: "src" | "dst"): MachineName | null {
	const ip = ipAddrs(f);
	if (ip) return nodeOfIp(end === "src" ? ip.src : ip.dst);
	const arp = arpAddrs(f);
	if (arp) return nodeOfIp(end === "src" ? arp.spa : arp.tpa);
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

const WHO: Readonly<Record<Cause, string>> = { agent: "the agent", bar: "you", button: "you", runtime: "the lab" };

function linkRow(e: LinkEntry): LinkRow {
	return {
		kind: "link",
		seq: e.seq,
		time: seconds(e.t),
		port: e.port,
		up: e.up,
		text: `port ${e.port} link ${e.up ? "up" : "down"}`,
		cause: `Cable to ${e.machine} ${e.up ? "reconnected" : "cut"} by ${WHO[e.cause]}.`,
	};
}

/** The footer, in the prototype's wording: `182 in · 183 delivered · 1 flooded`. */
export function formatCounters(c: CaptureCounters): string {
	return `${c.in} in · ${c.delivered} delivered · ${c.flooded} flooded`;
}
