import { ip4str, MAX_NODE, macStr, type NicNo, nodeIp, nodeMac, nodeNicLabel, parseNodeName } from "../net/index.ts";
import type { Identity, Machine, MachineName, SessionId } from "./types.ts";

// net/ owns the node<n> arithmetic. These two name a frame's machine from its
// bytes, live or long removed, and are null for any address the lab cannot name.
export { nodeOfIp as nameForIp, nodeOfMac as nameForMac } from "../net/index.ts";

/** The lab segment. The details panel writes an address with its prefix, as in `10.88.0.12/24`. */
export const LAB_CIDR = "10.88.0.0/24";
export const LAB_PREFIX_BITS = 24;

/** Names are never reused, so a lab runs out of addresses after node<MAX_NODE>. `planSpawn` checks before it asks. */
export function identity(n: number): Identity {
	if (!Number.isInteger(n) || n < 1 || n > MAX_NODE) {
		throw new RangeError(`no node ${n}: a lab holds node1 to node${MAX_NODE}`);
	}
	return { n, name: `node${n}`, ip: ip4str(nodeIp(n)), mac: macStr(nodeMac(n)) };
}

export function nicMac(n: number, nic: NicNo): string {
	return macStr(nodeMac(n, nic));
}

/** `node2` for a machine with one NIC, `node2:eth0` and `node2:eth1` for one with more. */
export function nicLabel(machine: Pick<Machine, "name" | "spec">, nic: NicNo): string {
	return nodeNicLabel({ node: machine.name, nic }, machine.spec.nics.length > 1);
}

/** Only the exact spelling the lab uses, so `node01` cannot alias `node1`. */
export function parseMachineName(text: string): MachineName | null {
	const n = parseNodeName(text);
	return n === null ? null : `node${n}`;
}

export interface SessionAddress {
	readonly session: SessionId;
	readonly machine: MachineName;
	/** The tab's label: `console`, `sh1`. */
	readonly label: string;
}

const SESSION_ID = /^([^:]+):(console|sh([1-9]\d*))$/;

/** `node2:sh1` into its parts. Null for anything that is not a session's address. */
export function parseSessionId(text: string): SessionAddress | null {
	const match = SESSION_ID.exec(text);
	const machine = match && parseMachineName(match[1]);
	if (!match || !machine) return null;
	const label = match[2];
	if (label === "console") return { session: `${machine}:console`, machine, label };
	const shell = Number(match[3]);
	return Number.isSafeInteger(shell) ? { session: `${machine}:sh${shell}`, machine, label } : null;
}

export function sessionLabel(session: SessionId): string {
	return session.slice(session.indexOf(":") + 1);
}
