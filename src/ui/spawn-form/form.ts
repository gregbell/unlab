// What the Add machines form shows, derived from its choices and the lab.
// The form holds `spawn` arguments; the line, its preview and its errors come
// from the same command the bar and the agent use, so the three cannot drift.

import { type CommandService, DEFAULT_CPUS, isLineError, type LineError, spawn } from "../../commands/index.ts";
import {
	DEFAULT_SWITCH,
	type DiskSize,
	type HueNo,
	isPlanError,
	type LabState,
	MAX_MACHINES,
	type MachineName,
	type NicSpec,
	planSpawn,
	portLabel,
	type SpawnRequest,
} from "../../model/index.ts";
import { addressStr } from "../../net/index.ts";

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
	/** The form gives every machine one NIC. The bar's `--nics` gives more. */
	readonly nics: 1;
	readonly net: NicSpec["net"];
	/** The form leaves these to the lab. The bar's `--extra-disk`, `--name`, `--addr` and `--no-gateway` choose. */
	readonly extraDisk: null;
	readonly name: null;
	readonly addr: null;
	readonly gateway: "on";
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
	readonly machines: readonly NewMachine[];
	/** The bar line for this choice, as the bar would log it. */
	readonly line: string;
	readonly error: LineError | null;
	/** `Boot 3 machines` */
	readonly bootLabel: string;
}

export function defaultChoice(lab: LabState): SpawnChoice {
	const choice: SpawnChoice = {
		count: 2,
		image: lab.images.find((image) => image.name === "alpine")?.name ?? lab.images[0]?.name ?? "alpine",
		mem: 256,
		cpus: DEFAULT_CPUS,
		disk: "4",
		extraDisk: null,
		nics: 1,
		net: DEFAULT_SWITCH,
		name: null,
		addr: null,
		gateway: "on",
	};
	return { ...choice, count: Math.max(1, Math.min(choice.count, mostOf(choice, lab))) };
}

/** Asks the spawn plan itself, so the stepper and the verb agree on every limit, the address range included. */
function mostOf(choice: SpawnChoice, lab: LabState): number {
	for (let n = MAX_MACHINES; n > 0; n--) if (!isPlanError(planSpawn(lab, n, requestOf(choice)))) return n;
	return 0;
}

function requestOf({ image, mem, disk, net }: SpawnChoice): SpawnRequest {
	return {
		image,
		memMiB: mem,
		disks: { root: disk, extra: [] },
		gateway: net !== "none",
		nics: [{ net, address: "default" }],
	};
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

function machinesOf(choice: SpawnChoice, lab: LabState): readonly NewMachine[] {
	const plan = planSpawn(lab, choice.count, requestOf(choice));
	if (isPlanError(plan)) return [];
	return plan.machines.map(({ identity, hue, ports: [port], spec }) => ({
		name: identity.name,
		hue,
		address: spec.nics[0].address ? addressStr(spec.nics[0].address) : "no address",
		port: port === null ? "unplugged" : portLabel(lab, port),
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
	const error = isLineError(parsed) ? parsed : parsed.validate(lab);
	return {
		most: mostOf(choice, lab),
		machines: !error ? machinesOf(choice, lab) : [],
		line,
		error,
		bootLabel: `Boot ${plural(choice.count, "machine")}`,
	};
}
