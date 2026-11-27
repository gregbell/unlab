import { type LabState, type SwitchName, stpOn } from "../../model/index.ts";
import { defineVerb } from "../define.ts";
import * as slots from "../grammar/slots.ts";
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
		"Turn rapid spanning tree (RSTP) on or off for switches: lan, switch0,lan or all. It is off on a new switch, where a loop of cables storms. Switches with it on send each other BPDUs, choose a root, and block the ports that would close a loop, so a lab can have spare cables. When a cable in use is cut, a blocked port takes over. A switch with it off passes no BPDU on, so a loop through it still storms, and a port towards it carries after 3 seconds. topology has each port's role and state.",
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
