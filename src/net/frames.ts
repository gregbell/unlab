// Ethernet / ARP / IPv4 helpers. Pure byte poking, no dependencies, so the
// same code runs on the main thread, in a Web Worker and in Node.

export const ETH_HDR = 14;
export const ETH_ARP = 0x0806;
export const ETH_IPV4 = 0x0800;
export const ETH_IPV6 = 0x86dd;

export const IP_ICMP = 1;
export const IP_TCP = 6;
export const IP_UDP = 17;

/** Dotted quad -> host-order u32. */
export function ip4(s: string): number {
	const p = s.split(".");
	if (p.length !== 4) throw new Error(`bad IPv4: ${s}`);
	let n = 0;
	for (const part of p) {
		const b = Number(part);
		if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`bad IPv4: ${s}`);
		n = (n * 256 + b) >>> 0;
	}
	return n >>> 0;
}

/** Host-order u32 -> dotted quad. */
export function ip4str(n: number): string {
	return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function parseMac(s: string): Uint8Array {
	const parts = s.split(/[:-]/);
	if (parts.length !== 6) throw new Error(`bad MAC: ${s}`);
	return new Uint8Array(
		parts.map((p) => {
			const b = Number.parseInt(p, 16);
			if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`bad MAC: ${s}`);
			return b;
		}),
	);
}

export function macStr(b: Uint8Array, off = 0): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += (i ? ":" : "") + b[off + i].toString(16).padStart(2, "0");
	return s;
}

export const dstMac = (f: Uint8Array): string => macStr(f, 0);
export const srcMac = (f: Uint8Array): string => macStr(f, 6);
export const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";
/** Who a frame to a group is for, where a machine's name would be. */
export const EVERYONE = "everyone";

export function ethertype(f: Uint8Array): number {
	return f.length < ETH_HDR ? -1 : (f[12] << 8) | f[13];
}

/** The 802.1Q tag: its type where the frame's own type would be, then the VLAN ID in the low 12 bits of the next two bytes. */
export const ETH_VLAN = 0x8100;
const TAG = 4;
/** A tag of VLAN 0 gives only a priority, so the frame is in the VLAN it would be in with no tag. */
export const PRIORITY_ONLY = 0;
/** No frame is in VLAN 4095. */
export const RESERVED_VLAN = 4095;

/** The VLAN ID in the frame's 802.1Q tag, or null for a frame that has none. */
export function vlanTag(f: Uint8Array): number | null {
	if (f.length < ETH_HDR + TAG || f[12] !== ETH_VLAN >> 8 || f[13] !== (ETH_VLAN & 255)) return null;
	return ((f[14] & 15) << 8) | f[15];
}

/** The frame with an 802.1Q tag for the VLAN after its addresses. */
export function withTag(f: Uint8Array, vlan: number): Uint8Array {
	const out = new Uint8Array(f.length + TAG);
	out.set(f.subarray(0, 12));
	out[12] = ETH_VLAN >> 8;
	out[13] = ETH_VLAN & 255;
	out[14] = (vlan >> 8) & 15;
	out[15] = vlan & 255;
	out.set(f.subarray(12), 12 + TAG);
	return out;
}

/**
 * A frame as it was on the wire at a port: with a tag for its VLAN when
 * `tagged`, a mask with bit p-1 for port p, says it had one there.
 */
export function onWire(f: Uint8Array, vlan: number, tagged: number, port: number): Uint8Array {
	return tagged & (1 << (port - 1)) ? withTag(f, vlan) : f;
}

/** The frame without the 802.1Q tag that `vlanTag` found. */
export function withoutTag(f: Uint8Array): Uint8Array {
	const out = new Uint8Array(f.length - TAG);
	out.set(f.subarray(0, 12));
	out.set(f.subarray(12 + TAG), 12);
	return out;
}

/** Broadcast, or any multicast (low bit of the first octet). */
export function isGroupMac(f: Uint8Array): boolean {
	return (f[0] & 1) === 1;
}

/** Why a switch flooded a frame: a broadcast or multicast address, or a unicast address it has not learned. */
export type Flood = "group" | "unknown";

function u32(f: Uint8Array, off: number): number {
	return ((f[off] << 24) | (f[off + 1] << 16) | (f[off + 2] << 8) | f[off + 3]) >>> 0;
}

/** ARP sender/target protocol addresses, or null if this is not an ARP frame. */
export function arpAddrs(f: Uint8Array): { op: number; spa: number; tpa: number } | null {
	if (ethertype(f) !== ETH_ARP || f.length < ETH_HDR + 28) return null;
	return { op: (f[20] << 8) | f[21], spa: u32(f, 28), tpa: u32(f, 38) };
}

/** IPv4 source/destination/protocol, or null if this is not an IPv4 frame. */
export function ipAddrs(f: Uint8Array): { proto: number; src: number; dst: number; ihl: number } | null {
	if (ethertype(f) !== ETH_IPV4 || f.length < ETH_HDR + 20) return null;
	if (f[ETH_HDR] >> 4 !== 4) return null;
	return { proto: f[ETH_HDR + 9], src: u32(f, ETH_HDR + 12), dst: u32(f, ETH_HDR + 16), ihl: (f[ETH_HDR] & 15) * 4 };
}

/** L4 ports for TCP/UDP, after the IPv4 header. */
export function l4Ports(f: Uint8Array, ip: { proto: number; ihl: number }): { sport: number; dport: number } | null {
	if (ip.proto !== IP_TCP && ip.proto !== IP_UDP) return null;
	const o = ETH_HDR + ip.ihl;
	if (f.length < o + 4) return null;
	return { sport: (f[o] << 8) | f[o + 1], dport: (f[o + 2] << 8) | f[o + 3] };
}

/** To a DHCP server, whichever one is listening. */
export function isDhcpRequest(f: Uint8Array): boolean {
	const ip = ipAddrs(f);
	return ip?.proto === IP_UDP && l4Ports(f, ip)?.dport === 67;
}
