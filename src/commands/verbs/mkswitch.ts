import { MAX_SWITCHES, planSwitch, type SwitchName } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { nameTaken } from "./words.ts";

export interface SwitchData {
	readonly name: SwitchName;
}

export const mkswitch = defineVerb({
	name: "mkswitch",
	about: "add a switch",
	description: `Add a switch of 8 ports with nothing plugged in, and return its name. A lab has up to ${MAX_SWITCHES} switches. No frame passes from one to another except through a machine with a NIC on each. spawn plugs NICs into it with net, and plug moves them there.`,
	danger: false,
	grammar: { name: slots.optional(slots.newSwitch()) },
	example: { name: "lan" },
	plan(a, lab) {
		const plan = planSwitch(lab, a.name);
		if (!("kind" in plan)) return plan;
		if (plan.kind === "name-taken") return refuse(nameTaken(plan), "name");
		return refuse(`The lab has all ${MAX_SWITCHES} switches that it can, so remove one with rmswitch first.`);
	},
	describe: ({ name }) => `add ${name} · a switch of 8 ports, nothing plugged in`,
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/switch-add", plan });
		await deps.until((s) => s.switches.includes(plan.name), ctx.signal);
		return { kind: "visible", text: `added ${plan.name}`, data: { name: plan.name } satisfies SwitchData };
	},
	tool: { name: "switch_add", title: "Add a switch", policy: "run" },
});
