import { type Checkpoint, type CheckpointName, type Machine, type MachineName, sizeText } from "../../model/index.ts";
import { defineVerb, Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { checkpointOf } from "./checkpoint.ts";

interface Plan {
	readonly machine: Machine;
	readonly checkpoint: Checkpoint;
}

export interface ForgetData {
	readonly machine: MachineName;
	readonly removed: CheckpointName;
}

export const forget = defineVerb({
	name: "forget",
	about: "delete a checkpoint",
	description: "Delete one checkpoint of a machine and free its storage. The machine's disks are left alone.",
	danger: true,
	phases: ["booting", "ready", "stopping", "off", "restoring", "failed"],
	grammar: { machine: slots.machine(), checkpoint: slots.checkpoint() },
	example: { machine: "node2", checkpoint: "before" },
	plan(a, lab): Plan | Refusal<"machine" | "checkpoint"> {
		const machine = lab.machines[a.machine];
		if (!machine) return refuse(`${a.machine} is gone.`, "machine");
		const checkpoint = checkpointOf(machine, a.checkpoint);
		if (checkpoint instanceof Refusal) return checkpoint;
		if (machine.life.phase === "restoring" && machine.life.from.set === checkpoint.set) {
			return refuse(`${a.machine} is being restored to ${checkpoint.name}, so wait until it has been.`, "checkpoint");
		}
		return { machine, checkpoint };
	},
	describe({ machine, checkpoint }) {
		return `delete checkpoint ${checkpoint.name} of ${machine.name} · frees ${sizeText(checkpoint.bytes)}`;
	},
	confirm({ machine, checkpoint }) {
		const { n, name } = machine;
		return {
			question: `Delete checkpoint ${checkpoint.name} of ${name}?`,
			detail: `${name} cannot go back to it then. Its disks stay as they are now. There is no undo.`,
			actionLabel: `Delete checkpoint ${checkpoint.name} of ${name}`,
			machines: [{ n, name }],
			checkpoints: [checkpoint],
		};
	},
	async execute({ machine, checkpoint }, ctx, deps) {
		deps.dispatch({ type: "cmd/forget", machine: machine.name, set: checkpoint.set });
		await deps.until((s) => {
			const now = s.machines[machine.name];
			return now?.n !== machine.n || now.sets.checkpoints.every(({ set }) => set !== checkpoint.set);
		}, ctx.signal);
		const data: ForgetData = { machine: machine.name, removed: checkpoint.name };
		return { kind: "visible", text: `deleted checkpoint ${checkpoint.name} of ${machine.name}`, data };
	},
	tool: {
		name: "checkpoint_remove",
		title: "Delete a checkpoint",
		policy: "ask",
		annotations: { consequentialHint: true },
	},
});
