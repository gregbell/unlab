import { isPlanError, type Machine, planBoot, savingOf } from "../../model/index.ts";
import { defineVerb, machineNow, Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { whenSettled } from "./power.ts";
import { andList, imageLabel, planErrorSentence, pluggedInto, skippedPart } from "./words.ts";

/** Same name, hue, image, memory and disks. An off machine is still plugged in; a failed one takes the lowest free ports. */
export const boot = defineVerb({
	name: "boot",
	about: "boot machines that are off or failed",
	description:
		"Boot machines that are off or failed, with the disks they had. Returns each machine's state once it is ready or failed, which takes seconds and at most two minutes.",
	danger: false,
	phases: ["off", "failed"],
	grammar: { names: slots.machines() },
	example: { names: "node2" },
	plan(a, lab, ctx) {
		const machines: Machine[] = [];
		for (const name of a.names.machines) {
			const machine = machineNow(name, ctx, "names");
			if (machine instanceof Refusal) return machine;
			if (savingOf(machine.life)) return refuse(`${name} is saving a checkpoint, so wait until it is done.`, "names");
			machines.push(machine);
		}
		const plans = planBoot(lab, a.names.machines);
		if (isPlanError(plans)) return refuse(planErrorSentence(plans), "names");
		return { plans, machines, skipped: a.names.skipped };
	},
	describe({ plans, machines, skipped }, lab) {
		const plugged = plans.flatMap((plan) => plan.ports.flatMap((port) => port ?? []));
		const same = (of: (m: Machine) => string): string[] => {
			const said = [...new Set(machines.map(of))];
			return said.length === 1 ? said : [];
		};
		return [
			`boot ${andList(machines.map((m) => m.name))}${machines.every((m) => m.life.phase === "failed") ? " again" : ""}`,
			...same((m) => imageLabel(lab, m.spec.image)),
			...same((m) => `${m.spec.memMiB} MiB${machines.length > 1 ? " each" : ""}`),
			pluggedInto(plugged),
			...skippedPart(skipped),
		].join(" · ");
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/boot", machines: plan.plans, at: deps.now() });
		return whenSettled(plan, `booting ${andList(plan.machines.map((m) => m.name))}`, ctx, deps);
	},
	tool: {
		name: "machines_boot",
		title: "Power machines on",
		policy: "run",
	},
});
