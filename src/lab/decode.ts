// Decode a frame into one tcpdump-ish line for the inspector.

import {
	arpAddrs, dstMac, ETH_ARP, ETH_IPV4, ETH_IPV6, ETH_HDR, ethertype,
	ip4str, ipAddrs, IP_ICMP, IP_TCP, IP_UDP, l4Ports, srcMac,
} from "./frames.ts";

export interface Decoded {
	/** A short protocol label for colouring, e.g. "ARP", "ICMP", "TCP". */
	proto: string;
	src: string;
	dst: string;
	info: string;
}

const ICMP_TYPES: Record<number, string> = {
	0: "echo reply",
	3: "destination unreachable",
	5: "redirect",
	8: "echo request",
	11: "time exceeded",
};

function tcpFlags(f: Uint8Array, off: number): string {
	if (f.length < off + 14) return "";
	const bits = f[off + 13];
	let s = "";
	if (bits & 0x02) s += "S";
	if (bits & 0x10) s += ".";
	if (bits & 0x08) s += "P";
	if (bits & 0x01) s += "F";
	if (bits & 0x04) s += "R";
	if (bits & 0x20) s += "U";
	return s || ".";
}

export function decode(frame: Uint8Array): Decoded {
	const et = ethertype(frame);
	const src = srcMac(frame);
	const dst = dstMac(frame);

	const arp = arpAddrs(frame);
	if (arp) {
		const who = arp.op === 1
			? `who has ${ip4str(arp.tpa)}? tell ${ip4str(arp.spa)}`
			: arp.op === 2
				? `${ip4str(arp.spa)} is at ${src}`
				: `opcode ${arp.op}`;
		return { proto: "ARP", src, dst, info: who };
	}

	const ip = ipAddrs(frame);
	if (ip) {
		const s = ip4str(ip.src);
		const d = ip4str(ip.dst);
		const l4 = l4Ports(frame, ip);
		const payload = frame.length - ETH_HDR - ip.ihl;
		if (ip.proto === IP_ICMP) {
			const o = ETH_HDR + ip.ihl;
			const type = frame[o];
			const seq = frame.length >= o + 8 ? (frame[o + 6] << 8) | frame[o + 7] : 0;
			return { proto: "ICMP", src: s, dst: d, info: `${ICMP_TYPES[type] ?? `type ${type}`} seq ${seq}, ${payload} bytes` };
		}
		if (ip.proto === IP_TCP && l4) {
			const o = ETH_HDR + ip.ihl;
			const dataOff = frame.length >= o + 13 ? (frame[o + 12] >> 4) * 4 : 20;
			return {
				proto: "TCP",
				src: `${s}:${l4.sport}`,
				dst: `${d}:${l4.dport}`,
				info: `[${tcpFlags(frame, o)}] ${Math.max(0, payload - dataOff)} bytes`,
			};
		}
		if (ip.proto === IP_UDP && l4) {
			const what = l4.dport === 67 || l4.sport === 68 ? " (DHCP)" : l4.dport === 53 || l4.sport === 53 ? " (DNS)" : "";
			return { proto: "UDP", src: `${s}:${l4.sport}`, dst: `${d}:${l4.dport}`, info: `${Math.max(0, payload - 8)} bytes${what}` };
		}
		return { proto: `IP/${ip.proto}`, src: s, dst: d, info: `${payload} bytes` };
	}

	const label = et === ETH_IPV6 ? "IPv6" : et === ETH_ARP || et === ETH_IPV4 ? "truncated" : `0x${(et < 0 ? 0 : et).toString(16).padStart(4, "0")}`;
	return { proto: label, src, dst, info: `${frame.length} bytes` };
}
