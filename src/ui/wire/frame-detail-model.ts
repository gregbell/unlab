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
	nodeOfIp,
	nodeOfMac,
} from "../../net/index.ts";

export type Who = { readonly kind: "machine"; readonly name: MachineName } | { readonly kind: "everyone" } | null;

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
export type Words = readonly (string | { readonly machine: MachineName })[];

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

/** Which machine holds a port now, if any. */
export type PortHolder = (port: PortNo) => MachineName | null;

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
const machine = (name: MachineName | null): Who => (name ? { kind: "machine", name } : null);
const macWho = (f: Uint8Array, off: number): Who =>
	macStr(f, off) === BROADCAST_MAC ? { kind: "everyone" } : machine(nodeOfMac(f, off));

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

function groups(f: Uint8Array): DetailGroup[] {
	const type = ethertype(f);
	const out: DetailGroup[] = [
		{
			title: "ethernet II",
			fields: [
				field("destination", macStr(f, 0), isGroupMac(f) ? { kind: "everyone" } : macWho(f, 0)),
				field("source", macStr(f, 6), macWho(f, 6)),
				field("type", `0x${hex(Math.max(type, 0), 4)}${ETHERTYPES[type] ? ` ${ETHERTYPES[type]}` : ""}`),
			],
		},
	];

	const arp = arpAddrs(f);
	if (arp) {
		out.push({
			title: arp.op === 1 ? "arp request" : arp.op === 2 ? "arp reply" : `arp opcode ${arp.op}`,
			fields: [
				field("sender mac", macStr(f, 22), macWho(f, 22)),
				field("sender ip", ip4str(arp.spa), machine(nodeOfIp(arp.spa))),
				field("target mac", macStr(f, 32), macWho(f, 32)),
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
	const out: (string | { readonly machine: MachineName })[] = [];
	for (const part of parts) {
		const last = out[out.length - 1];
		if (typeof part === "string" && typeof last === "string") out[out.length - 1] = last + part;
		else if (part !== "") out.push(part);
	}
	return out;
}

const atPort = (port: PortNo, holder: PortHolder): Words => {
	const name = holder(port);
	return name ? [{ machine: name }, ` on port ${port}`] : [`port ${port}`];
};

/** The destination by name if the lab can name it, else its raw MAC. */
function destination(f: Uint8Array): Words {
	const ip = ipAddrs(f);
	const name = nodeOfMac(f, 0) ?? (ip ? nodeOfIp(ip.dst) : null);
	return [name ? { machine: name } : macStr(f, 0)];
}

function did(e: FrameEntry, holder: PortHolder): Words[] {
	const delivered = PORTS.filter((p) => e.to & (1 << (p - 1)));
	const reached = list(delivered.map((p) => atPort(p, holder)));
	const f = e.bytes;

	if (e.flood === null) {
		const [only] = delivered;
		if (only === undefined) {
			return [
				sentence(
					`${SWITCH_NAME} did not deliver it: the address it learned for `,
					...destination(f),
					` leads back to port ${e.from} or to a port that is down.`,
				),
			];
		}
		return [
			sentence(
				`${SWITCH_NAME} had learned `,
				...destination(f),
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
					...destination(f),
					" is, so it flooded the frame",
					...(delivered.length ? [": delivered to ", ...reached, "."] : [", but no other port was up."]),
				);

	const missed = PORTS.filter((p) => p !== e.from && !delivered.includes(p)).flatMap((p) => {
		const name = holder(p);
		return name ? [{ port: p, name }] : [];
	});
	if (missed.length === 0) return [first];
	const portWords = missed.map((m) => [String(m.port)]);
	const second = sentence(
		missed.length === 1 ? "Port " : "Ports ",
		...list(portWords),
		missed.length === 1 ? " was down, so " : " were down, so ",
		...list(missed.map((m) => [{ machine: m.name }])),
		" never saw it.",
	);
	return [first, second];
}

export function frameDetail(e: FrameEntry, holder: PortHolder): FrameDetail {
	return {
		title: `frame ${e.seq}`,
		summary: `${e.bytes.length} bytes · ${(e.t / 1000).toFixed(2)} s · in on port ${e.from}`,
		groups: groups(e.bytes),
		did: did(e, holder),
		dump: dump(e.bytes),
	};
}
