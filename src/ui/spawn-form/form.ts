// What the Add machines form shows, derived from its choices and the lab.
// The form holds `spawn` arguments; the line, its preview and its errors come
// from the same command the bar and the agent use, so the three cannot drift.

import { type CommandService, isLineError, type LineError, type Preview, spawn } from "../../commands/index.ts";
import {
	type DiskSize,
	type HueNo,
	isPlanError,
	LAB_PREFIX_BITS,
	type LabState,
	MAX_MACHINES,
	type MachineName,
	type MachineSpec,
	PORTS,
	planSpawn,
	SWITCH_NAME,
	takenPorts,
} from "../../model/index.ts";

/** The memory choices, in MiB. */
export const MEMORY = [64, 128, 256, 512, 1024, 2048, 4096] as const;
export type Memory = (typeof MEMORY)[number];

/** Exactly the `spawn` verb's arguments, so a choice is a line by `format`. */
export interface SpawnChoice {
	readonly count: number;
	readonly image: string;
	readonly mem: Memory;
	readonly disk: DiskSize;
	readonly cpus: number;
	readonly net: MachineSpec["net"];
}

export interface NewMachine {
	readonly name: MachineName;
	readonly hue: HueNo;
	/** `10.88.0.14/24` */
	readonly address: string;
	/** `port 4`, or `unplugged`. */
	readonly port: string;
}

export interface FormView {
	/** The most the stepper allows: what the lab and, when plugging in, the switch have room for. 0 when nothing fits. */
	readonly most: number;
	/** `768 MiB of memory in total` */
	readonly memoryNote: string;
	/** What happens to the switch. The lab never has more machines than ports, so room runs out before ports do. */
	readonly networkNote: string;
	readonly machines: readonly NewMachine[];
	/** The bar line for this choice, as the bar would log it. */
	readonly line: string;
	/** The `machines_spawn(...)` call an agent would make. */
	readonly call: string;
	/** What the bar would show under the same line. */
	readonly check: { readonly ok: true; readonly preview: Preview } | { readonly ok: false; readonly error: LineError };
	/** `Boot 3 machines` */
	readonly bootLabel: string;
}

export function defaultChoice(lab: LabState): SpawnChoice {
	const choice: SpawnChoice = {
		count: 3,
		image: lab.images[0]?.name ?? "alpine",
		mem: 256,
		cpus: 1,
		disk: "4",
		net: SWITCH_NAME,
	};
	return { ...choice, count: Math.max(1, Math.min(choice.count, mostOf(choice, lab))) };
}

/** Asks the spawn plan itself, so the stepper and the verb agree on every limit, the address range included. */
function mostOf(choice: SpawnChoice, lab: LabState): number {
	const spec = { image: choice.image, memMiB: choice.mem, net: choice.net };
	for (let n = MAX_MACHINES; n > 0; n--) if (!isPlanError(planSpawn(lab, n, spec))) return n;
	return 0;
}

function memoryTotal(mib: number): string {
	return mib >= 1024 ? `${Math.round(mib / 102.4) / 10} GiB` : `${mib} MiB`;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

function networkNote(choice: SpawnChoice, lab: LabState): string {
	if (choice.net === "none") {
		return choice.count === 1
			? "It boots with no cable. Plug it in later from the switch."
			: "They boot with no cable. Plug them in later from the switch.";
	}
	const left = PORTS.length - takenPorts(lab).size - choice.count;
	return `${Math.max(0, left)} of ${PORTS.length} ports left on ${SWITCH_NAME} afterwards.`;
}

function machinesOf(choice: SpawnChoice, lab: LabState): readonly NewMachine[] {
	const plan = planSpawn(lab, choice.count, { image: choice.image, memMiB: choice.mem, net: choice.net });
	if (isPlanError(plan)) return [];
	return plan.machines.map(({ identity, hue, port }) => ({
		name: identity.name,
		hue,
		address: `${identity.ip}/${LAB_PREFIX_BITS}`,
		port: port === null ? "unplugged" : `port ${port}`,
	}));
}

export function formView(
	choice: SpawnChoice,
	lab: LabState,
	commands: Pick<CommandService, "registry" | "parse">,
): FormView {
	const command = commands.registry.command(spawn);
	const line = command.format(choice);
	const parsed = commands.parse(line);
	const preview = isLineError(parsed) ? parsed : parsed.preview(lab);
	const check = isLineError(preview) ? { ok: false as const, error: preview } : { ok: true as const, preview };
	const input = Object.entries(choice)
		.map(([key, value]) => `"${key}": ${JSON.stringify(value)}`)
		.join(", ");
	return {
		most: mostOf(choice, lab),
		memoryNote: `${memoryTotal(choice.count * choice.mem)} of memory in total`,
		networkNote: networkNote(choice, lab),
		machines: check.ok ? machinesOf(choice, lab) : [],
		line,
		call: `${command.tool?.name ?? "machines_spawn"}({${input}})`,
		check,
		bootLabel: `Boot ${plural(choice.count, "machine")}`,
	};
}
