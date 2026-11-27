import {
	type MachineName,
	type MacRow,
	macRows,
	macSeen,
	type PortNo,
	type SwitchName,
	type SwitchTotals,
	totalsText,
} from "../../model/index.ts";
import { type NicName, nicName } from "../../net/index.ts";
import { defineVerb } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import type { ReportRow } from "../types.ts";
import { andList, count } from "./words.ts";

/** An address a switch has learned, as `switch_macs` returns it. */
export interface ListedMac {
	readonly mac: string;
	readonly port: PortNo;
	readonly vlan: number;
	/** The machine whose NIC has the address, there while the address is a machine's of the lab. */
	readonly machine?: MachineName;
	readonly nic?: NicName;
	/** Whole seconds since a frame from it came in. */
	readonly age: number;
	/** Its port's link went down, so the switch sends nothing to it there until it is learned again. */
	readonly flushed: boolean;
}

/** One switch's MAC table and counters, as `switch_macs` returns them. */
export interface SwitchMacs {
	readonly switch: SwitchName;
	/** Since the switch was added. */
	readonly counters: SwitchTotals;
	readonly macs: readonly ListedMac[];
}

function listed({ mac, port, vlan, machine, nic, age, flushed }: MacRow): ListedMac {
	const whose = machine === null || nic === null ? {} : { machine, nic: nicName(nic) };
	return { mac, port, vlan, ...whose, age, flushed };
}

/** `52:54:00:88:00:0b · port 1 · node1 · 3 s ago`, as a row of the switch panel's table says it. VLAN 1 goes without saying. */
function macLine(row: MacRow): string {
	const vlan = row.vlan === 1 ? [] : [`vlan ${row.vlan}`];
	return [row.mac, `port ${row.port}`, ...(row.label === "" ? [] : [row.label]), ...vlan, macSeen(row)].join(" · ");
}

const switches = slots.switches();

export const macs = defineVerb({
	name: "macs",
	about: "list what switches have learned, and their counters",
	description:
		"List each switch's MAC table and counters, as the switch panel shows them. Each address has its port, its VLAN, the machine and NIC that have it, and its age in seconds. One is flushed while its port's link is down. The counters are the frames the switch took in, the copies it delivered to ports, and those it flooded, since it was added.",
	danger: false,
	grammar: { switches: { ...slots.optional(switches), about: `${switches.about} Left out, every switch.` } },
	example: { switches: "switch0" },
	plan: (a, lab) => ({ switches: a.switches?.switches ?? lab.switches }),
	describe: ({ switches }) => `list the MAC table and counters of ${andList(switches)}`,
	async execute({ switches }, _ctx, deps) {
		const lab = deps.state();
		const now = deps.switches.now();
		const tables = switches.map((name) => ({
			name,
			rows: macRows(lab, deps.switches.macTable(name), now),
			counters: deps.switches.totals(name),
		}));
		const rows = tables.map(({ name, rows, counters }): ReportRow => {
			const lines = rows.length === 0 ? ["nothing learned yet"] : rows.map(macLine);
			return { term: name, text: [totalsText(counters), ...lines].join("\n") };
		});
		const learned = tables.flatMap(({ rows }) => rows).filter(({ flushed }) => !flushed).length;
		const [only] = switches;
		const which = switches.length === 1 && only ? only : count(switches.length, "switch", "switches");
		const data: readonly SwitchMacs[] = tables.map(({ name, rows, counters }) => ({
			switch: name,
			counters: { in: counters.in, delivered: counters.delivered, flooded: counters.flooded },
			macs: rows.map(listed),
		}));
		return { kind: "report", header: `${which} · ${learned} learned`, blocks: [], rows, data };
	},
	tool: {
		name: "switch_macs",
		title: "Read switches' MAC tables",
		policy: "run",
		annotations: { readOnlyHint: true },
	},
});
