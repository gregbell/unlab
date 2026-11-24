import {
	addressOf,
	type Machine,
	type MachineName,
	machineList,
	type NicName,
	nicMac,
	nicPortsOf,
	type Phase,
	type PortNo,
	plugsOf,
	type SessionId,
	sessionLabel,
} from "../../model/index.ts";
import { ip4str, NICS, nicName } from "../../net/index.ts";
import { defineVerb } from "../define.ts";
import type { ReportBlock } from "../types.ts";
import { count } from "./words.ts";

/** One NIC as `machines_list` returns it. */
export interface ListedNic {
	readonly name: NicName;
	readonly mac: string;
	/** The address the lab set on it, or null. A guest can add others. */
	readonly address: string | null;
	readonly prefix: number | null;
	readonly port: PortNo | null;
	/** Null unless the machine is ready. */
	readonly link: "up" | "cut" | "unplugged" | null;
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
	readonly sessions: readonly SessionId[];
	/** Why it did not boot. */
	readonly reason?: string;
}

function listed(m: Machine): ListedMachine {
	const ports = nicPortsOf(m.life);
	const plugs = plugsOf(m.life);
	const nics = NICS.slice(0, m.spec.nics.length).map((nic): ListedNic => {
		const plug = plugs[nic];
		const { address } = m.spec.nics[nic];
		return {
			name: nicName(nic),
			mac: nicMac(m.n, nic),
			address: address && ip4str(address.ip),
			prefix: address?.prefix ?? null,
			port: ports[nic] ?? null,
			link: m.life.phase !== "ready" || !plug ? null : plug.kind === "port" ? plug.link : "unplugged",
		};
	});
	const address = addressOf(m);
	return {
		name: m.name,
		state: m.life.phase,
		address: address && ip4str(address.ip),
		gateway: m.spec.gateway,
		nics,
		sessions: m.sessions,
		...(m.life.phase === "failed" ? { reason: m.life.reason } : {}),
	};
}

function nicLine(nic: ListedNic): string {
	const cable =
		nic.port === null
			? "unplugged"
			: nic.link === null
				? `port ${nic.port} reserved`
				: `${nic.link} on port ${nic.port}`;
	return [nic.address === null ? "no address" : `${nic.address}/${nic.prefix}`, nic.mac, cable].join(" · ");
}

/** A machine with one NIC is one line. With more, each NIC has its own. */
function lines(m: ListedMachine): string {
	if (m.reason !== undefined) return m.reason;
	const off = !m.gateway && m.nics[0].port !== null;
	const sessions = [...(off ? ["no package gateway"] : []), m.sessions.map(sessionLabel).join(", ")].join(" · ");
	if (m.nics.length === 1) return `${nicLine(m.nics[0])} · ${sessions}`;
	return [...m.nics.map((nic) => `${nic.name} · ${nicLine(nic)}`), sessions].join("\n");
}

function header(rows: readonly ListedMachine[]): string {
	if (rows.length === 0) return "no machines yet";
	const phases: readonly Phase[] = ["ready", "booting", "failed", "removing"];
	const tally = phases.flatMap((phase) => {
		const n = rows.filter((r) => r.state === phase).length;
		return n === 0 ? [] : [`${n} ${phase}`];
	});
	return `${count(rows.length, "machine")} · ${tally.join(", ")}`;
}

export const ls = defineVerb({
	name: "ls",
	about: "list machines, addresses and links",
	danger: false,
	grammar: {},
	plan: (_a, lab) => ({ machines: machineList(lab) }),
	describe: (plan) => `list ${count(plan.machines.length, "machine")} with their addresses and links`,
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
		description:
			"List every machine in the lab with its state, sessions and NICs. Each NIC has its MAC, the address and prefix the lab set, switch port and link.",
		policy: "run",
		annotations: { readOnlyHint: true },
	},
});
