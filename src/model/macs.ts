import { type NicNo, nameOf, nicLabel, nicOfMac, parseMac } from "../net/index.ts";
import { severalNics } from "./machines.ts";
import { selectNames } from "./selectors.ts";
import type { LabState, MachineName, PortNo } from "./types.ts";

/** An address that a switch has learned, as its table holds it. */
export interface LearnedMac {
	readonly vlan: number;
	readonly mac: string;
	readonly port: PortNo;
	/** When a frame from it last came in, on the switch's clock. */
	readonly seen: number;
	/** Learned on a port whose link went down. Kept to be seen, never sent to. */
	readonly flushed: boolean;
}

/** What a switch has done with frames since it was added. */
export interface SwitchTotals {
	/** Frames it accepted. */
	readonly in: number;
	/** Copies handed to ports: a flood to two ports counts two. */
	readonly delivered: number;
	readonly flooded: number;
}

/** A row of a switch's MAC table, as `macs` gives it. */
export interface MacRow {
	readonly mac: string;
	readonly port: PortNo;
	readonly vlan: number;
	/** The machine whose NIC has the address, by the name it has now. Null for an address that is no machine's. */
	readonly machine: MachineName | null;
	readonly nic: NicNo | null;
	/** `node2`, `node2:eth1`, or empty for no machine's. */
	readonly label: string;
	/** Whole seconds since a frame from it came in. */
	readonly age: number;
	readonly flushed: boolean;
}

/** The table by port, then address, with whose each address is. `now` is on the switch's clock. */
export function macRows(lab: LabState, table: readonly LearnedMac[], now: number): readonly MacRow[] {
	const names = selectNames(lab);
	return [...table]
		.sort((a, b) => a.port - b.port || a.mac.localeCompare(b.mac))
		.map(({ mac, port, vlan, seen, flushed }) => {
			const at = nicOfMac(parseMac(mac), 0);
			const machine = at && nameOf(names, at.n);
			return {
				mac,
				port,
				vlan,
				machine,
				nic: at?.nic ?? null,
				label: at && machine !== null ? nicLabel(machine, at.nic, severalNics(lab, machine)) : "",
				age: Math.max(0, Math.floor((now - seen) / 1000)),
				flushed,
			};
		});
}

/** `3 s ago`, or why the switch no longer sends to it. */
export function macSeen({ age, flushed }: Pick<MacRow, "age" | "flushed">): string {
	return flushed ? "flushed, link down" : `${age} s ago`;
}

/** `120 in · 80 delivered · 12 flooded`. */
export function totalsText(totals: SwitchTotals): string {
	return `${totals.in} in · ${totals.delivered} delivered · ${totals.flooded} flooded`;
}
