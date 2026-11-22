// Frame builders for unit tests. Byte layouts follow the RFCs, written out by
// hand so the tests do not lean on the parsers they exercise.

export const BROADCAST = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
export const ZERO_MAC = new Uint8Array(6);

export const mac = (n: number): Uint8Array => Uint8Array.of(0x52, 0x54, 0x00, 0x88, 0x00, 10 + n);
export const ip = (n: number): number => (0x0a580000 + 10 + n) >>> 0;

function u16(v: number): number[] {
	return [(v >>> 8) & 255, v & 255];
}
function u32(v: number): number[] {
	return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

export function eth(dst: Uint8Array, src: Uint8Array, type: number, payload: ArrayLike<number>): Uint8Array {
	return Uint8Array.from([...dst, ...src, ...u16(type), ...Array.from(payload)]);
}

export function arpPacket(op: 1 | 2, sha: Uint8Array, spa: number, tha: Uint8Array, tpa: number): number[] {
	return [...u16(1), ...u16(0x0800), 6, 4, ...u16(op), ...sha, ...u32(spa), ...tha, ...u32(tpa)];
}

/** node `from` asks who has node `to`'s address. */
export function arpRequest(from: number, to: number, tpa = ip(to)): Uint8Array {
	return eth(BROADCAST, mac(from), 0x0806, arpPacket(1, mac(from), ip(from), ZERO_MAC, tpa));
}

/** node `from` tells node `to` where `from` is. */
export function arpReply(from: number, to: number): Uint8Array {
	return eth(mac(to), mac(from), 0x0806, arpPacket(2, mac(from), ip(from), mac(to), ip(to)));
}

export function ipv4Packet(src: number, dst: number, proto: number, l4: number[]): number[] {
	return [0x45, 0, ...u16(20 + l4.length), 0, 0, 0x40, 0, 64, proto, 0, 0, ...u32(src), ...u32(dst), ...l4];
}

export function icmpEcho(type: 0 | 8, seq: number, payload = 56): number[] {
	return [type, 0, 0, 0, 0, 1, ...u16(seq), ...new Array<number>(payload).fill(0)];
}

export function udpSegment(sport: number, dport: number, payload = 0): number[] {
	return [...u16(sport), ...u16(dport), ...u16(8 + payload), 0, 0, ...new Array<number>(payload).fill(0)];
}

export function tcpSegment(sport: number, dport: number, flags = 0x02): number[] {
	return [...u16(sport), ...u16(dport), ...u32(1), ...u32(0), 0x50, flags, ...u16(64240), 0, 0, 0, 0];
}

export function ping(from: number, to: number, seq = 1, type: 0 | 8 = 8): Uint8Array {
	return eth(mac(to), mac(from), 0x0800, ipv4Packet(ip(from), ip(to), 1, icmpEcho(type, seq)));
}

export function ipv6(src: Uint8Array, dst: Uint8Array): Uint8Array {
	return eth(dst, src, 0x86dd, [0x60, 0, 0, 0, 0, 0, 59, 64, ...new Array<number>(32).fill(0)]);
}
