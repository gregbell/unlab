import {
	defaultName,
	EVERYONE,
	FILTER_WORDS,
	MAX_NODE,
	macStr,
	type NicNo,
	nicLabel as nicLabelOf,
	nodeMac,
	parseDefaultName,
	parseNicName,
} from "../net/index.ts";
import { ALL_MACHINES, type Identity, type Machine, type MachineName, type SessionId, SWITCH_NAME } from "./types.ts";

/** A number is never reused, so a lab runs out of MACs after MAX_NODE. `planSpawn` checks before it asks. */
export function identity(n: number, name: MachineName = defaultName(n)): Identity {
	if (!Number.isInteger(n) || n < 1 || n > MAX_NODE) {
		throw new RangeError(`no node ${n}: a lab holds node1 to node${MAX_NODE}`);
	}
	return { n, name, mac: macStr(nodeMac(n)) };
}

export function nicMac(n: number, nic: NicNo): string {
	return macStr(nodeMac(n, nic));
}

/** `node2` for a machine with one NIC, `node2:eth0` and `node2:eth1` for one with more. */
export function nicLabel(machine: Pick<Machine, "name" | "spec">, nic: NicNo): string {
	return nicLabelOf(machine.name, nic, machine.spec.nics.length > 1);
}

/** A DNS label, so that it is the guest's hostname and resolves as it is written. */
const HOSTNAME = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
export const MAX_NAME = 63;
const DEFAULT_NAME = /^node\d+$/;

const isHostname = (text: string): text is MachineName => HOSTNAME.test(text) && text.length <= MAX_NAME;

/** Any name a machine could have. Only the exact spelling of `node<n>`, which is machine n's alone. */
export function parseMachineName(text: string): MachineName | null {
	if (!isHostname(text)) return null;
	return DEFAULT_NAME.test(text) && parseDefaultName(text) === null ? null : text;
}

/** Why a text is not a name that someone can give a machine. */
export type NameFault =
	| { readonly kind: "unreadable" }
	| { readonly kind: "too-long"; readonly length: number }
	/** `node<n>`, which the lab gives out. */
	| { readonly kind: "lab" }
	/** It means something else where machines are named. */
	| { readonly kind: "word" };

/** What the images' own /etc/hosts calls the guest it is in, which would come before another machine's address. */
export const LOOPBACK_NAMES: readonly string[] = ["localhost", "ip6-localhost", "ip6-loopback", "unkernel"];
const WORDS: ReadonlySet<string> = new Set([ALL_MACHINES, SWITCH_NAME, EVERYONE, ...LOOPBACK_NAMES, ...FILTER_WORDS]);

function isWord(text: string): boolean {
	// State is keyed by name, and an object answers to some names that nobody gave it.
	return WORDS.has(text) || SESSION_LABEL.test(text) || parseNicName(text) !== null || text in {};
}

/** A name someone chose for a machine, checked once so that nothing after has to. */
export function parseChosenName(text: string): MachineName | NameFault {
	if (!HOSTNAME.test(text)) return { kind: "unreadable" };
	if (!isHostname(text)) return { kind: "too-long", length: text.length };
	if (DEFAULT_NAME.test(text)) return { kind: "lab" };
	return isWord(text) ? { kind: "word" } : text;
}

export function isNameFault(read: MachineName | NameFault): read is NameFault {
	return typeof read !== "string";
}

export interface SessionAddress {
	readonly session: SessionId;
	readonly machine: MachineName;
	/** The tab's label: `console`, `sh1`. */
	readonly label: string;
	/** Null for the console. */
	readonly shell: number | null;
}

const SESSION_LABEL = /^(?:console|sh([1-9]\d*))$/;

/** `node2:sh1` into its parts. Null for anything that is not a session's address. */
export function parseSessionId(text: string): SessionAddress | null {
	const colon = text.indexOf(":");
	const machine = parseMachineName(text.slice(0, Math.max(0, colon)));
	const label = text.slice(colon + 1);
	const match = SESSION_LABEL.exec(label);
	if (!machine || !match) return null;
	if (label === "console") return { session: `${machine}:console`, machine, label, shell: null };
	const shell = Number(match[1]);
	return Number.isSafeInteger(shell) ? { session: `${machine}:sh${shell}`, machine, label, shell } : null;
}

export function sessionLabel(session: SessionId): string {
	return session.slice(session.indexOf(":") + 1);
}
