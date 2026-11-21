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
	return new Uint8Array(parts.map((p) => {
		const b = Number.parseInt(p, 16);
		if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`bad MAC: ${s}`);
		return b;
	}));
}

export function macStr(b: Uint8Array, off = 0): string {
	let s = "";
	for (let i = 0; i < 6; i++) s += (i ? ":" : "") + b[off + i].toString(16).padStart(2, "0");
	return s;
}

/** A stable per-machine MAC in the locally administered 52:54:00 range. */
export function labMac(index: number): string {
	const hi = (index >> 8) & 0xff;
	const lo = index & 0xff;
	return `52:54:00:88:${hi.toString(16).padStart(2, "0")}:${lo.toString(16).padStart(2, "0")}`;
}

export const dstMac = (f: Uint8Array): string => macStr(f, 0);
export const srcMac = (f: Uint8Array): string => macStr(f, 6);
export const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

export function ethertype(f: Uint8Array): number {
	return f.length < ETH_HDR ? -1 : (f[12] << 8) | f[13];
}

/** Broadcast, or any multicast (low bit of the first octet). */
export function isGroupMac(f: Uint8Array): boolean {
	return (f[0] & 1) === 1;
}

function u32(f: Uint8Array, off: number): number {
	return (((f[off] << 24) | (f[off + 1] << 16) | (f[off + 2] << 8) | f[off + 3]) >>> 0);
}

/** ARP sender/target protocol addresses, or null if this is not an ARP frame. */
export function arpAddrs(f: Uint8Array): { op: number; spa: number; tpa: number } | null {
	if (ethertype(f) !== ETH_ARP || f.length < ETH_HDR + 28) return null;
	return { op: (f[20] << 8) | f[21], spa: u32(f, 28), tpa: u32(f, 38) };
}

/** IPv4 source/destination/protocol, or null if this is not an IPv4 frame. */
export function ipAddrs(f: Uint8Array): { proto: number; src: number; dst: number; ihl: number } | null {
	if (ethertype(f) !== ETH_IPV4 || f.length < ETH_HDR + 20) return null;
	if ((f[ETH_HDR] >> 4) !== 4) return null;
	return { proto: f[ETH_HDR + 9], src: u32(f, ETH_HDR + 12), dst: u32(f, ETH_HDR + 16), ihl: (f[ETH_HDR] & 15) * 4 };
}

/** L4 ports for TCP/UDP, after the IPv4 header. */
export function l4Ports(f: Uint8Array, ip: { proto: number; ihl: number }): { sport: number; dport: number } | null {
	if (ip.proto !== IP_TCP && ip.proto !== IP_UDP) return null;
	const o = ETH_HDR + ip.ihl;
	if (f.length < o + 4) return null;
	return { sport: (f[o] << 8) | f[o + 1], dport: (f[o + 2] << 8) | f[o + 3] };
}

/** One IPv4 subnet, for deciding what belongs to the lab. */
export class Subnet {
	readonly network: number;
	readonly mask: number;
	readonly bits: number;
	constructor(cidr: string) {
		const [addr, len] = cidr.split("/");
		this.bits = Number(len);
		if (!Number.isInteger(this.bits) || this.bits < 0 || this.bits > 32) throw new Error(`bad CIDR: ${cidr}`);
		this.mask = this.bits === 0 ? 0 : (0xffffffff << (32 - this.bits)) >>> 0;
		this.network = (ip4(addr) & this.mask) >>> 0;
	}
	contains(ip: number): boolean {
		return ((ip & this.mask) >>> 0) === this.network;
	}
	/** The directed broadcast address, e.g. 10.88.0.255. */
	get broadcast(): number {
		return (this.network | (~this.mask >>> 0)) >>> 0;
	}
	host(n: number): string {
		return ip4str((this.network + n) >>> 0);
	}
	toString(): string {
		return `${ip4str(this.network)}/${this.bits}`;
	}
}

/**
 * Where a frame the guest sent belongs: the lab segment (bridged to the
 * other machines at layer 2) or the uplink (a NetStack that NATs to the
 * internet). Anything that names a lab address goes to the lab; DHCP and
 * everything else goes to the uplink, which owns 10.0.2.0/24.
 */
export function classify(f: Uint8Array, lab: Subnet): "lab" | "uplink" | "drop" {
	const et = ethertype(f);
	if (et === ETH_IPV6) return "drop";
	const arp = arpAddrs(f);
	if (arp) return lab.contains(arp.tpa) || lab.contains(arp.spa) ? "lab" : "uplink";
	const ip = ipAddrs(f);
	if (ip) {
		if (ip.dst === 0xffffffff) return "uplink"; // DHCP discover: the uplink serves it
		if (ip.dst === lab.broadcast) return "lab";
		return lab.contains(ip.dst) ? "lab" : "uplink";
	}
	return et === ETH_ARP || et === ETH_IPV4 ? "drop" : "uplink";
}
