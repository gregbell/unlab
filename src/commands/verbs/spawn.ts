import {
	type Address,
	DEFAULT_SWITCH,
	DISK_SIZES,
	type Disks,
	isPlanError,
	MAX_MACHINES,
	MAX_MEM_MIB,
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
const MAX_CPUS = 16;
const NETWORKS = slots.networks();
export const DEFAULT_CPUS = MULTICPU_BLOCKER ? 1 : 2;

/** `--net` as typed, for a machine of `nics` NICs. Null when it names some other number of them. */
function networks(nics: number, written: string): readonly NicSpec["net"][] | null {
	const nets = written.split(",").map((net): NicSpec["net"] => (net === "none" ? "none" : DEFAULT_SWITCH));
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

/** `extra disk of 1 GiB`, `extra disks of 1 and 4 GiB each`. */
function extraDisks({ extra }: Disks, many: boolean): string[] {
	if (extra.length === 0) return [];
	return [`${extra.length === 1 ? "extra disk" : "extra disks"} of ${andList(extra)} GiB${many ? " each" : ""}`];
}

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
	description: `Boot new Linux machines and return their names. Each boots on its own: ls (machines_list) says when it is ready, or failed and why. A NIC that is plugged in takes one of ${DEFAULT_SWITCH}'s 8 ports. The package gateway gives eth0 10.0.2.15 and a default route, for package installs only. gateway off leaves it out, so DHCP on eth0 goes to the other machines. Chosen addresses are set again at every boot, and each machine's /etc/hosts names the others.`,
	danger: false,
	grammar: {
		count: slots.count(`How many machines. The lab holds ${MAX_MACHINES}.`, {
			suggest: (lab) => [1, 2, 3].filter((n) => n <= MAX_MACHINES - lab.rail.length),
		}),
		image: slots.image(),
		mem: slots.option(
			"--mem",
			slots.count(`The memory of each machine, in MiB, up to ${MAX_MEM_MIB}.`, {
				label: "MiB",
				noun: "a size in MiB such as 512",
				suggest: () => [128, 256, 512, 1024],
			}),
			256,
		),
		cpus: slots.option(
			"--cpus",
			slots.count(`The CPUs of each machine, 1 to ${MAX_CPUS}.`, {
				label: "CPUs",
				noun: "a number of CPUs such as 2",
				suggest: () => [1, 2, 4, 8, 16],
			}),
			DEFAULT_CPUS,
		),
		disk: slots.option(
			"--disk",
			slots.choice("The size in GiB of /dev/wdb, the disk with the machine's own files.", DISK_SIZES),
			"4",
		),
		extraDisk: slots.option("--extra-disk", slots.diskSizes(), null),
		name: slots.option("--name", slots.newName(), null),
		nics: slots.option(
			"--nics",
			slots.count(`The NICs of each machine, 1 to ${MAX_NICS}: eth0 and on. One that is plugged in takes a port.`, {
				label: "NICs",
				noun: "a number of NICs such as 2",
				suggest: () => NICS.map((nic) => nic + 1),
			}),
			1,
		),
		net: slots.exclusive(NETWORKS.about, DEFAULT_SWITCH, [
			slots.valued("--net", NETWORKS),
			slots.flag("--no-net", "none"),
		]),
		addr: slots.option("--addr", slots.addresses(), null),
		gateway: slots.exclusive<"on" | "off">(
			"off (--no-gateway) leaves out the package gateway: its address and default route on eth0, its DHCP there, and package installs.",
			"on",
			[slots.flag("--no-gateway", "off")],
		),
	},
	example: { count: 1, image: "lab", name: "router", nics: 2, addr: "10.1.0.1/24,10.2.0.1/24", extraDisk: "1" },
	plan(a, lab) {
		if (a.mem > MAX_MEM_MIB) return refuse(`--mem wants at most ${MAX_MEM_MIB} MiB of memory, not ${a.mem}.`, "mem");
		if (a.cpus > MAX_CPUS) return refuse(`--cpus wants 1 to ${MAX_CPUS} CPUs, not ${a.cpus}.`, "cpus");
		if (a.cpus > 1 && MULTICPU_BLOCKER) return refuse(`--cpus wants 1 here, because ${MULTICPU_BLOCKER}.`, "cpus");
		if (a.nics > MAX_NICS) return refuse(`--nics wants 1 to ${MAX_NICS} NICs, not ${a.nics}.`, "nics");
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
			disks: { root: a.disk, extra: a.extraDisk ?? [] },
			cpus: a.cpus,
			gateway: a.gateway === "on" && nets[0] !== "none",
			nics: nets.map((net, nic) => ({ net, address: requestedAddress(a.addr, nic) })),
		});
		if (!isPlanError(plan)) return plan;
		const ports = `add --no-net to boot unplugged, or leave some NICs out with --net ${DEFAULT_SWITCH},none`;
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
			`${spec.disks.root} GiB disk`,
			...extraDisks(spec.disks, many),
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
		policy: "ask",
	},
});

export interface SpawnData {
	readonly names: readonly MachineName[];
}
