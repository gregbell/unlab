import {
	addressOf,
	type Checkpoint,
	type CheckpointName,
	type Disk,
	disksOf,
	type Machine,
	type MachineName,
	machineList,
	type NicName,
	nicMac,
	nicPortsOf,
	type Phase,
	type PortNo,
	type SessionId,
	savingOf,
	sessionLabel,
	sizeText,
} from "../../model/index.ts";
import { ip4str, NICS, nicName } from "../../net/index.ts";
import { defineVerb } from "../define.ts";
import type { ReportBlock } from "../types.ts";
import { type CableLink, cableLink } from "./link.ts";
import { count, diskList } from "./words.ts";

/** One NIC as `machines_list` returns it. */
export interface ListedNic {
	readonly name: NicName;
	readonly mac: string;
	/** The address the lab set on it, or null. A guest can add others. */
	readonly address: string | null;
	readonly prefix: number | null;
	readonly port: PortNo | null;
	/** Null unless the machine is ready or off. */
	readonly link: CableLink | null;
}

/** One machine as `machines_list` returns it. */
export interface ListedMachine {
	readonly name: MachineName;
	readonly state: Phase;
	/** The first address the lab set on it, or null. */
	readonly address: string | null;
	/** Whether eth0 reaches the package gateway. */
	readonly gateway: boolean;
	/** eth0 first. */
	readonly nics: readonly ListedNic[];
	/** The one that keeps its files first. */
	readonly disks: readonly Disk[];
	/** Oldest first, with the storage each takes. */
	readonly checkpoints: readonly Pick<Checkpoint, "name" | "bytes">[];
	/** The checkpoint that is being saved. */
	readonly saving?: CheckpointName;
	readonly sessions: readonly SessionId[];
	/** Why it did not boot. */
	readonly reason?: string;
}

function listed(m: Machine): ListedMachine {
	const ports = nicPortsOf(m.life);
	const nics = NICS.slice(0, m.spec.nics.length).map((nic): ListedNic => {
		const { address } = m.spec.nics[nic];
		return {
			name: nicName(nic),
			mac: nicMac(m.n, nic),
			address: address && ip4str(address.ip),
			prefix: address?.prefix ?? null,
			port: ports[nic] ?? null,
			link: cableLink(m.life, nic),
		};
	});
	const address = addressOf(m);
	const saving = savingOf(m.life);
	return {
		name: m.name,
		state: m.life.phase,
		address: address && ip4str(address.ip),
		gateway: m.spec.gateway,
		nics,
		disks: disksOf(m.spec),
		checkpoints: m.sets.checkpoints.map(({ name, bytes }) => ({ name, bytes })),
		...(saving ? { saving: saving.name } : {}),
		sessions: m.sessions,
		...(m.life.phase === "failed" ? { reason: m.life.reason } : {}),
	};
}

function cableLine({ port, link }: ListedNic): string {
	if (port === null) return "unplugged";
	if (link === null) return `port ${port} reserved`;
	return link === "off" ? `plugged into port ${port}` : `${link} on port ${port}`;
}

function nicLine(nic: ListedNic): string {
	return [nic.address === null ? "no address" : `${nic.address}/${nic.prefix}`, nic.mac, cableLine(nic)].join(" · ");
}

function checkpointPart({ checkpoints, saving }: ListedMachine): string[] {
	const kept = checkpoints.map(({ name, bytes }) => `${name} ${sizeText(bytes)}`).join(", ");
	return [
		...(checkpoints.length === 0 ? [] : [`${checkpoints.length === 1 ? "checkpoint" : "checkpoints"} ${kept}`]),
		...(saving === undefined ? [] : [`saving ${saving}`]),
	];
}

/** A machine with one NIC is one line. With more, each NIC has its own. */
function lines(m: ListedMachine): string {
	if (m.reason !== undefined) return m.reason;
	const off = !m.gateway && m.nics[0].port !== null;
	const rest = [
		...(off ? ["no package gateway"] : []),
		m.disks.length === 1 ? `${diskList(m.disks)} disk` : diskList(m.disks),
		m.sessions.map(sessionLabel).join(", "),
		...checkpointPart(m),
	].join(" · ");
	if (m.nics.length === 1) return `${nicLine(m.nics[0])} · ${rest}`;
	return [...m.nics.map((nic) => `${nic.name} · ${nicLine(nic)}`), rest].join("\n");
}

function header(rows: readonly ListedMachine[]): string {
	if (rows.length === 0) return "no machines yet";
	const phases: readonly Phase[] = ["ready", "booting", "restoring", "stopping", "off", "failed", "removing"];
	const tally = phases.flatMap((phase) => {
		const n = rows.filter((r) => r.state === phase).length;
		return n === 0 ? [] : [`${n} ${phase}`];
	});
	return `${count(rows.length, "machine")} · ${tally.join(", ")}`;
}

export const ls = defineVerb({
	name: "ls",
	about: "list machines, addresses, links and disks",
	description:
		"List every machine with its state (booting, ready, stopping, off, restoring, failed or removing), why it failed, and its sessions, disks, checkpoints and NICs. A checkpoint has the bytes of storage it takes. Each NIC has its MAC, the address and prefix the lab set, switch port and link. Only a ready machine runs commands and takes files.",
	danger: false,
	grammar: {},
	example: {},
	plan: (_a, lab) => ({ machines: machineList(lab) }),
	describe: (plan) => `list ${count(plan.machines.length, "machine")} with their addresses, links and disks`,
	async execute(plan) {
		const rows = plan.machines.map(listed);
		const blocks = plan.machines.map(
			(m, i): ReportBlock => ({
				machine: m.name,
				hue: m.hue,
				status: { kind: "state", text: m.life.phase },
				lastLine: lines(rows[i]),
				focus: m.life.phase === "removing" ? null : m.activeSession,
			}),
		);
		return { kind: "report", header: header(rows), blocks, data: rows };
	},
	tool: {
		name: "machines_list",
		title: "List machines",
		policy: "run",
		annotations: { readOnlyHint: true },
	},
});
