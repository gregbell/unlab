// NIC k of node<n> has MAC 52:54:00:88:0k:(10+n). Because the mapping is
// arithmetic, a frame's MACs name its machines and NICs without a lookup
// table, including machines that have since been removed. An IP address names
// a machine only through the addresses the lab set.

import type { Address } from "./address.ts";

export type NodeName = `node${number}`;
/** A NIC by its number in the guest: 0 is eth0. */
export type NicNo = 0 | 1 | 2 | 3;
export type NicName = `eth${NicNo}`;
export interface NodeNic {
	readonly node: NodeName;
	readonly nic: NicNo;
}

/** Every NIC a machine can have, eth0 first. */
export const NICS: readonly NicNo[] = [0, 1, 2, 3];
export const MAX_NICS = NICS.length;

/** The subnet of the addresses machines get when no one chooses. */
export const LAB_SUBNET: Address = { ip: 0x0a580000, prefix: 24 };
const HOST_OFFSET = 10;
const MAC_PREFIX = [0x52, 0x54, 0x00, 0x88] as const;
/** The last host address in 10.88.0.0/24 is .254, so node244 is the highest name with an address of its own there. */
export const MAX_NODE = 254 - HOST_OFFSET;

/** The address eth0 of node<n> gets when no one chooses: 10.88.0.(10+n)/24. */
export function defaultAddress(n: number): Address {
	return { ip: LAB_SUBNET.ip + HOST_OFFSET + n, prefix: LAB_SUBNET.prefix };
}

/** Whose NIC the lab set an address on, by the address as a host-order u32. */
export type AddressBook = ReadonlyMap<number, NodeNic>;
export const NO_ADDRESSES: AddressBook = new Map();

export function nodeMac(n: number, nic: NicNo = 0): Uint8Array {
	return Uint8Array.of(...MAC_PREFIX, nic, HOST_OFFSET + n);
}

function nodeName(n: number): NodeName | null {
	return n >= 1 && n <= MAX_NODE ? `node${n}` : null;
}

/** The machine and NIC whose MAC sits at `off` in `f`, or null. */
export function nicOfMac(f: Uint8Array, off: number): NodeNic | null {
	if (f.length < off + 6) return null;
	for (let i = 0; i < MAC_PREFIX.length; i++) if (f[off + i] !== MAC_PREFIX[i]) return null;
	const nic = NICS.find((k) => k === f[off + 4]);
	const node = nodeName(f[off + 5] - HOST_OFFSET);
	return nic === undefined || node === null ? null : { node, nic };
}

/** The machine whose MAC sits at `off` in `f`, whichever NIC it is, or null. */
export function nodeOfMac(f: Uint8Array, off: number): NodeName | null {
	return nicOfMac(f, off)?.node ?? null;
}

/** `node3` → 3. Only the canonical spelling: no leading zeros, no number without a MAC. */
export function parseNodeName(s: string): number | null {
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
export function nodeNicLabel({ node, nic }: NodeNic, several: boolean): string {
	return several || nic > 0 ? `${node}:${nicName(nic)}` : node;
}
