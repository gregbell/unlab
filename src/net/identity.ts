// node<n> is 10.88.0.(10+n) with MAC 52:54:00:88:00:(10+n). Because the
// mapping is arithmetic, any frame names its machine without a lookup table,
// including machines that have since been removed.

export type NodeName = `node${number}`;

const LAB_NET = 0x0a580000;
const HOST_OFFSET = 10;
const MAC_PREFIX = [0x52, 0x54, 0x00, 0x88, 0x00] as const;
/** The last host address in 10.88.0.0/24 is .254, so node244 is the highest name with an address. */
export const MAX_NODE = 254 - HOST_OFFSET;

export function nodeIp(n: number): number {
	return (LAB_NET + HOST_OFFSET + n) >>> 0;
}

export function nodeMac(n: number): Uint8Array {
	return Uint8Array.of(...MAC_PREFIX, HOST_OFFSET + n);
}

function nodeName(n: number): NodeName | null {
	return n >= 1 && n <= MAX_NODE ? `node${n}` : null;
}

export function nodeOfIp(ip: number): NodeName | null {
	if ((ip & 0xffffff00) >>> 0 !== LAB_NET) return null;
	return nodeName((ip & 0xff) - HOST_OFFSET);
}

/** The machine whose MAC sits at `off` in `f`, or null. */
export function nodeOfMac(f: Uint8Array, off: number): NodeName | null {
	if (f.length < off + 6) return null;
	for (let i = 0; i < MAC_PREFIX.length; i++) if (f[off + i] !== MAC_PREFIX[i]) return null;
	return nodeName(f[off + 5] - HOST_OFFSET);
}

/** `node3` → 3. Only the canonical spelling: no leading zeros, no number without an address. */
export function parseNodeName(s: string): number | null {
	const m = /^node([1-9]\d{0,2})$/.exec(s);
	if (!m) return null;
	const n = Number(m[1]);
	return n <= MAX_NODE ? n : null;
}
