import {
	addressOf,
	type Checkpoint,
	type CheckpointName,
	conditionsAt,
	type Disk,
	disksOf,
	gatewayReach,
	hasConditions,
	type LabState,
	type Machine,
	type MachineName,
	machineList,
	type NicName,
	NO_CONDITIONS,
	nicMac,
	nicPortsOf,
	type Phase,
	type PortNo,
	portText,
	type SessionId,
	type SwitchName,
	savingOf,
	sessionLabel,
	sizeText,
	type WrittenConditions,
	writtenConditions,
} from "../../model/index.ts";
import { ip4str, NICS, nicName } from "../../net/index.ts";
import { defineVerb } from "../define.ts";
import type { ReportBlock } from "../types.ts";
import { type CableLink, cableLink } from "./link.ts";
import { count, diskList, portOf } from "./words.ts";

/** One NIC as `machines_list` returns it. */
export interface ListedNic {
	readonly name: NicName;
	readonly mac: string;
	/** The address the lab set on it, or null. A guest can add others. */
	readonly address: string | null;
	readonly prefix: number | null;
	/** The port's, when the lab has several. */
	readonly switch?: SwitchName;
	readonly port: PortNo | null;
	/** Null unless the machine is ready or off. */
	readonly link: CableLink | null;
	/** Its cable's, each as link's options take it. There when the cable has some. */
	readonly conditions?: WrittenConditions;
}

/** One machine as `machines_list` returns it. */
export interface ListedMachine {
	readonly name: MachineName;
	readonly state: Phase;
	/** The first address the lab set on it, or null. */
	readonly address: string | null;
	/** Whether eth0 reaches the package gateway. */
	readonly gateway: boolean;
	/** That gateway leads to the internet, as it does while a CLI is linked. */
	readonly internet?: true;
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

function listed(lab: LabState, m: Machine): ListedMachine {
	const ports = nicPortsOf(m.life);
	const nics = NICS.slice(0, m.spec.nics.length).map((nic): ListedNic => {
		const { address } = m.spec.nics[nic];
		const at = ports[nic];
		const cable = at ? conditionsAt(lab, at) : NO_CONDITIONS;
		return {
			name: nicName(nic),
			mac: nicMac(m.n, nic),
			address: address && ip4str(address.ip),
			prefix: address?.prefix ?? null,
			...portOf(lab, ports[nic]),
			link: cableLink(m.life, nic),
			...(hasConditions(cable) ? { conditions: writtenConditions(cable) } : {}),
		};
	});
	const address = addressOf(m);
	const saving = savingOf(m.life);
	return {
		name: m.name,
		state: m.life.phase,
		address: address && ip4str(address.ip),
		gateway: m.spec.gateway,
		...(gatewayReach(lab, m) === "internet" ? { internet: true } : {}),
		nics,
		disks: disksOf(m.spec),
		checkpoints: m.sets.checkpoints.map(({ name, bytes }) => ({ name, bytes })),
		...(saving ? { saving: saving.name } : {}),
		sessions: m.sessions,
		...(m.life.phase === "failed" ? { reason: m.life.reason } : {}),
	};
}

function cableLine({ switch: on, port: no, link }: ListedNic): string {
	if (no === null) return "unplugged";
	const port = portText(on ?? null, no);
	if (link === null) return `${port} reserved`;
	return link === "off" ? `plugged into ${port}` : `${link} on ${port}`;
}

/** `delay 100ms, loss 20%`, as the options that set them. */
const conditionsLine = (conditions: WrittenConditions): string =>
	Object.entries(conditions)
		.map(([part, value]) => `${part} ${value}`)
		.join(", ");

function nicLine(nic: ListedNic): string {
	return [
		nic.address === null ? "no address" : `${nic.address}/${nic.prefix}`,
		nic.mac,
		cableLine(nic),
		...(nic.conditions ? [conditionsLine(nic.conditions)] : []),
	].join(" · ");
}

function checkpointPart({ checkpoints, saving }: ListedMachine): string[] {
	const kept = checkpoints.map(({ name, bytes }) => `${name} ${sizeText(bytes)}`).join(", ");
	return [
		...(checkpoints.length === 0 ? [] : [`${checkpoints.length === 1 ? "checkpoint" : "checkpoints"} ${kept}`]),
		...(saving === undefined ? [] : [`saving ${saving}`]),
	];
}

function gatewayPart({ gateway, internet, nics }: ListedMachine): string[] {
	if (internet) return ["internet through the CLI"];
	if (gateway) return ["package repositories only"];
	return nics[0].port === null ? [] : ["no package gateway"];
}

/** A machine with one NIC is one line. With more, each NIC has its own. */
function lines(m: ListedMachine): string {
	if (m.reason !== undefined) return m.reason;
	const rest = [
		...gatewayPart(m),
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
		"List every machine with its state (booting, ready, stopping, off, restoring, failed or removing), why it failed, and its sessions, disks, checkpoints and NICs. A checkpoint has the bytes of storage it takes. Each NIC has its MAC, the address and prefix the lab set, switch port and link, the port's switch when the lab has several, and its cable's conditions if it has any. Only a ready machine runs commands and takes files.",
	danger: false,
	grammar: {},
	example: {},
	plan: (_a, lab) => ({ lab, machines: machineList(lab) }),
	describe: (plan) => `list ${count(plan.machines.length, "machine")} with their addresses, links and disks`,
	async execute(plan) {
		const rows = plan.machines.map((m) => listed(plan.lab, m));
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
