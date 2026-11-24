import { ACCEPTS, type Machine, type MachineName, machineList, plugsOf, portsOf } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList, count, ports, skippedPart } from "./words.ts";

/** Answering peers: ready, with the cable up to the NIC that has the lab address. */
function answering(m: Machine): boolean {
	const [eth0] = plugsOf(m.life);
	return m.life.phase === "ready" && eth0?.kind === "port" && eth0.link === "up";
}

export const rm = defineVerb({
	name: "rm",
	about: "remove machines and their disks",
	danger: true,
	phases: ["booting", "ready", "failed"],
	grammar: { names: slots.machines() },
	plan(a, lab) {
		const machines: Machine[] = [];
		for (const name of a.names.machines) {
			const m = lab.machines[name];
			if (!m) return refuse(`${name} is already gone.`, "names");
			if (!ACCEPTS[m.life.phase].remove) return refuse(`${name} is already being removed.`, "names");
			machines.push(m);
		}
		return { machines, skipped: a.names.skipped };
	},
	describe(plan) {
		const names = plan.machines.map((m) => m.name);
		const freed = plan.machines.flatMap((m) => portsOf(m.life));
		return [
			`remove ${andList(names)} with ${names.length === 1 ? "its disk" : "their disks"}`,
			...(freed.length > 0 ? [`frees ${ports(freed)}`] : []),
			...skippedPart(plan.skipped),
		].join(" · ");
	},
	confirm(plan, lab) {
		const names = plan.machines.map((m) => m.name);
		const one = names.length === 1;
		const shells = plan.machines.reduce((n, m) => n + m.sessions.length - 1, 0);
		const closes = one
			? shells === 0
				? "Its console closes"
				: `Its console and ${count(shells, "shell")} close`
			: shells === 0
				? "Their consoles close"
				: `Their consoles and ${count(shells, "shell")} close`;
		const lost = `${closes} and everything on ${one ? "its disk" : "their disks"} is gone. There is no undo.`;

		const freed = plan.machines.flatMap((m) => portsOf(m.life));
		const going = new Set<MachineName>(names);
		const silenced = plan.machines.filter(answering).map((m) => m.ip);
		const peers = machineList(lab).filter((m) => !going.has(m.name) && answering(m));
		const frees =
			freed.length === 1 ? `Port ${freed[0]} on switch0 frees up.` : `Ports ${andList(freed)} on switch0 free up.`;
		const affected = [
			...(freed.length === 0 ? [] : [frees]),
			...(silenced.length === 0 || peers.length === 0
				? []
				: [`${andList(peers.map((m) => m.name))} will stop getting answers from ${andList(silenced)}.`]),
		];
		return {
			question: `Remove ${andList(names)}?`,
			detail: [lost, ...affected].join(" "),
			actionLabel: `Remove ${andList(names)}`,
		};
	},
	async execute(plan, ctx, deps) {
		const machines = plan.machines.map((m) => m.name);
		deps.dispatch({ type: "cmd/remove", machines, cause: ctx.source });
		await deps.until((s) => machines.every((name) => s.machines[name] === undefined), ctx.signal);
		return {
			kind: "visible",
			text: [`removed ${andList(machines)}`, ...skippedPart(plan.skipped)].join(" · "),
			data: { removed: machines } satisfies RemoveData,
		};
	},
	tool: {
		name: "machines_remove",
		title: "Remove machines",
		description:
			"Remove machines and everything on their disks. There is no undo. Returns the names removed once they are gone.",
		policy: "ask",
		annotations: { consequentialHint: true },
	},
});

export interface RemoveData {
	readonly removed: readonly MachineName[];
}
