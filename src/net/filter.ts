// The capture filter. Terms separated by spaces must all match; the word `or`
// separates alternatives. A term is a protocol, a machine name (either end, by
// any of its MACs or the addresses the lab set), one of its NICs (`node2:eth1`,
// by its MAC alone), an IPv4 address, a MAC address, or `port:N`, matched
// without regard to case.
//
// It compiles to predicates over raw bytes and port numbers, because capture
// tests every frame the switch handles: no decoding and no strings per frame.

import { parseIp4 } from "./address.ts";
import { ETH_ARP, ETH_HDR, ETH_IPV4, ETH_IPV6, IP_ICMP, IP_TCP, IP_UDP } from "./frames.ts";
import {
	type MachineName,
	type NameBook,
	type NicNo,
	type NodeNic,
	nameOf,
	nicOfMac,
	parseDefaultName,
	parseNicName,
} from "./identity.ts";

export interface CaptureFilter {
	/** As typed. */
	readonly source: string;
	/**
	 * `to` is the egress port mask: bit p-1 is set when the frame went out of
	 * port p. `names` is who was who when the frame was captured.
	 */
	matchesFrame(frame: Uint8Array, from: number, to: number, names: NameBook): boolean;
	/**
	 * A link event row is context, so protocol terms never hide it. Port,
	 * machine, NIC, address and MAC terms keep only the rows about that port,
	 * machine or NIC.
	 */
	matchesLink(port: number, machine: MachineName, nic: NicNo, names: NameBook): boolean;
}

export interface FilterError {
	/** The token as typed, and its character range in the source. */
	readonly token: string;
	readonly start: number;
	readonly end: number;
	readonly message: string;
}

export type FilterResult =
	| { readonly ok: true; readonly filter: CaptureFilter }
	| { readonly ok: false; readonly error: FilterError };

type FramePredicate = (f: Uint8Array, from: number, to: number, names: NameBook) => boolean;
type LinkPredicate = (port: number, machine: MachineName, nic: NicNo, names: NameBook) => boolean;
interface Term {
	readonly frame: FramePredicate;
	readonly link: LinkPredicate;
}

const ethertype = (f: Uint8Array): number => (f.length < ETH_HDR ? -1 : (f[12] << 8) | f[13]);
const isIpv4 = (f: Uint8Array): boolean =>
	f.length >= ETH_HDR + 20 && ethertype(f) === ETH_IPV4 && f[ETH_HDR] >> 4 === 4;
const isArp = (f: Uint8Array): boolean => f.length >= ETH_HDR + 28 && ethertype(f) === ETH_ARP;
const ipProto = (f: Uint8Array): number => (isIpv4(f) ? f[ETH_HDR + 9] : -1);
const u32 = (f: Uint8Array, o: number): number => ((f[o] << 24) | (f[o + 1] << 16) | (f[o + 2] << 8) | f[o + 3]) >>> 0;

function l4Uses(f: Uint8Array, proto: number, ...ports: number[]): boolean {
	if (ipProto(f) !== proto) return false;
	const o = ETH_HDR + (f[ETH_HDR] & 15) * 4;
	if (f.length < o + 4) return false;
	const sport = (f[o] << 8) | f[o + 1];
	const dport = (f[o + 2] << 8) | f[o + 3];
	return ports.includes(sport) || ports.includes(dport);
}

/** Whether either of the IPv4 addresses the frame is about passes. */
function someIp(f: Uint8Array, test: (ip: number) => boolean): boolean {
	if (isIpv4(f)) return test(u32(f, ETH_HDR + 12)) || test(u32(f, ETH_HDR + 16));
	if (isArp(f)) return test(u32(f, 28)) || test(u32(f, 38));
	return false;
}

function macAt(f: Uint8Array, off: number, mac: Uint8Array): boolean {
	for (let i = 0; i < 6; i++) if (f[off + i] !== mac[i]) return false;
	return true;
}
const hasMac = (f: Uint8Array, mac: Uint8Array): boolean => f.length >= 12 && (macAt(f, 0, mac) || macAt(f, 6, mac));

/** Whether the NIC at either end passes. */
function someNic(f: Uint8Array, test: (at: NodeNic) => boolean): boolean {
	const to = nicOfMac(f, 0);
	if (to && test(to)) return true;
	const from = nicOfMac(f, 6);
	return from !== null && test(from);
}

const always: LinkPredicate = () => true;
const ipv4: FramePredicate = isIpv4;

const PROTOCOLS: ReadonlyMap<string, FramePredicate> = new Map([
	["arp", (f) => ethertype(f) === ETH_ARP],
	["ip", ipv4],
	["ipv4", ipv4],
	["ipv6", (f) => ethertype(f) === ETH_IPV6],
	["icmp", (f) => ipProto(f) === IP_ICMP],
	["tcp", (f) => ipProto(f) === IP_TCP],
	["udp", (f) => ipProto(f) === IP_UDP],
	["dhcp", (f) => l4Uses(f, IP_UDP, 67, 68)],
	["dns", (f) => l4Uses(f, IP_UDP, 53) || l4Uses(f, IP_TCP, 53)],
]);

const OR = "or";
const PORT_WORD = "port";
const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/;
const PORT = new RegExp(`^${PORT_WORD}:([1-8])$`);

/** The words a filter reads as something other than a machine. */
export const FILTER_WORDS: readonly string[] = [...PROTOCOLS.keys(), OR, PORT_WORD];

/** `node<n>` is the lab's whether or not machine n has been there. */
function isMachine(word: string, { names }: NameBook): boolean {
	if (parseDefaultName(word) !== null) return true;
	for (const name of names.values()) if (name === word) return true;
	return false;
}

function parseTerm(word: string, known: NameBook): Term | null {
	const protocol = PROTOCOLS.get(word);
	if (protocol) return { frame: protocol, link: always };

	const port = PORT.exec(word);
	if (port) {
		const p = Number(port[1]);
		const mask = 1 << (p - 1);
		return { frame: (_f, from, to) => from === p || (to & mask) !== 0, link: (q) => q === p };
	}

	const colon = word.indexOf(":");
	const name = colon < 0 ? word : word.slice(0, colon);
	if (isMachine(name, known)) {
		if (colon < 0) {
			return {
				frame(f, _from, _to, names) {
					const isNamed = (at: NodeNic | undefined) => at !== undefined && nameOf(names, at.n) === name;
					return someNic(f, isNamed) || someIp(f, (ip) => isNamed(names.addresses.get(ip)));
				},
				link: (_p, m) => m === name,
			};
		}
		const nic = parseNicName(word.slice(colon + 1));
		if (nic !== null) {
			return {
				frame: (f, _from, _to, names) => someNic(f, (at) => at.nic === nic && nameOf(names, at.n) === name),
				link: (_p, m, k) => m === name && k === nic,
			};
		}
	}

	const ip = parseIp4(word);
	if (ip !== null) {
		return {
			frame: (f) => someIp(f, (other) => other === ip),
			link(_p, m, k, names) {
				const at = names.addresses.get(ip);
				return at !== undefined && m === nameOf(names, at.n) && k === at.nic;
			},
		};
	}

	if (MAC.test(word)) {
		const mac = Uint8Array.from(word.split(/[:-]/), (h) => Number.parseInt(h, 16));
		const at = nicOfMac(mac, 0);
		return {
			frame: (f) => hasMac(f, mac),
			link: (_p, m, k, names) => at !== null && m === nameOf(names, at.n) && k === at.nic,
		};
	}

	return null;
}

/** `known` is who is who now, so that a word that names no machine is not taken for one. */
export function compileFilter(source: string, known: NameBook): FilterResult {
	const groups: Term[][] = [[]];
	let lastOr: { token: string; start: number } | null = null;
	const orError = (token: string, start: number): FilterResult => ({
		ok: false,
		error: { token, start, end: start + token.length, message: "Capture needs a term on each side of or." },
	});

	for (const m of source.matchAll(/\S+/g)) {
		const token = m[0];
		const start = m.index;
		const word = token.toLowerCase();
		const group = groups[groups.length - 1];
		if (word === OR) {
			if (group.length === 0) return orError(token, start);
			groups.push([]);
			lastOr = { token, start };
			continue;
		}
		const term = parseTerm(word, known);
		if (!term) {
			return {
				ok: false,
				error: { token, start, end: start + token.length, message: `Capture cannot read ${token}.` },
			};
		}
		group.push(term);
	}
	if (lastOr && groups[groups.length - 1].length === 0) return orError(lastOr.token, lastOr.start);

	const alternatives = groups[0].length === 0 ? [] : groups;
	return { ok: true, filter: filterOf(source, alternatives) };
}

function filterOf(source: string, groups: readonly (readonly Term[])[]): CaptureFilter {
	const frames = groups.map((g) => g.map((t) => t.frame));
	const links = groups.map((g) => g.map((t) => t.link));
	return {
		source,
		matchesFrame(f, from, to, names) {
			if (frames.length === 0) return true;
			outer: for (const group of frames) {
				for (const test of group) if (!test(f, from, to, names)) continue outer;
				return true;
			}
			return false;
		},
		matchesLink(port, machine, nic, names) {
			if (links.length === 0) return true;
			return links.some((group) => group.every((test) => test(port, machine, nic, names)));
		},
	};
}

/** The empty filter. */
export const MATCH_ALL: CaptureFilter = filterOf("", []);
