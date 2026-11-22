import {
	type Machine,
	type MachineName,
	machineList,
	type Phase,
	type PortNo,
	type SessionId,
	sessionLabel,
} from "../../model/index.ts";
import { defineVerb } from "../define.ts";
import type { ReportBlock } from "../types.ts";
import { count } from "./words.ts";

/** One machine as `machines_list` returns it. */
export interface ListedMachine {
	readonly name: MachineName;
	readonly state: Phase;
	readonly address: string;
	readonly port: PortNo | null;
	/** Null unless the machine is ready. */
	readonly link: "up" | "cut" | "unplugged" | null;
	readonly sessions: readonly SessionId[];
	/** Why it did not boot. */
	readonly reason?: string;
}

function listed(m: Machine): ListedMachine {
	const base = { name: m.name, state: m.life.phase, address: m.ip, sessions: m.sessions };
	switch (m.life.phase) {
		case "ready": {
			const { plug } = m.life;
			return plug.kind === "port"
				? { ...base, port: plug.port, link: plug.link }
				: { ...base, port: null, link: "unplugged" };
		}
		case "booting":
			return { ...base, port: m.life.plug.kind === "port" ? m.life.plug.port : null, link: null };
		case "failed":
			return { ...base, port: null, link: null, reason: m.life.reason };
		case "removing":
			return { ...base, port: m.life.port, link: null };
	}
}

function oneLine(m: ListedMachine): string {
	if (m.reason !== undefined) return m.reason;
	const cable =
		m.link === null
			? m.port === null
				? "unplugged"
				: `port ${m.port} reserved`
			: m.link === "unplugged"
				? "unplugged"
				: `${m.link} on port ${m.port}`;
	return [m.address, cable, m.sessions.map(sessionLabel).join(", ")].join(" · ");
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
				lastLine: oneLine(rows[i]),
				focus: m.life.phase === "removing" ? null : m.activeSession,
			}),
		);
		return { kind: "report", header: header(rows), blocks, data: rows };
	},
	tool: {
		name: "machines_list",
		description: "List every machine in the lab with its state, address, switch port, link and sessions.",
		policy: "run",
		annotations: { readOnlyHint: true },
	},
});
