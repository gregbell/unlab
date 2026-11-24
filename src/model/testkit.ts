// Shared by the model's tests. Every fixture is built through `update`, the way the app builds state.

import { isPlanError, planBootAgain, planLink, planSpawn } from "./machines.ts";
import type {
	AgentCall,
	CommandEvent,
	Effect,
	ImageInfo,
	LabEvent,
	LabState,
	Machine,
	MachineName,
	MachineSpec,
	RuntimeEvent,
	Source,
} from "./types.ts";
import { initialState, update } from "./update.ts";

export const IMAGES: readonly ImageInfo[] = [
	{ name: "alpine", label: "alpine 3.24" },
	{ name: "debian", label: "debian" },
];

/** Room for three columns and two rows. */
export const WIDE = { width: 1300, height: 500 };

/** In a browser that took the tools. */
export const emptyLab = (area: { width: number; height: number } = WIDE): LabState =>
	run(initialState(IMAGES, area), { type: "agent/webmcp", webmcp: { kind: "registered" } });

export function run(state: LabState, ...events: readonly LabEvent[]): LabState {
	return events.reduce((s, event) => update(s, event).state, state);
}

export function effectsOf(state: LabState, ...events: readonly LabEvent[]): Effect[] {
	const effects: Effect[] = [];
	let s = state;
	for (const event of events) {
		const step = update(s, event);
		effects.push(...step.effects);
		s = step.state;
	}
	return effects;
}

export interface SpawnOptions {
	readonly net?: MachineSpec["net"];
	readonly image?: string;
	readonly memMiB?: number;
	readonly at?: number;
}

export function spawnEvent(state: LabState, count: number, options: SpawnOptions = {}): CommandEvent {
	const spec = { image: options.image ?? "alpine", memMiB: options.memMiB ?? 256, net: options.net ?? "switch0" };
	const plan = planSpawn(state, count, spec);
	if (isPlanError(plan)) throw new Error(`cannot plan the spawn: ${JSON.stringify(plan)}`);
	return { type: "cmd/spawn", plan, at: options.at ?? state.now };
}

export function bootAgainEvent(state: LabState, machine: MachineName, at: number = state.now): CommandEvent {
	const plan = planBootAgain(state, machine);
	if (plan === null || isPlanError(plan)) throw new Error(`cannot plan boot again: ${JSON.stringify(plan)}`);
	return { type: "cmd/boot-again", machine, port: plan.port, at };
}

export function linkEvent(state: LabState, up: boolean, ...machines: readonly MachineName[]): CommandEvent {
	const changes = planLink(state, machines, up);
	if (isPlanError(changes)) throw new Error(`cannot plan the link change: ${JSON.stringify(changes)}`);
	return { type: "cmd/link", changes, cause: "bar" };
}

export const isReady = (machine: MachineName, attempt = 1, bootMs = 3582): RuntimeEvent => ({
	type: "vm/ready",
	machine,
	attempt,
	bootMs,
});

export const hasFailed = (machine: MachineName, attempt = 1, reason = "Kernel panic."): RuntimeEvent => ({
	type: "vm/failed",
	machine,
	attempt,
	reason,
});

export const hasStopped = (machine: MachineName, attempt = 1): RuntimeEvent => ({
	type: "vm/stopped",
	machine,
	attempt,
});

export const remove = (...machines: readonly MachineName[]): CommandEvent => ({
	type: "cmd/remove",
	machines,
	cause: "bar",
});

export const logged = (line: string, source: Source, at = 0): CommandEvent => ({
	type: "cmd/logged",
	line,
	source,
	at,
	outcome: "ok",
});

export const agentCall = (id: number, at: number, overrides: Partial<AgentCall> = {}): AgentCall => ({
	id,
	tool: "machines_list",
	line: "ls",
	status: "done",
	preview: null,
	actionLabel: null,
	result: null,
	at,
	...overrides,
});

/** node1..node<count>, all ready and plugged into ports 1..count. */
export function labWith(count: number, area: { width: number; height: number } = WIDE): LabState {
	let state = emptyLab(area);
	state = run(state, spawnEvent(state, count));
	return run(state, ...state.rail.map((name) => isReady(name)));
}

export function machine(state: LabState, name: MachineName): Machine {
	const found = state.machines[name];
	if (!found) throw new Error(`no ${name} in the lab`);
	return found;
}
