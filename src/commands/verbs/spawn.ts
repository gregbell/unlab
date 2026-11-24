import { DISK_SIZES, isPlanError, MAX_MACHINES, type MachineName, type NicSpec, planSpawn } from "../../model/index.ts";
import { MAX_NICS, NICS, nicName } from "../../net/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList, imageLabel, planErrorSentence, ports } from "./words.ts";

function multiCpuBlocker(): string | undefined {
	if (globalThis.crossOriginIsolated === false || typeof SharedArrayBuffer !== "function")
		return "shared memory requires a cross-origin isolated page";
	if (typeof Atomics.waitAsync !== "function" || (typeof window !== "undefined" && typeof Worker !== "function"))
		return "the browser lacks support for shared CPU workers";
	return undefined;
}

export const MULTICPU_BLOCKER = multiCpuBlocker();
export const DEFAULT_CPUS = MULTICPU_BLOCKER ? 1 : 2;

/** `--net` as typed, for a machine of `count` NICs. Null when it names some other number of them. */
function nicSpecs(count: number, written: string): readonly NicSpec[] | null {
	const nets = written.split(",").map((net): NicSpec => ({ net: net === "none" ? "none" : "switch0" }));
	if (nets.length === 1) return Array.from({ length: count }, () => nets[0]);
	return nets.length === count ? nets : null;
}

export const spawn = defineVerb({
	name: "spawn",
	about: "boot machines",
	danger: false,
	grammar: {
		count: slots.count({ suggest: (lab) => [1, 2, 3].filter((n) => n <= MAX_MACHINES - lab.rail.length) }),
		image: slots.image(),
		mem: slots.option(
			"--mem",
			slots.count({ label: "MiB", noun: "a size in MiB", suggest: () => [128, 256, 512, 1024] }),
			256,
		),
		cpus: slots.option("--cpus", slots.count({ label: "CPUs", suggest: () => [1, 2, 4, 8, 16] }), DEFAULT_CPUS),
		disk: slots.option("--disk", slots.choice(DISK_SIZES), "4"),
		nics: slots.option(
			"--nics",
			slots.count({ label: "NICs", noun: "a number of NICs", suggest: () => NICS.map((nic) => nic + 1) }),
			1,
		),
		net: slots.exclusive("switch0", [slots.valued("--net", slots.networks()), slots.flag("--no-net", "none")]),
	},
	plan(a, lab) {
		if (a.cpus > 16) return refuse("Choose 1 to 16 CPUs per machine.", "cpus");
		if (a.cpus > 1 && MULTICPU_BLOCKER) return refuse(`Multiple CPUs unavailable: ${MULTICPU_BLOCKER}.`, "cpus");
		if (a.nics > MAX_NICS) return refuse(`A machine has 1 to ${MAX_NICS} NICs.`, "nics");
		const nics = nicSpecs(a.nics, a.net);
		if (nics === null) {
			const named = a.net.split(",").length;
			return refuse(
				named > MAX_NICS
					? `A machine has 1 to ${MAX_NICS} NICs, and --net names ${named}.`
					: `--net names ${named} NICs, so add --nics ${named}.`,
				"net",
			);
		}
		const plan = planSpawn(lab, a.count, { image: a.image, memMiB: a.mem, diskGiB: a.disk, cpus: a.cpus, nics });
		return isPlanError(plan)
			? refuse(
					planErrorSentence(plan, "Add --no-net to boot unplugged, or leave some NICs out with --net switch0,none."),
					plan.kind === "unknown-image" ? "image" : "count",
				)
			: plan;
	},
	describe(plan, lab) {
		const { machines, spec } = plan;
		const many = machines.length > 1;
		const plugged = machines.flatMap((m) => m.ports.flatMap((port) => port ?? []));
		const loose = NICS.filter((nic) => spec.nics[nic]?.net === "none").map(nicName);
		return [
			`boot ${andList(machines.map((m) => m.identity.name))}`,
			imageLabel(lab, spec.image),
			`${spec.memMiB} MiB${many ? " each" : ""}`,
			`${spec.cpus ?? 1} CPU${(spec.cpus ?? 1) === 1 ? "" : "s"}`,
			`${spec.diskGiB ?? "4"} GiB disk`,
			...(spec.nics.length === 1 ? [] : [`${spec.nics.length} NICs${many ? " each" : ""}`]),
			plugged.length === 0 ? "unplugged" : `plugged into switch0 on ${ports(plugged)}`,
			...(plugged.length === 0 || loose.length === 0 ? [] : [`${andList(loose)} unplugged`]),
		].join(" · ");
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/spawn", plan, at: deps.now() });
		const names = plan.machines.map((m) => m.identity.name);
		await deps.until((s) => names.every((name) => s.machines[name] !== undefined), ctx.signal);
		return { kind: "visible", text: `booting ${andList(names)}`, data: { names } satisfies SpawnData };
	},
	tool: {
		name: "machines_spawn",
		title: "Boot machines",
		description:
			"Boot new Linux machines on the lab's switch. Returns the names created. Each boots on its own and takes commands once ready.",
		policy: "ask",
	},
});

export interface SpawnData {
	readonly names: readonly MachineName[];
}
