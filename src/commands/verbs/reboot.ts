import { defineVerb } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { describeStop, planStop, whenSettled } from "./power.ts";
import { andList } from "./words.ts";

export const reboot = defineVerb({
	name: "reboot",
	about: "shut machines down and boot them again",
	description:
		"Shut machines down and boot them again, with the same disks, name, cables and addresses that the lab set. Running programs end, and what ip, sysctl and mount set is gone. Returns each machine's state once it is ready or failed, which takes seconds and at most two and a half minutes.",
	danger: false,
	grammar: { names: slots.machines() },
	example: { names: "node2" },
	plan: (a, _lab, ctx) => planStop(a.names, ctx),
	describe: (plan) => describeStop("reboot", plan),
	async execute(plan, ctx, deps) {
		const names = plan.machines.map((m) => m.name);
		deps.dispatch({ type: "cmd/power", machines: names, next: "reboot" });
		return whenSettled(plan, `rebooting ${andList(names)}`, ctx, deps);
	},
	tool: {
		name: "machines_reboot",
		title: "Reboot machines",
		policy: "run",
	},
});
