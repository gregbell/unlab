// What the frame detail panel shows for one captured frame, as plain data:
// decoded groups, the switch's decision in words, and the hex dump with the
// bytes that name a machine marked by machine.

import type { FrameEntry } from "../../capture/index.ts";
import { type MachineName, PORTS, type PortNo, SWITCH_NAME } from "../../model/index.ts";
import {
	arpAddrs,
	BROADCAST_MAC,
	ETH_ARP,
	ETH_HDR,
	ETH_IPV4,
	ETH_IPV6,
	ethertype,
	IP_ICMP,
	IP_TCP,
	IP_UDP,
	ip4str,
	ipAddrs,
	isGroupMac,
	macStr,
	nicOfMac,
	nodeNicLabel,
	nodeOfIp,
	nodeOfMac,
} from "../../net/index.ts";

/** A machine, and how to write it: its name, or `node2:eth1` where the name alone does not say which NIC. */
export interface Named {
	readonly machine: MachineName;
	readonly label: string;
}

export type Who = ({ readonly kind: "machine" } & Named) | { readonly kind: "everyone" } | null;

export interface DetailField {
	readonly label: string;
	readonly value: string;
	/** Who the value names, shown after it. */
	readonly who: Who;
}

export interface DetailGroup {
	readonly title: string;
	readonly fields: readonly DetailField[];
}

/** A sentence whose machine names are painted in their hues. */
export type Words = readonly (string | Named)[];

export interface DumpRun {
	/** Space-separated hex bytes. */
	readonly text: string;
	readonly machine: MachineName | null;
}

export interface DumpRow {
	readonly offset: string;
	readonly runs: readonly DumpRun[];
}

export interface FrameDetail {
	/** `frame 189`. */
	readonly title: string;
	/** `42 bytes · 1618.52 s · in on port 1`. */
	readonly summary: string;
	/** `ethernet II`, then the protocols it carries. */
	readonly groups: readonly DetailGroup[];
	/** One or two sentences on what switch0 did with it. */
	readonly did: readonly Words[];
	readonly dump: readonly DumpRow[];
}

/** The lab as it is now, for naming what a frame's bytes point at. */
export interface LabNames {
	/** Which machine holds a port, if any. */
	holder(port: PortNo): Named | null;
	severalNics(machine: MachineName): boolean;
}

const ICMP_TYPES: Readonly<Record<number, string>> = {
	0: "echo reply",
	3: "destination unreachable",
	5: "redirect",
	8: "echo request",
	11: "time exceeded",
};

const ETHERTYPES: Readonly<Record<number, string>> = { [ETH_ARP]: "ARP", [ETH_IPV4]: "IPv4", [ETH_IPV6]: "IPv6" };
const IP_PROTOCOLS: Readonly<Record<number, string>> = { [IP_ICMP]: "ICMP", [IP_TCP]: "TCP", [IP_UDP]: "UDP" };
const TCP_FLAGS: readonly (readonly [number, string])[] = [
	[0x02, "S"],
	[0x10, "."],
	[0x08, "P"],
	[0x01, "F"],
	[0x04, "R"],
	[0x20, "U"],
];

const u16 = (f: Uint8Array, o: number): number => (f[o] << 8) | f[o + 1];
const u32 = (f: Uint8Array, o: number): number => ((f[o] << 24) | (f[o + 1] << 16) | (f[o + 2] << 8) | f[o + 3]) >>> 0;
const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

const field = (label: string, value: string | number, who: Who = null): DetailField => ({
	label,
	value: String(value),
	who,
});
const named = (machine: MachineName): Named => ({ machine, label: machine });
const machine = (name: MachineName | null): Who => (name ? { kind: "machine", ...named(name) } : null);

function macNamed(f: Uint8Array, off: number, names: LabNames): Named | null {
	const at = nicOfMac(f, off);
	return at && { machine: at.node, label: nodeNicLabel(at, names.severalNics(at.node)) };
}

function macWho(f: Uint8Array, off: number, names: LabNames): Who {
	if (macStr(f, off) === BROADCAST_MAC) return { kind: "everyone" };
	const at = macNamed(f, off, names);
	return at && { kind: "machine", ...at };
}

/** Byte ranges that are a machine's MAC or IPv4 address, by where the protocol puts them. */
function addressSpans(f: Uint8Array): { readonly start: number; readonly end: number; readonly name: MachineName }[] {
	const spans: { start: number; end: number; name: MachineName }[] = [];
	const mac = (off: number) => {
		const name = f.length >= off + 6 ? nodeOfMac(f, off) : null;
		if (name) spans.push({ start: off, end: off + 6, name });
	};
	const ip = (off: number) => {
		const name = nodeOfIp(u32(f, off));
		if (name) spans.push({ start: off, end: off + 4, name });
	};
	mac(0);
	mac(6);
	if (arpAddrs(f)) {
		mac(22);
		ip(28);
		mac(32);
		ip(38);
	} else if (ipAddrs(f)) {
		ip(ETH_HDR + 12);
		ip(ETH_HDR + 16);
	}
	return spans;
}

function dump(f: Uint8Array): DumpRow[] {
	const owner: (MachineName | null)[] = new Array(f.length).fill(null);
	const starts = new Set<number>();
	for (const { start, end, name } of addressSpans(f)) {
		owner.fill(name, start, end);
		starts.add(start);
	}
	const rows: DumpRow[] = [];
	for (let row = 0; row < f.length; row += 16) {
		const runs: { text: string; machine: MachineName | null }[] = [];
		for (let i = row; i < Math.min(row + 16, f.length); i++) {
			const last = runs[runs.length - 1];
			if (last && last.machine === owner[i] && !starts.has(i)) last.text += ` ${hex(f[i], 2)}`;
			else runs.push({ text: hex(f[i], 2), machine: owner[i] });
		}
		rows.push({ offset: hex(row, 4), runs });
	}
	return rows;
}

function groups(f: Uint8Array, names: LabNames): DetailGroup[] {
	const type = ethertype(f);
	const out: DetailGroup[] = [
		{
			title: "ethernet II",
			fields: [
				field("destination", macStr(f, 0), isGroupMac(f) ? { kind: "everyone" } : macWho(f, 0, names)),
				field("source", macStr(f, 6), macWho(f, 6, names)),
				field("type", `0x${hex(Math.max(type, 0), 4)}${ETHERTYPES[type] ? ` ${ETHERTYPES[type]}` : ""}`),
			],
		},
	];

	const arp = arpAddrs(f);
	if (arp) {
		out.push({
			title: arp.op === 1 ? "arp request" : arp.op === 2 ? "arp reply" : `arp opcode ${arp.op}`,
			fields: [
				field("sender mac", macStr(f, 22), macWho(f, 22, names)),
				field("sender ip", ip4str(arp.spa), machine(nodeOfIp(arp.spa))),
				field("target mac", macStr(f, 32), macWho(f, 32, names)),
				field("target ip", ip4str(arp.tpa), machine(nodeOfIp(arp.tpa))),
			],
		});
		return out;
	}

	const ip = ipAddrs(f);
	if (!ip) return out;
	out.push({
		title: "ipv4",
		fields: [
			field("source", ip4str(ip.src), machine(nodeOfIp(ip.src))),
			field("destination", ip4str(ip.dst), machine(nodeOfIp(ip.dst))),
			field("ttl", f[ETH_HDR + 8]),
			field("protocol", `${ip.proto}${IP_PROTOCOLS[ip.proto] ? ` ${IP_PROTOCOLS[ip.proto]}` : ""}`),
		],
	});
	const o = ETH_HDR + ip.ihl;
	if (ip.proto === IP_ICMP && f.length >= o + 8) {
		const kind = ICMP_TYPES[f[o]];
		out.push({
			title: kind ? `icmp ${kind}` : "icmp",
			fields: [field("type", f[o]), field("code", f[o + 1]), field("id", u16(f, o + 4)), field("seq", u16(f, o + 6))],
		});
	} else if (ip.proto === IP_UDP && f.length >= o + 8) {
		out.push({
			title: "udp",
			fields: [
				field("source port", u16(f, o)),
				field("destination port", u16(f, o + 2)),
				field("length", u16(f, o + 4)),
			],
		});
	} else if (ip.proto === IP_TCP && f.length >= o + 14) {
		const bits = f[o + 13];
		const flags = TCP_FLAGS.filter(([bit]) => bits & bit).map(([, letter]) => letter);
		out.push({
			title: "tcp",
			fields: [
				field("source port", u16(f, o)),
				field("destination port", u16(f, o + 2)),
				field("flags", `[${flags.join("") || "."}]`),
				field("seq", u32(f, o + 4)),
			],
		});
	}
	return out;
}

/** `a`, `a and b`, `a, b and c`, each item already a run of words. */
function list(items: readonly Words[]): Words {
	return items.flatMap((item, i) => [i === 0 ? "" : i === items.length - 1 ? " and " : ", ", ...item]);
}

/** Joins adjacent strings, so a sentence compares and renders as few pieces as it has. */
function sentence(...parts: Words): Words {
	const out: (string | Named)[] = [];
	for (const part of parts) {
		const last = out[out.length - 1];
		if (typeof part === "string" && typeof last === "string") out[out.length - 1] = last + part;
		else if (part !== "") out.push(part);
	}
	return out;
}

const atPort = (port: PortNo, names: LabNames): Words => {
	const holder = names.holder(port);
	return holder ? [holder, ` on port ${port}`] : [`port ${port}`];
};

/** The destination by name if the lab can name it, else its raw MAC. */
function destination(f: Uint8Array, names: LabNames): Words {
	const ip = ipAddrs(f);
	const byIp = ip ? nodeOfIp(ip.dst) : null;
	return [macNamed(f, 0, names) ?? (byIp ? named(byIp) : macStr(f, 0))];
}

function did(e: FrameEntry, names: LabNames): Words[] {
	const delivered = PORTS.filter((p) => e.to & (1 << (p - 1)));
	const reached = list(delivered.map((p) => atPort(p, names)));
	const f = e.bytes;

	if (e.flood === null) {
		const [only] = delivered;
		if (only === undefined) {
			return [
				sentence(
					`${SWITCH_NAME} did not deliver it: the address it learned for `,
					...destination(f, names),
					` leads back to port ${e.from} or to a port that is down.`,
				),
			];
		}
		return [
			sentence(
				`${SWITCH_NAME} had learned `,
				...destination(f, names),
				` on port ${only}, so it forwarded the frame there only.`,
			),
		];
	}

	const first =
		e.flood === "group"
			? sentence(
					`${macStr(f, 0) === BROADCAST_MAC ? "Broadcast" : "Multicast"}, so sent out every live port`,
					...(delivered.length ? [": delivered to ", ...reached, "."] : [", but no other port was up."]),
				)
			: sentence(
					`${SWITCH_NAME} did not know where `,
					...destination(f, names),
					" is, so it flooded the frame",
					...(delivered.length ? [": delivered to ", ...reached, "."] : [", but no other port was up."]),
				);

	const missed = PORTS.filter((p) => p !== e.from && !delivered.includes(p)).flatMap((p) => {
		const holder = names.holder(p);
		return holder ? [{ port: p, holder }] : [];
	});
	if (missed.length === 0) return [first];
	const portWords = missed.map((m) => [String(m.port)]);
	const second = sentence(
		missed.length === 1 ? "Port " : "Ports ",
		...list(portWords),
		missed.length === 1 ? " was down, so " : " were down, so ",
		...list(missed.map((m) => [m.holder])),
		" never saw it.",
	);
	return [first, second];
}

export function frameDetail(e: FrameEntry, names: LabNames): FrameDetail {
	return {
		title: `frame ${e.seq}`,
		summary: `${e.bytes.length} bytes · ${(e.t / 1000).toFixed(2)} s · in on port ${e.from}`,
		groups: groups(e.bytes, names),
		did: did(e, names),
		dump: dump(e.bytes),
	};
}
