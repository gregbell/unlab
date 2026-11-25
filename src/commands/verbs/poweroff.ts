import { defineVerb } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { describeStop, planStop, whenSettled } from "./power.ts";
import { andList } from "./words.ts";

export const poweroff = defineVerb({
	name: "poweroff",
	about: "shut machines down and keep their disks",
	description:
		"Shut machines down. Each keeps its disks, name and cables, holds no memory, and boots again with machines_boot. Returns each machine's state once it is off, which takes a second or two, and at most half a minute for a guest that does not shut down.",
	danger: false,
	grammar: { names: slots.machines() },
	example: { names: "node2" },
	plan: (a, _lab, ctx) => planStop(a.names, ctx),
	describe: (plan) => describeStop("power off", plan),
	async execute(plan, ctx, deps) {
		const names = plan.machines.map((m) => m.name);
		deps.dispatch({ type: "cmd/power", machines: names, next: "off" });
		return whenSettled(plan, `powering off ${andList(names)}`, ctx, deps);
	},
	tool: {
		name: "machines_poweroff",
		title: "Power machines off",
		policy: "run",
	},
});
