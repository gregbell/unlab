import {
	type Address,
	DISK_SIZES,
	isPlanError,
	MAX_MACHINES,
	type MachineName,
	type NicRequest,
	type NicSpec,
	type PlanError,
	planSpawn,
} from "../../model/index.ts";
import { addressStr, MAX_NICS, NICS, nicName } from "../../net/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList, count, imageLabel, planErrorSentence, ports } from "./words.ts";

function multiCpuBlocker(): string | undefined {
	if (globalThis.crossOriginIsolated === false || typeof SharedArrayBuffer !== "function")
		return "shared memory requires a cross-origin isolated page";
	if (typeof Atomics.waitAsync !== "function" || (typeof window !== "undefined" && typeof Worker !== "function"))
		return "the browser lacks support for shared CPU workers";
	return undefined;
}

export const MULTICPU_BLOCKER = multiCpuBlocker();
export const DEFAULT_CPUS = MULTICPU_BLOCKER ? 1 : 2;

/** `--net` as typed, for a machine of `nics` NICs. Null when it names some other number of them. */
function networks(nics: number, written: string): readonly NicSpec["net"][] | null {
	const nets = written.split(",").map((net): NicSpec["net"] => (net === "none" ? "none" : "switch0"));
	if (nets.length === 1) return Array.from({ length: nics }, () => nets[0]);
	return nets.length === nics ? nets : null;
}

/** With no `--addr`, eth0 has the lab's default address and the others have none. */
function requestedAddress(addresses: readonly (Address | null)[] | null, nic: number): NicRequest["address"] {
	if (addresses === null) return nic === 0 ? "default" : null;
	return addresses[nic];
}

/** The argument a plan error is about. */
const ABOUT: Readonly<Record<PlanError["kind"], "count" | "image" | "addr" | "name">> = {
	"no-ports": "count",
	"no-room": "count",
	"unknown-image": "image",
	"name-taken": "name",
	"address-taken": "addr",
	"address-overlap": "addr",
	"address-gateway": "addr",
};

/** What the preview says of chosen addresses: nothing when the lab chooses. */
function addressParts(nics: readonly NicRequest[]): string[] {
	if (nics[0].address === "default") return [];
	return nics.map(({ address }, i) => {
		const what = address === null || address === "default" ? "no address" : addressStr(address);
		return nics.length === 1 ? what : `${nicName(NICS[i])} ${what}`;
	});
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
		name: slots.option("--name", slots.newName(), null),
		nics: slots.option(
			"--nics",
			slots.count({ label: "NICs", noun: "a number of NICs", suggest: () => NICS.map((nic) => nic + 1) }),
			1,
		),
		net: slots.exclusive("switch0", [slots.valued("--net", slots.networks()), slots.flag("--no-net", "none")]),
		addr: slots.option("--addr", slots.addresses(), null),
		gateway: slots.exclusive<"on" | "off">("on", [slots.flag("--no-gateway", "off")]),
	},
	plan(a, lab) {
		if (a.cpus > 16) return refuse("Choose 1 to 16 CPUs per machine.", "cpus");
		if (a.cpus > 1 && MULTICPU_BLOCKER) return refuse(`Multiple CPUs unavailable: ${MULTICPU_BLOCKER}.`, "cpus");
		if (a.nics > MAX_NICS) return refuse(`A machine has 1 to ${MAX_NICS} NICs.`, "nics");
		const nets = networks(a.nics, a.net);
		if (nets === null) {
			const named = a.net.split(",").length;
			return refuse(
				named > MAX_NICS
					? `A machine has 1 to ${MAX_NICS} NICs, and --net names ${named}.`
					: `--net names ${named} NICs, so add --nics ${named}.`,
				"net",
			);
		}
		if (a.addr !== null && a.addr.length !== a.nics) {
			const named = a.addr.length;
			return refuse(
				named > MAX_NICS
					? `A machine has 1 to ${MAX_NICS} NICs, and --addr names ${named}.`
					: named < a.nics
						? `--addr names ${count(named, "NIC")} of ${a.nics}, so end it with none for each of the others.`
						: `--addr names ${named} NICs, so add --nics ${named}.`,
				"addr",
			);
		}
		if (a.count > 1 && a.addr?.some((address) => address !== null)) {
			return refuse("--addr gives one machine its addresses, so spawn 1 at a time with it.", "addr");
		}
		if (a.count > 1 && a.name !== null)
			return refuse("--name names one machine, so spawn 1 at a time with it.", "name");
		const plan = planSpawn(lab, a.count, {
			image: a.image,
			...(a.name === null ? {} : { name: a.name }),
			memMiB: a.mem,
			diskGiB: a.disk,
			cpus: a.cpus,
			gateway: a.gateway === "on" && nets[0] === "switch0",
			nics: nets.map((net, nic) => ({ net, address: requestedAddress(a.addr, nic) })),
		});
		if (!isPlanError(plan)) return plan;
		const ports = "Add --no-net to boot unplugged, or leave some NICs out with --net switch0,none.";
		return refuse(planErrorSentence(plan, ports), ABOUT[plan.kind]);
	},
	describe(plan, lab) {
		const { machines, request: spec } = plan;
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
			...addressParts(spec.nics),
			...(spec.gateway || spec.nics[0].net === "none" ? [] : ["no package gateway"]),
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
			"Boot new Linux machines on the lab's switch. Returns the names created. Each boots on its own and takes commands once ready. gateway off leaves out the package gateway, so DHCP on eth0 goes to the other machines.",
		policy: "ask",
	},
});

export interface SpawnData {
	readonly names: readonly MachineName[];
}
