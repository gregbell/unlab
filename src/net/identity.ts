// NIC k of machine n has MAC 52:54:00:88:0k:(10+n). Because the mapping is
// arithmetic, a frame's MACs say which machines and NICs it is between without
// a lookup table, including machines that have since been removed. What a
// machine is called, and which addresses are its, the lab knows.

import type { Address } from "./address.ts";

declare const chosen: unique symbol;
/** What a machine goes by: `node<n>`, or a name that was chosen and checked. */
export type MachineName = `node${number}` | (string & { readonly [chosen]: true });
/** A NIC by its number in the guest: 0 is eth0. */
export type NicNo = 0 | 1 | 2 | 3;
export type NicName = `eth${NicNo}`;
export interface NodeNic {
	readonly n: number;
	readonly nic: NicNo;
}

/** Every NIC a machine can have, eth0 first. */
export const NICS: readonly NicNo[] = [0, 1, 2, 3];
export const MAX_NICS = NICS.length;

/** The subnet of the addresses machines get when no one chooses. */
export const LAB_SUBNET: Address = { ip: 0x0a580000, prefix: 24 };
const HOST_OFFSET = 10;
const MAC_PREFIX = [0x52, 0x54, 0x00, 0x88] as const;
/** The last host address in 10.88.0.0/24 is .254, so 244 is the highest n with an address of its own there. */
export const MAX_NODE = 254 - HOST_OFFSET;

/** The address eth0 of machine n gets when no one chooses: 10.88.0.(10+n)/24. */
export function defaultAddress(n: number): Address {
	return { ip: LAB_SUBNET.ip + HOST_OFFSET + n, prefix: LAB_SUBNET.prefix };
}

/** Who is who in the lab at one moment. */
export interface NameBook {
	/** Whose NIC the lab set each address on, by the address as a host-order u32. */
	readonly addresses: ReadonlyMap<number, NodeNic>;
	/** What each machine is called, by its n. No two have one name. */
	readonly names: ReadonlyMap<number, MachineName>;
}
export const NO_NAMES: NameBook = { addresses: new Map(), names: new Map() };

export function defaultName(n: number): MachineName {
	return `node${n}`;
}

/** A machine the book does not have, or whose name another has taken since, goes by its n. */
export function nameOf({ names }: NameBook, n: number): MachineName {
	return names.get(n) ?? defaultName(n);
}

export function nodeMac(n: number, nic: NicNo = 0): Uint8Array {
	return Uint8Array.of(...MAC_PREFIX, nic, HOST_OFFSET + n);
}

/** The machine and NIC whose MAC sits at `off` in `f`, or null. */
export function nicOfMac(f: Uint8Array, off: number): NodeNic | null {
	if (f.length < off + 6) return null;
	for (let i = 0; i < MAC_PREFIX.length; i++) if (f[off + i] !== MAC_PREFIX[i]) return null;
	const nic = NICS.find((k) => k === f[off + 4]);
	const n = f[off + 5] - HOST_OFFSET;
	return nic === undefined || n < 1 || n > MAX_NODE ? null : { n, nic };
}

/** `node3` → 3. Only the canonical spelling: no leading zeros, no number without a MAC. */
export function parseDefaultName(s: string): number | null {
	const m = /^node([1-9]\d{0,2})$/.exec(s);
	if (!m) return null;
	const n = Number(m[1]);
	return n <= MAX_NODE ? n : null;
}

export function nicName(nic: NicNo): NicName {
	return `eth${nic}`;
}

/** `eth1` → 1. */
export function parseNicName(s: string): NicNo | null {
	return NICS.find((nic) => nicName(nic) === s) ?? null;
}

/** `node2`, or `node2:eth1` where the machine's name alone does not say which NIC. */
export function nicLabel(name: MachineName, nic: NicNo, several: boolean): string {
	return several || nic > 0 ? `${name}:${nicName(nic)}` : name;
}
