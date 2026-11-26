// What the frame detail panel shows for one captured frame, as plain data:
// decoded groups, the switch's decision in words, and the hex dump with the
// bytes that name a machine marked by machine.

import type { FrameEntry, RowNames } from "../../capture/index.ts";
import { PORTS, type PortNo, type PortRef, portText } from "../../model/index.ts";
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
	nameOf,
	nicLabel,
	nicOfMac,
	onWire,
} from "../../net/index.ts";

/** Machine n, and how to write it: its name, or `node2:eth1` where the name alone does not say which NIC. */
export interface Named {
	readonly n: number;
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
	/** Whose the bytes are. */
	readonly n: number | null;
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
	/** One or two sentences on what the switch did with it. */
	readonly did: readonly Words[];
	readonly dump: readonly DumpRow[];
}

/** The lab as it is now, for naming what a frame's bytes point at. */
export interface LabNames extends RowNames {
	/** Which machine holds a port, if any. */
	holder(port: PortRef): Named | null;
	/** Whether the port carries the VLAN now. */
	carries(port: PortRef, vlan: number): boolean;
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
const named = (n: number, { names }: FrameEntry): Named => ({ n, label: nameOf(names, n) });

/** Which machine had the address when the frame was captured. */
function ipWho(ip: number, e: FrameEntry): Who {
	const at = e.names.addresses.get(ip);
	return at ? { kind: "machine", ...named(at.n, e) } : null;
}

function macNamed(e: FrameEntry, off: number, names: LabNames): Named | null {
	const at = nicOfMac(e.bytes, off);
	if (!at) return null;
	const name = nameOf(e.names, at.n);
	return { n: at.n, label: nicLabel(name, at.nic, names.severalNics(name)) };
}

function macWho(e: FrameEntry, off: number, names: LabNames): Who {
	if (macStr(e.bytes, off) === BROADCAST_MAC) return { kind: "everyone" };
	const at = macNamed(e, off, names);
	return at && { kind: "machine", ...at };
}

/** Byte ranges that are a machine's MAC or IPv4 address, by where the protocol puts them. */
function addressSpans(e: FrameEntry): { readonly start: number; readonly end: number; readonly n: number }[] {
	const f = e.bytes;
	const spans: { start: number; end: number; n: number }[] = [];
	const mac = (off: number) => {
		const at = nicOfMac(f, off);
		if (at) spans.push({ start: off, end: off + 6, n: at.n });
	};
	const ip = (off: number) => {
		const at = e.names.addresses.get(u32(f, off));
		if (at) spans.push({ start: off, end: off + 4, n: at.n });
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

/** `f` is the frame as it was on the wire: with a tag after its addresses, it is longer than `e.bytes` by the tag. */
function dump(e: FrameEntry, f: Uint8Array): DumpRow[] {
	const tag = f.length - e.bytes.length;
	const owner: (number | null)[] = new Array(f.length).fill(null);
	const starts = new Set<number>();
	for (const span of addressSpans(e)) {
		const start = span.start < 12 ? span.start : span.start + tag;
		owner.fill(span.n, start, start + span.end - span.start);
		starts.add(start);
	}
	const rows: DumpRow[] = [];
	for (let row = 0; row < f.length; row += 16) {
		const runs: { text: string; n: number | null }[] = [];
		for (let i = row; i < Math.min(row + 16, f.length); i++) {
			const last = runs[runs.length - 1];
			if (last && last.n === owner[i] && !starts.has(i)) last.text += ` ${hex(f[i], 2)}`;
			else runs.push({ text: hex(f[i], 2), n: owner[i] });
		}
		rows.push({ offset: hex(row, 4), runs });
	}
	return rows;
}

function groups(e: FrameEntry, names: LabNames): DetailGroup[] {
	const f = e.bytes;
	const type = ethertype(f);
	const out: DetailGroup[] = [
		{
			title: "ethernet II",
			fields: [
				field("destination", macStr(f, 0), isGroupMac(f) ? { kind: "everyone" } : macWho(e, 0, names)),
				field("source", macStr(f, 6), macWho(e, 6, names)),
				field("type", `0x${hex(Math.max(type, 0), 4)}${ETHERTYPES[type] ? ` ${ETHERTYPES[type]}` : ""}`),
			],
		},
	];

	if (e.tagged !== 0) {
		const on = PORTS.filter((p) => e.tagged & (1 << (p - 1))).map((p) => portWord(e, p, names));
		out.push({
			title: "802.1Q",
			fields: [
				field("vlan", e.vlan),
				field("tagged on", on.length === 1 ? on[0] : `${on.slice(0, -1).join(", ")} and ${on.at(-1)}`),
			],
		});
	}

	const arp = arpAddrs(f);
	if (arp) {
		out.push({
			title: arp.op === 1 ? "arp request" : arp.op === 2 ? "arp reply" : `arp opcode ${arp.op}`,
			fields: [
				field("sender mac", macStr(f, 22), macWho(e, 22, names)),
				field("sender ip", ip4str(arp.spa), ipWho(arp.spa, e)),
				field("target mac", macStr(f, 32), macWho(e, 32, names)),
				field("target ip", ip4str(arp.tpa), ipWho(arp.tpa, e)),
			],
		});
		return out;
	}

	const ip = ipAddrs(f);
	if (!ip) return out;
	out.push({
		title: "ipv4",
		fields: [
			field("source", ip4str(ip.src), ipWho(ip.src, e)),
			field("destination", ip4str(ip.dst), ipWho(ip.dst, e)),
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

/** `port 3`, or `lan port 3` in a lab with several switches. */
const portWord = (e: FrameEntry, port: PortNo, names: LabNames): string => portText(names.switchLabel(e.switch), port);

const atPort = (e: FrameEntry, port: PortNo, names: LabNames): Words => {
	const holder = names.holder({ switch: e.switch, port });
	return holder ? [holder, ` on ${portWord(e, port, names)}`] : [portWord(e, port, names)];
};

/** The destination by name if the lab can name it, else its raw MAC. */
function destination(e: FrameEntry, names: LabNames): Words {
	const f = e.bytes;
	const ip = ipAddrs(f);
	const byIp = ip ? e.names.addresses.get(ip.dst) : undefined;
	return [macNamed(e, 0, names) ?? (byIp ? named(byIp.n, e) : macStr(f, 0))];
}

function did(e: FrameEntry, names: LabNames): Words[] {
	const delivered = PORTS.filter((p) => e.to & (1 << (p - 1)));
	const reached = list(delivered.map((p) => atPort(e, p, names)));
	const f = e.bytes;

	if (e.flood === null) {
		const [only] = delivered;
		if (only === undefined) {
			return [
				sentence(
					`${e.switch} did not deliver it: the address it learned for `,
					...destination(e, names),
					` leads back to ${portWord(e, e.from, names)} or to a port that is down.`,
				),
			];
		}
		return [
			sentence(
				`${e.switch} had learned `,
				...destination(e, names),
				` on ${portWord(e, only, names)}, so it forwarded the frame there only.`,
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
					`${e.switch} did not know where `,
					...destination(e, names),
					" is, so it flooded the frame",
					...(delivered.length ? [": delivered to ", ...reached, "."] : [", but no other port was up."]),
				);

	const others = PORTS.filter((p) => p !== e.from && !delivered.includes(p)).flatMap((p) => {
		const holder = names.holder({ switch: e.switch, port: p });
		return holder ? [{ port: p, holder, apart: !names.carries({ switch: e.switch, port: p }, e.vlan) }] : [];
	});
	const label = names.switchLabel(e.switch);
	const on = label === null ? "Port" : `${label} port`;
	const why = (missed: typeof others, was: string, were: string): Words[] => {
		if (missed.length === 0) return [];
		return [
			sentence(
				missed.length === 1 ? `${on} ` : `${on}s `,
				...list(missed.map((m) => [String(m.port)])),
				missed.length === 1 ? was : were,
				...list(missed.map((m) => [m.holder])),
				" never saw it.",
			),
		];
	};
	return [
		first,
		...why(
			others.filter((m) => !m.apart),
			" was down, so ",
			" were down, so ",
		),
		...why(
			others.filter((m) => m.apart),
			` is not in vlan ${e.vlan}, so `,
			` are not in vlan ${e.vlan}, so `,
		),
	];
}

export function frameDetail(e: FrameEntry, names: LabNames): FrameDetail {
	// As it came in, as the summary says, so the bytes have the tag that it had there.
	const wire = onWire(e.bytes, e.vlan, e.tagged, e.from);
	return {
		title: `frame ${e.seq}`,
		summary: [
			`${wire.length} bytes`,
			`${(e.t / 1000).toFixed(2)} s`,
			`in on ${portWord(e, e.from, names)}`,
			...(e.vlan !== 1 || e.tagged !== 0 ? [`vlan ${e.vlan}`] : []),
		].join(" · "),
		groups: groups(e, names),
		did: did(e, names),
		dump: dump(e, wire),
	};
}
