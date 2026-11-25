import {
	type CheckpointName,
	disksOf,
	type LabState,
	type Machine,
	type MachineName,
	savingOf,
	sizeText,
} from "../../model/index.ts";
import { defineVerb, type Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { lineError } from "../types.ts";
import { andList } from "./words.ts";

export interface CheckpointData {
	readonly machine: MachineName;
	readonly name: CheckpointName;
	readonly bytes: number;
}

/** Why the machine's disks are not to be touched now, or null. */
export function busySaving(machine: Machine): Refusal<"machine"> | null {
	const saving = savingOf(machine.life);
	return saving && refuse(`${machine.name} is saving checkpoint ${saving.name}, so wait until it is done.`, "machine");
}

/** The machine's checkpoint of that name, or what it has instead. */
export function checkpointOf(machine: Machine, name: CheckpointName) {
	const { checkpoints } = machine.sets;
	const found = checkpoints.find((checkpoint) => checkpoint.name === name);
	if (found) return found;
	const has = checkpoints.length === 0 ? "none" : andList(checkpoints.map((checkpoint) => checkpoint.name));
	return refuse(`${machine.name} has no checkpoint called ${name}. It has ${has}.`, "checkpoint");
}

/** The set is being saved by the machine that was asked to. */
const isSaving = (lab: LabState, { n, name }: Machine, set: number): boolean => {
	const machine = lab.machines[name];
	return machine?.n === n && savingOf(machine.life)?.set === set;
};

export const checkpoint = defineVerb({
	name: "checkpoint",
	about: "save a machine's disks as they are now",
	description:
		"Save all of a machine's disks as they are now, under a name. The machine is ready or off, and a ready one runs on. Programs and memory are not saved. Returns the bytes of storage it takes, once it is saved, about a second for each 100 MB.",
	danger: false,
	phases: ["ready", "off"],
	grammar: { machine: slots.machine(), checkpoint: slots.newCheckpoint() },
	example: { machine: "node2", checkpoint: "before" },
	plan(a, lab) {
		const machine = lab.machines[a.machine];
		if (machine?.life.phase !== "ready" && machine?.life.phase !== "off") {
			return refuse(`${a.machine} is no longer ready or off.`, "machine");
		}
		const busy = busySaving(machine);
		if (busy) return busy;
		if (machine.sets.checkpoints.some(({ name }) => name === a.checkpoint)) {
			const taken = `${a.machine} already has a checkpoint called ${a.checkpoint}`;
			return refuse(`${taken}, so choose another name, or delete it with forget.`, "checkpoint");
		}
		return { machine, checkpoint: a.checkpoint };
	},
	describe({ machine, checkpoint }) {
		const disks = disksOf(machine.spec).length;
		return `save ${machine.name}'s ${disks === 1 ? "disk" : `${disks} disks`} as checkpoint ${checkpoint}`;
	},
	async execute({ machine, checkpoint }, ctx, deps) {
		const set = machine.sets.next;
		deps.dispatch({ type: "cmd/checkpoint", machine: machine.name, name: checkpoint });
		// As for power, a person sees it go on, and why it could not.
		if (ctx.source !== "agent") {
			await deps.until((s) => (s.machines[machine.name]?.sets.next ?? 0) > set, ctx.signal);
			return { kind: "visible", text: `saving ${checkpoint} of ${machine.name}`, data: null };
		}
		const lab = await deps.until((s) => !isSaving(s, machine, set), ctx.signal);
		const now = lab.machines[machine.name];
		const saved = now?.n === machine.n ? now.sets.checkpoints.find((other) => other.set === set) : undefined;
		if (!saved) {
			const told = now?.n === machine.n && now.unsaved?.set === set ? now.unsaved.reason : null;
			const reason = told ?? `${machine.name} stopped before checkpoint ${checkpoint} was saved.`;
			return { kind: "failed", error: lineError(reason) };
		}
		const data: CheckpointData = { machine: machine.name, name: saved.name, bytes: saved.bytes };
		return { kind: "visible", text: `saved ${checkpoint} of ${machine.name} · ${sizeText(saved.bytes)}`, data };
	},
	tool: {
		name: "checkpoint_save",
		title: "Save a checkpoint",
		policy: "run",
	},
});
