// IPv4 addresses with a prefix, and the subnets they put a NIC in.

import { ip4str } from "./frames.ts";

/** A NIC's address: `10.1.0.1/24`. */
export interface Address {
	/** Host-order u32. */
	readonly ip: number;
	readonly prefix: number;
}

/** Why a text is not an address a NIC can have. */
export type AddressFault =
	| { readonly kind: "unreadable" }
	| { readonly kind: "prefix"; readonly ip: number }
	/** Loopback, multicast, and the ranges at either end of the address space. */
	| { readonly kind: "reserved" }
	/** The subnet's own address or its broadcast address, with the first and last that a NIC can have. */
	| { readonly kind: "network" | "broadcast"; readonly first: number; readonly last: number };

const QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A dotted quad as a host-order u32. */
export function parseIp4(text: string): number | null {
	const octets = QUAD.exec(text)?.slice(1).map(Number);
	if (!octets || octets.some((octet) => octet > 255)) return null;
	return octets.reduce((ip, octet) => ip * 256 + octet, 0);
}

const hostMask = (prefix: number): number => (prefix === 32 ? 0 : 0xffffffff >>> prefix);

/** The subnet's own address: 10.1.0.0 for 10.1.0.1/24. */
export function networkOf({ ip, prefix }: Address): number {
	return (ip & ~hostMask(prefix)) >>> 0;
}

function broadcastOf({ ip, prefix }: Address): number {
	return (ip | hostMask(prefix)) >>> 0;
}

/** `10.1.0.1/24`, checked once so that nothing after has to. */
export function parseAddress(text: string): Address | AddressFault {
	const [quad, bits, ...rest] = text.split("/");
	const ip = parseIp4(quad);
	if (ip === null || rest.length > 0) return { kind: "unreadable" };
	if (bits === undefined || !/^([1-9]|[12]\d|3[0-2])$/.test(bits)) return { kind: "prefix", ip };
	const top = ip >>> 24;
	if (top === 0 || top === 127 || top >= 224) return { kind: "reserved" };
	const address: Address = { ip, prefix: Number(bits) };
	// A /31 has two ends and a /32 has one, so neither keeps an address back.
	if (address.prefix < 31) {
		const span = { first: networkOf(address) + 1, last: broadcastOf(address) - 1 };
		if (ip === networkOf(address)) return { kind: "network", ...span };
		if (ip === broadcastOf(address)) return { kind: "broadcast", ...span };
	}
	return address;
}

export function isAddressFault(read: Address | AddressFault): read is AddressFault {
	return "kind" in read;
}

/** `10.1.0.1/24` */
export function addressStr({ ip, prefix }: Address): string {
	return `${ip4str(ip)}/${prefix}`;
}

/** `10.1.0.0/24` */
export function subnetStr(address: Address): string {
	return addressStr({ ip: networkOf(address), prefix: address.prefix });
}

/** Whether some address is in both subnets. */
export function subnetsOverlap(a: Address, b: Address): boolean {
	const prefix = Math.min(a.prefix, b.prefix);
	return networkOf({ ip: a.ip, prefix }) === networkOf({ ip: b.ip, prefix });
}

/**
 * What the package gateway keeps on eth0: the subnet it leases from, and the
 * addresses it answers the repositories' names with. A NIC in either would
 * take the gateway's traffic to the switch.
 */
export const GATEWAY_SUBNETS: readonly Address[] = [
	{ ip: 0x0a000200, prefix: 24 },
	{ ip: 0xc6336400, prefix: 24 },
];
