import {
	type BridgePriority,
	costOf,
	type HeldPort,
	type LabState,
	type PathCost,
	type PortRef,
	portLabel,
	portName,
	priorityOf,
	type SwitchName,
	stpOn,
} from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { HOLDING, inIt } from "./vlan.ts";
import { andList } from "./words.ts";

/** The switches of an `stp` line as `switch_stp` returns them, with what each is now. */
export interface StpState {
	readonly stp: "on" | "off";
	readonly switches: readonly SwitchName[];
	/** Those of them that were so before, which the line left as they were. */
	readonly already: readonly SwitchName[];
}

interface StpPlan {
	readonly on: boolean;
	readonly switches: readonly SwitchName[];
	readonly already: readonly SwitchName[];
}

const word = (on: boolean): "on" | "off" => (on ? "on" : "off");

/** `lan was already on`. */
const alreadyPart = ({ on, already }: StpPlan): string[] =>
	already.length === 0 ? [] : [`${andList(already)} ${already.length === 1 ? "was" : "were"} already ${word(on)}`];

function described(plan: StpPlan, lab: LabState): string {
	const { on, switches, already } = plan;
	const changed = switches.filter((name) => !already.includes(name));
	if (changed.length === 0) return `change nothing: spanning tree is already ${word(on)} for ${andList(switches)}`;
	const what = on
		? "the switches that have it on block the ports that would close a loop between them"
		: lab.switchCables.length === 0
			? "every port carries frames"
			: "every port carries frames, so a loop of cables storms";
	return [`turn spanning tree ${word(on)} for ${andList(changed)}`, what, ...alreadyPart(plan)].join(" · ");
}

export const stp = defineVerb({
	name: "stp",
	about: "turn spanning tree on or off for switches",
	description:
		"Turn rapid spanning tree (RSTP) on or off for switches: lan, switch0,lan or all. It is off on a new switch, where a loop of cables storms. Switches with it on send each other BPDUs, choose a root, and block the ports that would close a loop, so a lab can have spare cables. If a cable in use is cut, a blocked port takes over. A switch with it off passes no BPDU on, so a loop through it still storms. priority and cost steer the root and which port blocks. topology has each port's role and state.",
	danger: false,
	grammar: {
		stp: slots.choice("on to take part in the spanning tree, off to take none.", ["on", "off"]),
		switches: slots.switches(),
	},
	example: { stp: "on", switches: "all" },
	plan(a, lab): StpPlan {
		const on = a.stp === "on";
		const { switches } = a.switches;
		return { on, switches, already: switches.filter((name) => stpOn(lab, name) === on) };
	},
	describe: described,
	async execute(plan, ctx, deps) {
		const { on, switches, already } = plan;
		deps.dispatch({ type: "cmd/stp", switches, on });
		await deps.until((s) => switches.every((name) => !s.switches.includes(name) || stpOn(s, name) === on), ctx.signal);
		const data: StpState = { stp: word(on), switches, already };
		const text = [`spanning tree ${word(on)} for ${andList(switches)}`, ...alreadyPart(plan)].join(" · ");
		return { kind: "visible", text, data };
	},
	tool: { name: "switch_stp", title: "Turn spanning tree on or off", policy: "run" },
});

/** `spanning tree is off for wan, so it counts once it is on`, for those of the switches that take no part. */
function offPart(lab: LabState, switches: readonly SwitchName[], what: string): string[] {
	const off = switches.filter((name) => !stpOn(lab, name));
	if (off.length === 0) return [];
	return [`spanning tree is off for ${andList(off)}, so ${what} once it is on`];
}

/** The switches of a `priority` line as `switch_priority` returns them. */
export interface PriorityState {
	readonly switches: readonly SwitchName[];
	readonly priority: BridgePriority;
	/** Those of them that had it before. */
	readonly already: readonly SwitchName[];
}

interface PriorityPlan extends PriorityState {
	readonly notes: readonly string[];
}

export const priority = defineVerb({
	name: "priority",
	about: "set a switch's priority in the spanning tree",
	description:
		"Set the spanning tree priority of switches: lan, switch0,lan or all. It is a step of 4096 from 0 to 61440, and 32768 on a new switch. The lowest priority is the root, and of two the same, the lower address. So priority lan 4096 makes lan the root, and which ports block can change with it. A switch keeps its priority while spanning tree is off for it. topology has each switch's bridge ID, its priority and address, and its root. Returns the switches and the priority.",
	danger: false,
	grammar: { switches: slots.switches(), priority: slots.priority() },
	example: { switches: "lan", priority: 4096 },
	plan(a, lab): PriorityPlan {
		const { switches } = a.switches;
		const already = switches.filter((name) => priorityOf(lab, name) === a.priority);
		return { switches, priority: a.priority, already, notes: offPart(lab, switches, "it counts") };
	},
	describe({ switches, priority, already, notes }) {
		const changed = switches.filter((name) => !already.includes(name));
		if (changed.length === 0) return `change nothing: the priority of ${andList(switches)} is already ${priority}`;
		const rest = already.length === 0 ? [] : [`${andList(already)} already had it`];
		return [
			`set the priority of ${andList(changed)} to ${priority}`,
			"the lowest priority is the root",
			...rest,
			...notes,
		].join(" · ");
	},
	async execute({ switches, priority, already, notes }, ctx, deps) {
		deps.dispatch({ type: "cmd/priority", switches, priority });
		await deps.until(
			(s) => switches.every((name) => !s.switches.includes(name) || priorityOf(s, name) === priority),
			ctx.signal,
		);
		const data: PriorityState = { switches, priority, already };
		return { kind: "visible", text: [`priority ${priority} for ${andList(switches)}`, ...notes].join(" · "), data };
	},
	tool: { name: "switch_priority", title: "Set a switch's spanning tree priority", policy: "run" },
});

/** A port and what it costs, as `port_cost` returns it. */
export interface PortCostState extends PortRef {
	readonly cost: PathCost;
}

interface CostPlan {
	readonly port: PortRef;
	readonly held: HeldPort;
	readonly cost: PathCost;
	readonly already: boolean;
	readonly notes: readonly string[];
}

export const cost = defineVerb({
	name: "cost",
	about: "set what a switch port costs in the spanning tree",
	description:
		"Set a port's path cost in the spanning tree, from 1 to 200000000, and 20000 on a new port. Name the port (lan:3), or the NIC whose cable is in it (node2). A switch's way to the root costs what the ports it enters by add up to, and each switch takes the way that costs least, so a dearer port is the one to block. A port costs 20000 again once nothing is in it. Returns the port and its cost.",
	danger: false,
	phases: HOLDING,
	grammar: { port: slots.port(), cost: slots.cost() },
	example: { port: "lan:3", cost: 200_000 },
	plan(a, lab, ctx) {
		const read = slots.readPort(a.port, ctx);
		if (read instanceof slots.Miss) return refuse(String(read.message), "port");
		const { ref, held } = read;
		const notes = offPart(lab, [ref.switch], "the cost counts");
		return { port: ref, held, cost: a.cost, already: costOf(lab, ref) === a.cost, notes } satisfies CostPlan;
	},
	describe({ port, held, cost, already, notes }, lab) {
		const where = portLabel(lab, port);
		const what = already ? `change nothing: ${where} already costs ${cost}` : `make ${where} cost ${cost}`;
		return [what, inIt(lab, held), ...notes].join(" · ");
	},
	async execute({ port, cost, already, notes }, ctx, deps) {
		if (!already) {
			deps.dispatch({ type: "cmd/cost", port, cost });
			await deps.until((s) => costOf(s, port) === cost, ctx.signal);
		}
		const data: PortCostState = { ...port, cost };
		const text = [`${portName(port)} ${already ? "already " : ""}costs ${cost}`, ...notes].join(" · ");
		return { kind: "visible", text, data };
	},
	tool: { name: "port_cost", title: "Set a switch port's spanning tree cost", policy: "run" },
});
