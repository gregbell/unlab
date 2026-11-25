import {
	heldPorts,
	type LabState,
	type Machine,
	type MachineName,
	machineList,
	nicLabel,
	nicPortsOf,
	type Phase,
	PORTS,
	type PortNo,
	plugsOf,
	type SwitchName,
} from "../../model/index.ts";
import { NICS, type NicName, type NicNo, nicName } from "../../net/index.ts";
import { defineVerb } from "../define.ts";
import type { ReportRow } from "../types.ts";
import { count, ports } from "./words.ts";

/** One NIC, where a cable can end. */
export interface NicEnd {
	readonly kind: "nic";
	readonly machine: MachineName;
	readonly nic: NicName;
	/** The machine's. */
	readonly state: Phase;
}

/** What is at the other end of a cable. */
export type CableEnd = NicEnd;

export interface ListedCable {
	readonly to: CableEnd;
	/** `down` for a cable that is whole, to a machine that is not ready. */
	readonly link: "up" | "down" | "cut";
}

export interface ListedPort {
	readonly port: PortNo;
	/** Null when the port is free. */
	readonly cable: ListedCable | null;
}

export interface ListedSwitch {
	readonly name: SwitchName;
	/** All eight. */
	readonly ports: readonly ListedPort[];
}

/** The lab's wiring as `topology_read` returns it. */
export interface Topology {
	readonly switches: readonly ListedSwitch[];
	/** The NICs that are plugged into no switch. */
	readonly unplugged: readonly NicEnd[];
}

const end = ({ name, life }: Machine, nic: NicNo): NicEnd => ({
	kind: "nic",
	machine: name,
	nic: nicName(nic),
	state: life.phase,
});

function cable(machine: Machine, nic: NicNo): ListedCable {
	const { life } = machine;
	const plug = plugsOf(life)[nic];
	const cut = plug?.kind === "port" && plug.link === "cut";
	return { to: end(machine, nic), link: cut ? "cut" : life.phase === "ready" ? "up" : "down" };
}

function topologyOf(lab: LabState): Topology {
	return {
		switches: lab.switches.map((name): ListedSwitch => {
			const held = heldPorts(lab, name);
			return {
				name,
				ports: PORTS.map((port): ListedPort => {
					const holder = held.find((other) => other.port === port);
					return { port, cable: holder ? cable(holder.machine, holder.nic) : null };
				}),
			};
		}),
		unplugged: machineList(lab).flatMap((machine) => {
			const plugged = nicPortsOf(machine.life);
			return NICS.slice(0, machine.spec.nics.length).flatMap((nic) => (plugged[nic] ? [] : [end(machine, nic)]));
		}),
	};
}

function endText(lab: LabState, { machine, nic }: NicEnd): string {
	const record = lab.machines[machine];
	const no = NICS.find((k) => nicName(k) === nic);
	return record && no !== undefined ? nicLabel(record, no) : `${machine}:${nic}`;
}

/** `node3 · down · booting`. A ready machine's state goes without saying. */
function endLine(lab: LabState, to: NicEnd, link: string): string {
	return [endText(lab, to), link, ...(to.state === "ready" ? [] : [to.state])].join(" · ");
}

function rows(lab: LabState, { switches, unplugged }: Topology): readonly ReportRow[] {
	const listed = switches.map(({ name, ports: all }): ReportRow => {
		const taken = all.flatMap(({ port, cable }) =>
			cable ? [`port ${port} · ${endLine(lab, cable.to, cable.link)}`] : [],
		);
		const free = all.flatMap(({ port, cable }) => (cable ? [] : [port]));
		return { term: name, text: [...taken, ...(free.length === 0 ? [] : [`${ports(free)} · free`])].join("\n") };
	});
	if (unplugged.length === 0) return listed;
	const loose = unplugged.map((nic) => endLine(lab, nic, "no cable"));
	return [...listed, { term: "unplugged", text: loose.join("\n") }];
}

export const topology = defineVerb({
	name: "topology",
	about: "list switches, their ports and what is plugged in",
	description:
		"List the lab's wiring: every switch with its eight ports, what each port's cable goes to, and the cable's link: up, cut, or down when the machine at its end is not ready. Then the NICs that are plugged into no switch.",
	danger: false,
	grammar: {},
	example: {},
	plan: (_a, lab) => ({ lab }),
	describe: ({ lab }) => `list ${count(lab.switches.length, "switch", "switches")} and what is plugged in`,
	async execute({ lab }) {
		const data = topologyOf(lab);
		const all = data.switches.flatMap(({ ports }) => ports);
		const taken = all.filter(({ cable }) => cable !== null).length;
		const header = `${count(data.switches.length, "switch", "switches")} · ${taken} of ${all.length} ports taken`;
		return { kind: "report", header, blocks: [], rows: rows(lab, data), data };
	},
	tool: {
		name: "topology_read",
		title: "Read the topology",
		policy: "run",
		annotations: { readOnlyHint: true },
	},
});
