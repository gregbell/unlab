import { FORCED_STOP, type LabState, type Machine, type MachineName, type Phase, savingOf } from "../../model/index.ts";
import { type CommandDeps, machineNow, Refusal, refuse } from "../define.ts";
import type { ReadContext, Selection } from "../grammar/slots.ts";
import type { Result, RunContext } from "../types.ts";
import { andList, count, skippedPart } from "./words.ts";

/** One machine as a power tool returns it. */
export interface PowerState {
	readonly name: MachineName;
	readonly state: Phase | "removed";
	/** Why it failed, or what its last stop could not do. */
	readonly reason?: string;
}

/** A machine as it was when a line was planned. */
type Planned = Pick<Machine, "n" | "name" | "life">;

export interface PowerPlan<M extends Planned = Planned> {
	readonly machines: readonly M[];
	readonly skipped: Selection["skipped"];
}

export function planStop(
	{ machines: names, skipped }: Selection,
	ctx: ReadContext,
): PowerPlan<Machine> | Refusal<"names"> {
	const machines: Machine[] = [];
	for (const name of names) {
		const machine = machineNow(name, ctx, "names");
		if (machine instanceof Refusal) return machine;
		const saving = savingOf(machine.life);
		if (saving) return refuse(`${name} is saving checkpoint ${saving.name}, so wait until it is done.`, "names");
		machines.push(machine);
	}
	return { machines, skipped };
}

/** `reboot node1 and node2 · closes 1 shell` */
export function describeStop(action: string, { machines, skipped }: PowerPlan<Machine>): string {
	const shells = machines.reduce((n, m) => n + m.sessions.length - 1, 0);
	return [
		`${action} ${andList(machines.map((m) => m.name))}`,
		...(shells === 0 ? [] : [`closes ${count(shells, "shell")}`]),
		...skippedPart(skipped),
	].join(" · ");
}

const STABLE: readonly Phase[] = ["ready", "off", "failed"];

/** The machine, unless it is gone or going. */
function still(lab: LabState, { n, name }: Planned): Machine | undefined {
	const machine = lab.machines[name];
	return machine?.n === n && machine.life.phase !== "removing" ? machine : undefined;
}

function changed(lab: LabState, planned: Planned): boolean {
	const life = still(lab, planned)?.life;
	return life?.phase !== planned.life.phase || life.attempt !== planned.life.attempt;
}

function settled(lab: LabState, planned: Planned): boolean {
	const phase = still(lab, planned)?.life.phase;
	return changed(lab, planned) && (phase === undefined || STABLE.includes(phase));
}

function stateOf(lab: LabState, planned: Planned): PowerState {
	const { name } = planned;
	const machine = still(lab, planned);
	if (!machine) return { name, state: "removed" };
	const { life, lastStop } = machine;
	const forced = planned.life.phase === "ready" && changed(lab, planned) && lastStop === "forced";
	const reason = life.phase === "failed" ? life.reason : forced ? FORCED_STOP : null;
	return { name, state: life.phase, ...(reason === null ? {} : { reason }) };
}

/**
 * Once the plan's event is dispatched. A person sees the machines change, so
 * their line is done when they start to. An agent's is done when they are
 * where they were going, so that its next command finds them there.
 */
export async function whenSettled(
	{ machines, skipped }: PowerPlan,
	doing: string,
	ctx: RunContext,
	deps: CommandDeps,
): Promise<Result> {
	const done = ctx.source === "agent" ? settled : changed;
	const lab = await deps.until((s) => machines.every((m) => done(s, m)), ctx.signal);
	const data = machines.map((m) => stateOf(lab, m));
	const now = data.map(({ name, state, reason }) =>
		reason === undefined ? `${name} ${state}` : `${name} ${state}: ${reason}`,
	);
	const text = ctx.source === "agent" ? now.join(", ") : doing;
	return { kind: "visible", text: [text, ...skippedPart(skipped)].join(" · "), data };
}
