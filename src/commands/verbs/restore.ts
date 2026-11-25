import {
	type Checkpoint,
	disksOf,
	isPlanError,
	type Machine,
	planRestore,
	type RestorePlan,
} from "../../model/index.ts";
import { defineVerb, Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { busySaving, checkpointOf } from "./checkpoint.ts";
import { whenSettled } from "./power.ts";
import { count, planErrorSentence } from "./words.ts";

interface Plan {
	readonly machine: Machine;
	readonly checkpoint: Checkpoint;
	readonly restore: RestorePlan;
}

const theDisks = ({ spec }: Machine): string => {
	const disks = disksOf(spec).length;
	return disks === 1 ? "disk" : `${disks} disks`;
};

export const restore = defineVerb({
	name: "restore",
	about: "go back to a checkpoint and boot",
	description:
		"Put all of a machine's disks back to a checkpoint and boot it. What was written to them since is lost, and so is what it runs. Every checkpoint stays. Returns the machine's state once it is ready or failed. A machine that could not be restored has failed with its disks as they were.",
	danger: true,
	phases: ["ready", "off", "failed"],
	grammar: { machine: slots.machine(), checkpoint: slots.checkpoint() },
	example: { machine: "node2", checkpoint: "before" },
	plan(a, lab): Plan | Refusal<"machine" | "checkpoint"> {
		const machine = lab.machines[a.machine];
		if (!machine) return refuse(`${a.machine} is gone.`, "machine");
		const busy = busySaving(machine);
		if (busy) return busy;
		const checkpoint = checkpointOf(machine, a.checkpoint);
		if (checkpoint instanceof Refusal) return checkpoint;
		const restore = planRestore(lab, a.machine, checkpoint.set);
		if (!restore) return refuse(`${a.machine} is no longer ready, off or failed.`, "machine");
		return isPlanError(restore) ? refuse(planErrorSentence(restore), "machine") : { machine, checkpoint, restore };
	},
	describe({ machine, checkpoint }) {
		return `put ${machine.name}'s ${theDisks(machine)} back to checkpoint ${checkpoint.name} and boot it`;
	},
	confirm({ machine, checkpoint }) {
		const { name, n, life, sessions } = machine;
		const shells = sessions.length - 1;
		const stops =
			life.phase !== "ready"
				? ""
				: `${name} stops without shutting down, so what it runs is lost${shells === 0 ? "" : ` and ${count(shells, "shell")} close${shells === 1 ? "s" : ""}`}. `;
		return {
			question: `Restore ${name} to ${checkpoint.name}?`,
			detail: `${stops}Everything written to its ${theDisks(machine)} since checkpoint ${checkpoint.name} was saved is gone. There is no undo.`,
			actionLabel: `Restore ${name} to ${checkpoint.name}`,
			machines: [{ n, name }],
			checkpoints: [checkpoint],
		};
	},
	async execute({ machine, checkpoint, restore }, ctx, deps) {
		deps.dispatch({ type: "cmd/restore", plan: restore });
		const doing = `restoring ${machine.name} to ${checkpoint.name}`;
		return whenSettled({ machines: [machine], skipped: [] }, doing, ctx, deps);
	},
	tool: {
		name: "checkpoint_restore",
		title: "Restore a checkpoint",
		policy: "ask",
		annotations: { consequentialHint: true },
	},
});
