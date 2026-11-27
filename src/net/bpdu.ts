// The frames that switches work out a spanning tree with: bridge protocol data
// units, as 802.1D-2004 clause 9 lays them out. Each goes to the address that
// is the bridges' own, in an 802.3 frame with an LLC header and no tag, and no
// switch sends one on. Pure byte poking, as the rest of this folder is.

import { ETH_HDR } from "./frames.ts";

/** 01:80:C2:00:00:00, which every bridge listens on and none forwards. */
export const BRIDGE_GROUP = 0x0180_c200_0000;
const LLC = [0x42, 0x42, 0x03] as const;
const BPDU = ETH_HDR + LLC.length;
const RAPID_VERSION = 2;
const RAPID_TYPE = 2;
const CONFIG_TYPE = 0;
/** A configuration message's bytes, and a rapid one's with the length that ends it. */
const CONFIG_BYTES = 35;
const RAPID_BYTES = 36;
/** Ethernet's shortest frame, without its checksum. */
const MIN_FRAME = 60;

declare const bridgeId: unique symbol;
/**
 * A bridge's priority and then its address, as sixteen hex digits. The lower
 * one wins, and two compare as text as they do as numbers.
 */
export type BridgeId = string & { readonly [bridgeId]: true };

const hex = (value: number, digits: number): string => value.toString(16).padStart(digits, "0");

/** `priority` is the sixteen bits before the address: 32768 unless someone chose. `address` is a MAC as one number. */
export function bridgeIdOf(priority: number, address: number): BridgeId {
	return (hex(priority, 4) + hex(address, 12)) as BridgeId;
}

export const bridgePriority = (id: BridgeId): number => Number.parseInt(id.slice(0, 4), 16);
/** The address in a bridge's ID, as a MAC is written. */
export const bridgeAddress = (id: BridgeId): string => (id.slice(4).match(/../g) ?? []).join(":");

/** What the port that sent a message is in its switch's tree. Classic spanning tree sends only from designated ports, and says nothing. */
export type BpduRole = "unknown" | "alternate" | "root" | "designated";
const ROLES: readonly BpduRole[] = ["unknown", "alternate", "root", "designated"];

/** One message, with its times in seconds. */
export interface Bpdu {
	/** A rapid spanning tree message. A classic one has no role, and none of proposal, agreement, learning and forwarding. */
	readonly rapid: boolean;
	readonly root: BridgeId;
	/** What the way to the root costs from the bridge that sent it. */
	readonly cost: number;
	readonly bridge: BridgeId;
	/** The sending port's priority, in its top four bits, and number. */
	readonly port: number;
	readonly role: BpduRole;
	readonly proposal: boolean;
	readonly agreement: boolean;
	readonly learning: boolean;
	readonly forwarding: boolean;
	readonly topologyChange: boolean;
	/** How many bridges the root's word has come through. */
	readonly age: number;
	readonly maxAge: number;
	readonly hello: number;
	readonly forwardDelay: number;
}

function putId(frame: Uint8Array, at: number, id: BridgeId): void {
	for (let i = 0; i < 8; i++) frame[at + i] = Number.parseInt(id.slice(2 * i, 2 * i + 2), 16);
}

function idAt(frame: Uint8Array, at: number): BridgeId {
	let id = "";
	for (let i = 0; i < 8; i++) id += hex(frame[at + i], 2);
	return id as BridgeId;
}

function put(frame: Uint8Array, at: number, bytes: number, value: number): void {
	for (let i = 0; i < bytes; i++) frame[at + i] = Math.floor(value / 256 ** (bytes - 1 - i)) & 255;
}

function at(frame: Uint8Array, from: number, bytes: number): number {
	let value = 0;
	for (let i = 0; i < bytes; i++) value = value * 256 + frame[from + i];
	return value;
}

/** A time is on the wire in 256ths of a second. */
const putTime = (frame: Uint8Array, where: number, seconds: number): void =>
	put(frame, where, 2, Math.round(seconds * 256));
const timeAt = (frame: Uint8Array, where: number): number => at(frame, where, 2) / 256;

/** Whether the frame is for the bridges' own address, whatever it holds. */
export function isForBridges(frame: Uint8Array): boolean {
	return frame.length >= ETH_HDR && at(frame, 0, 6) === BRIDGE_GROUP;
}

/** A rapid spanning tree message as a frame, from the MAC given as one number. */
export function encodeBpdu(bpdu: Bpdu, from: number): Uint8Array {
	const frame = new Uint8Array(MIN_FRAME);
	put(frame, 0, 6, BRIDGE_GROUP);
	put(frame, 6, 6, from);
	put(frame, 12, 2, LLC.length + RAPID_BYTES);
	frame.set(LLC, ETH_HDR);
	frame[BPDU + 2] = RAPID_VERSION;
	frame[BPDU + 3] = RAPID_TYPE;
	frame[BPDU + 4] =
		(bpdu.topologyChange ? 0x01 : 0) |
		(bpdu.proposal ? 0x02 : 0) |
		(ROLES.indexOf(bpdu.role) << 2) |
		(bpdu.learning ? 0x10 : 0) |
		(bpdu.forwarding ? 0x20 : 0) |
		(bpdu.agreement ? 0x40 : 0);
	putId(frame, BPDU + 5, bpdu.root);
	put(frame, BPDU + 13, 4, bpdu.cost);
	putId(frame, BPDU + 17, bpdu.bridge);
	put(frame, BPDU + 25, 2, bpdu.port);
	putTime(frame, BPDU + 27, bpdu.age);
	putTime(frame, BPDU + 29, bpdu.maxAge);
	putTime(frame, BPDU + 31, bpdu.hello);
	putTime(frame, BPDU + 33, bpdu.forwardDelay);
	return frame;
}

/**
 * The message in a frame, or null for one that holds none this reads: not for
 * the bridges, not in an LLC header of theirs, cut short, or a classic
 * topology change notice, which says nothing of a tree.
 */
export function decodeBpdu(frame: Uint8Array): Bpdu | null {
	if (!isForBridges(frame) || frame.length < BPDU + CONFIG_BYTES) return null;
	if (LLC.some((byte, i) => frame[ETH_HDR + i] !== byte) || at(frame, BPDU, 2) !== 0) return null;
	const type = frame[BPDU + 3];
	const rapid = type === RAPID_TYPE && frame[BPDU + 2] >= RAPID_VERSION;
	if (!rapid && type !== CONFIG_TYPE) return null;
	const flags = frame[BPDU + 4];
	return {
		rapid,
		root: idAt(frame, BPDU + 5),
		cost: at(frame, BPDU + 13, 4),
		bridge: idAt(frame, BPDU + 17),
		port: at(frame, BPDU + 25, 2),
		role: rapid ? ROLES[(flags >> 2) & 3] : "designated",
		proposal: rapid && (flags & 0x02) !== 0,
		agreement: rapid && (flags & 0x40) !== 0,
		learning: rapid && (flags & 0x10) !== 0,
		forwarding: rapid && (flags & 0x20) !== 0,
		topologyChange: (flags & 0x01) !== 0,
		age: timeAt(frame, BPDU + 27),
		maxAge: timeAt(frame, BPDU + 29),
		hello: timeAt(frame, BPDU + 31),
		forwardDelay: timeAt(frame, BPDU + 33),
	};
}
