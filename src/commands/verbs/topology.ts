import {
	andList,
	type BridgePriority,
	type BridgeRef,
	type CableCounters,
	type Conditions,
	carriedWords,
	conditionsAt,
	conditionWords,
	costOf,
	DEFAULT_COST,
	DEFAULT_PRIORITY,
	droppedWords,
	type HeldPort,
	hasConditions,
	heldPorts,
	holdsNic,
	type LabState,
	type Machine,
	type MachineName,
	machineList,
	NOTHING_CARRIED,
	nicLabel,
	nicPortsOf,
	type PathCost,
	type Phase,
	PORTS,
	type PortNo,
	type PortRef,
	type PortVlan,
	plugsOf,
	portName,
	priorityOf,
	rootOf,
	type SwitchName,
	stpOn,
	type TreePort,
	treePortAt,
	treeRoleText,
	treeSummary,
	vlanOf,
	vlanText,
	type WrittenConditions,
	writtenConditions,
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
	/** Each as link's options take it: `{ delay: "100ms", loss: "20%" }`. A cable as good as new has none. */
	readonly conditions: WrittenConditions;
	/** The frames that reached its far end, either way, and those it dropped, by reason, since it was put in. */
	readonly carried: CableCounters;
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
	/**
	 * What it is in the spanning tree, there while its switch has spanning tree on and its link is up. A port whose
	 * state is discarding carries nothing: the tree has blocked it.
	 */
	readonly stp?: Pick<TreePort, "role" | "state">;
	/** What it adds to the way to the root through it, there when it is not 20000. */
	readonly cost?: PathCost;
}

/** A switch's part in the spanning tree, as its messages with its neighbours left it. */
export interface ListedTree {
	/** Its own bridge ID: its priority, and then its address. */
	readonly bridge: BridgeRef;
	/** The bridge it takes for the root, with the switch's name once that switch has said what it is. */
	readonly root: BridgeRef & { readonly switch?: SwitchName };
	/** What its way to the root costs: 0 for the root. */
	readonly cost: number;
}

export interface ListedSwitch {
	readonly name: SwitchName;
	/** All eight. */
	readonly ports: readonly ListedPort[];
	/** There while it storms. */
	readonly storm?: ListedStorm;
	/** There while it has spanning tree on. */
	readonly stp?: "on";
	/** Its priority in the spanning tree, there when it is not 32768. */
	readonly priority?: BridgePriority;
	/** There while it has spanning tree on, once it has said what it is in the tree. */
	readonly tree?: ListedTree;
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

function cable(held: HeldPort, carried: CableCounters): ListedCable {
	const its = { conditions: writtenConditions(held.conditions), carried };
	if (!holdsNic(held)) return { to: { kind: "port", ...held.far }, link: held.link, ...its };
	const { machine, nic } = held;
	const { life } = machine;
	const plug = plugsOf(life)[nic];
	const cut = plug?.kind === "port" && plug.link === "cut";
	return { to: end(machine, nic), link: cut ? "cut" : life.phase === "ready" ? "up" : "down", ...its };
}

function listedTree(lab: LabState, name: SwitchName): ListedTree | undefined {
	const reading = lab.trees[name];
	if (!reading) return undefined;
	const root = rootOf(lab, name);
	return { bridge: reading.bridge, root: { ...reading.root, ...(root ? { switch: root } : {}) }, cost: reading.cost };
}

function topologyOf(lab: LabState, carried: (port: PortRef) => CableCounters | undefined): Topology {
	return {
		switches: lab.switches.map((name): ListedSwitch => {
			const held = heldPorts(lab, name);
			const storm = lab.storms[name];
			const priority = priorityOf(lab, name);
			const tree = listedTree(lab, name);
			return {
				name,
				ports: PORTS.map((port): ListedPort => {
					const holder = held.find((other) => other.port === port);
					const ref = { switch: name, port };
					const counted = carried(ref) ?? NOTHING_CARRIED;
					const tree = treePortAt(lab, ref);
					const cost = costOf(lab, ref);
					return {
						port,
						cable: holder ? cable(holder, counted) : null,
						vlan: vlanOf(lab, ref),
						...(tree ? { stp: { role: tree.role, state: tree.state } } : {}),
						...(cost === DEFAULT_COST ? {} : { cost }),
					};
				}),
				...(storm ? { storm: { rate: storm.rate, dropped: storm.dropped } } : {}),
				...(stpOn(lab, name) ? { stp: "on" as const } : {}),
				...(priority === DEFAULT_PRIORITY ? {} : { priority }),
				...(tree ? { tree } : {}),
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

/**
 * `node3 · down · booting`, `wan:8 · up · alternate port · blocked · cost 200000`. A ready machine's state goes
 * without saying, and so do VLAN 1, a cost of 20000 and a port that the spanning tree has in use.
 */
function endLine(lab: LabState, to: CableEnd, link: string, { vlan, stp, cost }: Partial<ListedPort> = {}): string {
	const state = to.kind === "port" || to.state === "ready" ? [] : [to.state];
	const tree = treeRoleText(stp);
	const carried = !vlan || (vlan.mode === "access" && vlan.vlan === 1) ? [] : [vlanText(vlan)];
	const costs = cost === undefined ? [] : [`cost ${cost}`];
	return [endText(lab, to), link, ...state, ...(tree ? [tree] : []), ...costs, ...carried].join(" · ");
}

/** `delay 100 ms · loss 20% · 804 delivered · 196 dropped (196 by loss)`. A cable as good as new that dropped nothing says none of it. */
function cableWords(conditions: Conditions, { carried }: ListedCable): readonly string[] {
	if (!hasConditions(conditions) && droppedWords([carried]) === null) return [];
	return [...conditionWords(conditions), ...carriedWords(carried)];
}

/** The cables that have conditions, each once. */
const impaired = (lab: LabState): number =>
	lab.switches.flatMap((on) => heldPorts(lab, on)).filter((held) => hasConditions(held.conditions)).length -
	lab.switchCables.filter(({ conditions }) => conditions && hasConditions(conditions)).length;

const stormLine = ({ rate, dropped }: ListedStorm): string =>
	`storming · ${rate} looped frames a second · ${dropped} dropped`;

function rows(lab: LabState, { switches, unplugged }: Topology): readonly ReportRow[] {
	const listed = switches.map(({ name, ports: all, storm }): ReportRow => {
		const tree = treeSummary(lab, name);
		const taken = all.flatMap((held) => {
			const { port, cable } = held;
			if (!cable) return [];
			const words = cableWords(conditionsAt(lab, { switch: name, port }), cable);
			return [[`port ${port}`, endLine(lab, cable.to, cable.link, held), ...words].join(" · ")];
		});
		const free = all.flatMap(({ port, cable }) => (cable ? [] : [port]));
		const lines = [
			...(storm ? [stormLine(storm)] : []),
			...(tree ? [`spanning tree ${tree}`] : []),
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
		"List the wiring: each switch's eight ports, what each port's cable goes to, its link (up, cut, or down while its machine is not ready), conditions, what it delivered and dropped, and its VLAN or a trunk's VLANs. A cable between switches is at both its ports. With spanning tree on, a switch has stp, and tree: its bridge ID, root and root cost. Each port has its role and state: discarding is blocked. priority and cost are there when set. A storming switch has storm. Then the NICs in no switch.",
	danger: false,
	grammar: {},
	example: {},
	plan: (_a, lab) => ({ lab }),
	describe: ({ lab }) => `list ${count(lab.switches.length, "switch", "switches")} and what is plugged in`,
	async execute({ lab }, _ctx, deps) {
		const data = topologyOf(lab, deps.carried);
		const all = data.switches.flatMap(({ ports }) => ports);
		const taken = all.filter(({ cable }) => cable !== null).length;
		const storming = data.switches.flatMap(({ name, storm }) => (storm ? [name] : []));
		const blocked = all.filter(({ stp }) => stp?.state === "discarding").length;
		const header = [
			count(data.switches.length, "switch", "switches"),
			`${taken} of ${all.length} ports taken`,
			...(storming.length === 0 ? [] : [`${andList(storming)} storming`]),
			...(blocked === 0 ? [] : [`${count(blocked, "port")} blocked`]),
			...(impaired(lab) === 0 ? [] : [`${count(impaired(lab), "cable")} with conditions`]),
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
