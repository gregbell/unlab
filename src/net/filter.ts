// The capture filter. Terms separated by spaces must all match; the word `or`
// separates alternatives. Terms are matched without regard to case.
//
// Some terms say what a frame is or whose: a protocol, a machine name (either
// end, by any of its MACs or the addresses the lab set), one of its NICs
// (`node2:eth1`, by its MAC alone), an IPv4 address, or a MAC address. They
// match the frame on every switch that carries it. The others say where it was:
// a switch (`lan`), the cable in one of its ports (`lan:3`), or `port:N`, that
// port of every switch.
//
// A cable is watched at the port that the term names, so each frame that
// crosses it is matched once, whatever is at its other end. A cable between
// two switches has a port at each end, and either names it: the frames are the
// same ones, each as the switch at that end carried it. Only a frame that was
// lost in the cable, by a cut, is at the end that sent it and not at the other.
//
// It compiles to predicates over raw bytes and port numbers, because capture
// tests every frame the switches carry: no decoding and no strings made per frame.

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

/** A frame as a switch carried it. */
export interface CarriedFrame {
	readonly switch: string;
	readonly from: number;
	/** The egress port mask: bit p-1 is set when the frame went out of port p. */
	readonly to: number;
	readonly bytes: Uint8Array;
	/** Who was who when it was captured. */
	readonly names: NameBook;
}

/** A change to what is in a port, or to its link. */
export interface PortChange {
	readonly port: { readonly switch: string; readonly port: number };
	readonly machine: MachineName;
	readonly nic: NicNo;
	readonly names: NameBook;
}

/** A switch, or with a port one of its ports. */
export interface FilterPlace {
	readonly switch: string;
	readonly port: number | null;
}

/** Where in the lab a filter looks. */
export type FilterScope =
	/** It names no switch and no cable. */
	| { readonly kind: "everywhere" }
	/** It is one switch, or with a port one cable, and nothing else. */
	| { readonly kind: "place"; readonly switch: string; readonly port: number | null }
	/** It names switches or cables among other terms. */
	| { readonly kind: "places" };

export interface CaptureFilter {
	/** As typed. */
	readonly source: string;
	readonly scope: FilterScope;
	matchesFrame(frame: CarriedFrame): boolean;
	/**
	 * A link event row is context, so protocol terms never hide it. Switch,
	 * port, machine, NIC, address and MAC terms keep only the rows about that
	 * switch, port, machine or NIC.
	 */
	matchesLink(change: PortChange): boolean;
	/**
	 * An event row about switches and their ports alone: a cable between two of
	 * them, or one that storms. A term that names one of the places keeps it,
	 * and one that names a machine, a NIC or an address does not.
	 */
	matchesPlaces(places: readonly FilterPlace[]): boolean;
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

type FramePredicate = (f: CarriedFrame) => boolean;
type LinkPredicate = (c: PortChange) => boolean;
type PlacePredicate = (p: FilterPlace) => boolean;
interface Term {
	readonly frame: FramePredicate;
	readonly link: LinkPredicate;
	/** Whether it keeps an event row about that place. Left out, it keeps none: the term names a machine. */
	readonly at?: PlacePredicate;
	readonly place?: FilterPlace;
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

const always = (): boolean => true;

const PROTOCOLS: ReadonlyMap<string, (f: Uint8Array) => boolean> = new Map([
	["arp", (f) => ethertype(f) === ETH_ARP],
	["ip", isIpv4],
	["ipv4", isIpv4],
	["ipv6", (f) => ethertype(f) === ETH_IPV6],
	["icmp", (f) => ipProto(f) === IP_ICMP],
	["tcp", (f) => ipProto(f) === IP_TCP],
	["udp", (f) => ipProto(f) === IP_UDP],
	["dhcp", (f) => l4Uses(f, IP_UDP, 67, 68)],
	["dns", (f) => l4Uses(f, IP_UDP, 53) || l4Uses(f, IP_TCP, 53)],
]);

const OR = "or";
/** Before a port's number, for that port of every switch. */
export const PORT_WORD = "port";
const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/;
const PORT_NO = /^[1-8]$/;
/** What a port of a switch that is not there would be written as. */
const ANY_PORT = /^([a-z][a-z0-9-]*):\d+$/;

export const FILTER_PROTOCOLS: readonly string[] = [...PROTOCOLS.keys()];
/** The words a filter reads as something other than a machine or a switch. */
export const FILTER_WORDS: readonly string[] = [...FILTER_PROTOCOLS, OR, PORT_WORD];

/** `node<n>` is the lab's whether or not machine n has been there. */
function isMachine(word: string, { names }: NameBook): boolean {
	if (parseDefaultName(word) !== null) return true;
	for (const name of names.values()) if (name === word) return true;
	return false;
}

const crosses = (f: CarriedFrame, port: number): boolean => f.from === port || (f.to & (1 << (port - 1))) !== 0;

function switchTerm(on: string): Term {
	return {
		frame: (f) => f.switch === on,
		link: (c) => c.port.switch === on,
		at: (p) => p.switch === on,
		place: { switch: on, port: null },
	};
}

function cableTerm(on: string, port: number): Term {
	return {
		frame: (f) => f.switch === on && crosses(f, port),
		link: (c) => c.port.port === port && c.port.switch === on,
		at: (p) => p.port === port && p.switch === on,
		place: { switch: on, port },
	};
}

function machineTerm(name: string): Term {
	return {
		frame({ bytes, names }) {
			const isNamed = (at: NodeNic | undefined) => at !== undefined && nameOf(names, at.n) === name;
			return someNic(bytes, isNamed) || someIp(bytes, (ip) => isNamed(names.addresses.get(ip)));
		},
		link: (c) => c.machine === name,
	};
}

function nicTerm(name: string, nic: NicNo): Term {
	return {
		frame: ({ bytes, names }) => someNic(bytes, (at) => at.nic === nic && nameOf(names, at.n) === name),
		link: (c) => c.machine === name && c.nic === nic,
	};
}

function portTerm(port: number): Term {
	return { frame: (f) => crosses(f, port), link: (c) => c.port.port === port, at: (p) => p.port === port };
}

function addressTerm(ip: number): Term {
	return {
		frame: (f) => someIp(f.bytes, (other) => other === ip),
		link({ machine, nic, names }) {
			const at = names.addresses.get(ip);
			return at !== undefined && machine === nameOf(names, at.n) && nic === at.nic;
		},
	};
}

function macTerm(mac: Uint8Array): Term {
	const at = nicOfMac(mac, 0);
	return {
		frame: (f) => hasMac(f.bytes, mac),
		link: ({ machine, nic, names }) => at !== null && machine === nameOf(names, at.n) && nic === at.nic,
	};
}

/** The term, or why the word is none. */
function parseTerm(word: string, token: string, known: NameBook): Term | string {
	const protocol = PROTOCOLS.get(word);
	if (protocol) return { frame: (f) => protocol(f.bytes), link: always, at: always };

	const colon = word.indexOf(":");
	const name = colon < 0 ? word : word.slice(0, colon);
	const part = colon < 0 ? null : word.slice(colon + 1);
	const port = part !== null && PORT_NO.test(part) ? Number(part) : null;

	if (name === PORT_WORD && port !== null) return portTerm(port);

	// Before the machines, so a switch is not taken for one that is gone.
	if (known.switches.has(name)) {
		if (part === null) return switchTerm(name);
		if (port !== null) return cableTerm(name, port);
	}

	if (isMachine(name, known)) {
		if (part === null) return machineTerm(name);
		const nic = parseNicName(part);
		if (nic !== null) return nicTerm(name, nic);
	}

	const ip = parseIp4(word);
	if (ip !== null) return addressTerm(ip);
	if (MAC.test(word)) return macTerm(Uint8Array.from(word.split(/[:-]/), (h) => Number.parseInt(h, 16)));
	return notATerm(word, token, name, known);
}

function notATerm(word: string, token: string, name: string, known: NameBook): string {
	if (known.switches.has(name)) return `${token} is no port, so use one from ${name}:1 to ${name}:8.`;
	const several = known.switches.size > 1;
	if (several && ANY_PORT.test(word) && name !== PORT_WORD && !isMachine(name, known)) {
		const all = [...known.switches];
		return `No switch is called ${name}, so use ${all.slice(0, -1).join(", ")} or ${all.at(-1)}.`;
	}
	const places = several ? "a switch (lan), a cable (lan:3), " : "";
	return `Capture cannot read ${token}, so use a protocol, a machine, a NIC (node2:eth1), ${places}an address, a MAC or port:N.`;
}

/** `known` is who is who now, so that a word that names no machine or switch is not taken for one. */
export function compileFilter(source: string, known: NameBook): FilterResult {
	const groups: Term[][] = [[]];
	let lastOr: { token: string; start: number } | null = null;
	const orError = (token: string, start: number): FilterResult => ({
		ok: false,
		error: {
			token,
			start,
			end: start + token.length,
			message: `Capture needs a term on each side of ${OR}, such as arp or icmp.`,
		},
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
		const term = parseTerm(word, token, known);
		if (typeof term === "string") {
			return { ok: false, error: { token, start, end: start + token.length, message: term } };
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
		scope: scopeOf(groups.flat()),
		matchesFrame(f) {
			if (frames.length === 0) return true;
			outer: for (const group of frames) {
				for (const test of group) if (!test(f)) continue outer;
				return true;
			}
			return false;
		},
		matchesLink(c) {
			if (links.length === 0) return true;
			return links.some((group) => group.every((test) => test(c)));
		},
		matchesPlaces(places) {
			if (groups.length === 0) return true;
			return groups.some((group) => group.every(({ at }) => at !== undefined && places.some(at)));
		},
	};
}

function scopeOf(terms: readonly Term[]): FilterScope {
	const places = terms.flatMap(({ place }) => place ?? []);
	if (places.length === 0) return { kind: "everywhere" };
	return terms.length === 1 ? { kind: "place", ...places[0] } : { kind: "places" };
}

/** The empty filter. */
export const MATCH_ALL: CaptureFilter = filterOf("", []);
