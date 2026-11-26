import {
	andList,
	type HeldPort,
	heldPorts,
	holdsNic,
	type LabState,
	type Machine,
	type MachineName,
	machineList,
	nicLabel,
	nicPortsOf,
	type Phase,
	PORTS,
	type PortNo,
	type PortVlan,
	plugsOf,
	portName,
	type SwitchName,
	vlanOf,
	vlanText,
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

/** One port of a switch, where a cable from another port of a switch ends. */
export interface PortEnd {
	readonly kind: "port";
	readonly switch: SwitchName;
	readonly port: PortNo;
}

/** What is at the other end of a cable. */
export type CableEnd = NicEnd | PortEnd;

export interface ListedCable {
	readonly to: CableEnd;
	/** `down` for a cable that is whole, to a machine that is not ready. */
	readonly link: "up" | "down" | "cut";
}

/** A switch that looped frames come into: one on a loop of cables, or one that such a loop reaches. */
export interface ListedStorm {
	/** Looped frames a second, as they came into it over the last second. */
	readonly rate: number;
	/** The frames it did not send on since the storm began, which is how the lab stays responsive. */
	readonly dropped: number;
}

export interface ListedPort {
	readonly port: PortNo;
	/** Null when the port is free. */
	readonly cable: ListedCable | null;
	/** What it carries. A free port is an access port of VLAN 1. */
	readonly vlan: PortVlan;
}

export interface ListedSwitch {
	readonly name: SwitchName;
	/** All eight. */
	readonly ports: readonly ListedPort[];
	/** There while it storms. */
	readonly storm?: ListedStorm;
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

function cable(held: HeldPort): ListedCable {
	if (!holdsNic(held)) return { to: { kind: "port", ...held.far }, link: held.link };
	const { machine, nic } = held;
	const { life } = machine;
	const plug = plugsOf(life)[nic];
	const cut = plug?.kind === "port" && plug.link === "cut";
	return { to: end(machine, nic), link: cut ? "cut" : life.phase === "ready" ? "up" : "down" };
}

function topologyOf(lab: LabState): Topology {
	return {
		switches: lab.switches.map((name): ListedSwitch => {
			const held = heldPorts(lab, name);
			const storm = lab.storms[name];
			return {
				name,
				ports: PORTS.map((port): ListedPort => {
					const holder = held.find((other) => other.port === port);
					return { port, cable: holder ? cable(holder) : null, vlan: vlanOf(lab, { switch: name, port }) };
				}),
				...(storm ? { storm: { rate: storm.rate, dropped: storm.dropped } } : {}),
			};
		}),
		unplugged: machineList(lab).flatMap((machine) => {
			const plugged = nicPortsOf(machine.life);
			return NICS.slice(0, machine.spec.nics.length).flatMap((nic) => (plugged[nic] ? [] : [end(machine, nic)]));
		}),
	};
}

function endText(lab: LabState, to: CableEnd): string {
	if (to.kind === "port") return portName(to);
	const { machine, nic } = to;
	const record = lab.machines[machine];
	const no = NICS.find((k) => nicName(k) === nic);
	return record && no !== undefined ? nicLabel(record, no) : `${machine}:${nic}`;
}

/** `node3 · down · booting`. A ready machine's state goes without saying, and so does VLAN 1. */
function endLine(lab: LabState, to: CableEnd, link: string, vlan: PortVlan | null = null): string {
	const state = to.kind === "port" || to.state === "ready" ? [] : [to.state];
	const carried = vlan === null || (vlan.mode === "access" && vlan.vlan === 1) ? [] : [vlanText(vlan)];
	return [endText(lab, to), link, ...state, ...carried].join(" · ");
}

const stormLine = ({ rate, dropped }: ListedStorm): string =>
	`storming · ${rate} looped frames a second · ${dropped} dropped`;

function rows(lab: LabState, { switches, unplugged }: Topology): readonly ReportRow[] {
	const listed = switches.map(({ name, ports: all, storm }): ReportRow => {
		const taken = all.flatMap(({ port, cable, vlan }) =>
			cable ? [`port ${port} · ${endLine(lab, cable.to, cable.link, vlan)}`] : [],
		);
		const free = all.flatMap(({ port, cable }) => (cable ? [] : [port]));
		const lines = [
			...(storm ? [stormLine(storm)] : []),
			...taken,
			...(free.length === 0 ? [] : [`${ports(free)} · free`]),
		];
		return { term: name, text: lines.join("\n") };
	});
	if (unplugged.length === 0) return listed;
	const loose = unplugged.map((nic) => endLine(lab, nic, "no cable"));
	return [...listed, { term: "unplugged", text: loose.join("\n") }];
}

export const topology = defineVerb({
	name: "topology",
	about: "list switches, their ports and what is plugged in",
	description:
		"List the wiring: every switch with its eight ports, what each port's cable goes to, its link (up, cut, or down while the machine at its end is not ready), and what the port carries: a VLAN, or as a trunk the VLANs it allows and its native one. A cable between switches is at both its ports. A switch that looped frames come into has storm: how many came in the last second, and how many it dropped. Then the NICs in no switch. Port 3 of lan is lan:3.",
	danger: false,
	grammar: {},
	example: {},
	plan: (_a, lab) => ({ lab }),
	describe: ({ lab }) => `list ${count(lab.switches.length, "switch", "switches")} and what is plugged in`,
	async execute({ lab }) {
		const data = topologyOf(lab);
		const all = data.switches.flatMap(({ ports }) => ports);
		const taken = all.filter(({ cable }) => cable !== null).length;
		const storming = data.switches.flatMap(({ name, storm }) => (storm ? [name] : []));
		const header = [
			count(data.switches.length, "switch", "switches"),
			`${taken} of ${all.length} ports taken`,
			...(storming.length === 0 ? [] : [`${andList(storming)} storming`]),
		].join(" · ");
		return { kind: "report", header, blocks: [], rows: rows(lab, data), data };
	},
	tool: {
		name: "topology_read",
		title: "Read the topology",
		policy: "run",
		annotations: { readOnlyHint: true },
	},
});
