import {
	isPlanError,
	type LabState,
	type MachineName,
	nicLabel,
	type PlugPlan,
	type PortNo,
	planPlug,
	plugsOf,
	portLabel,
	type SwitchName,
	samePort,
} from "../../model/index.ts";
import { type NicName, nicName } from "../../net/index.ts";
import { defineVerb, Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import type { CableLink, CableState } from "./link.ts";
import { plugErrorSentence } from "./words.ts";

/** A NIC's cable and the port that it is in, with the port's switch however many the lab has. */
export interface PluggedCable extends CableState {
	readonly machine: MachineName;
	readonly nic: NicName;
	readonly switch: SwitchName;
	readonly port: PortNo;
	readonly link: CableLink;
}

/** The NIC that is named, unless the lab has changed since the line was read. */
function nicNow(written: string, ctx: slots.ReadContext) {
	const ref = slots.readNic(written, ctx);
	if (ref instanceof slots.Miss) return refuse(String(ref.message), "nic");
	const { nic, machine } = ref;
	const now = plugsOf(machine.life)[nic];
	return {
		machine: machine.name,
		nic,
		label: nicLabel(machine, nic),
		/** The port that its cable is in. */
		from: now?.kind === "port" ? now.port : null,
		cut: now?.kind === "port" && now.link === "cut",
		off: machine.life.phase === "off",
	};
}

/** Whether its cable is where the plan says. */
function isThere(lab: LabState, { machine, nic, to }: PlugPlan): boolean {
	const life = lab.machines[machine]?.life;
	const now = life && plugsOf(life)[nic];
	if (now?.kind !== "port") return to === null;
	return to !== null && samePort(now.port, to);
}

export const plug = defineVerb({
	name: "plug",
	about: "plug a NIC into a switch, or move its cable there",
	description:
		"Plug one NIC into a switch, or move its cable there. lan:3 is port 3 of lan. A switch's name alone is its lowest free port, or the port the NIC is in already. The machine runs on, and later boots and reloads use the new place. The switch that the cable leaves forgets what it learned from it. A cut cable moves as it is, and link up reconnects it. A package gateway that eth0 has works on any switch, and plug adds none. Returns the switch, port and link.",
	danger: false,
	phases: ["ready", "off"],
	grammar: { nic: slots.nic(), to: slots.place() },
	example: { nic: "node2", to: "lan:3" },
	plan(a, lab, ctx) {
		const cable = nicNow(a.nic, ctx);
		if (cable instanceof Refusal) return cable;
		const place = slots.readPlace(a.to, lab);
		if (place instanceof slots.Miss) return refuse(String(place.message), "to");
		const plan = planPlug(lab, cable, place);
		return isPlanError(plan) ? refuse(plugErrorSentence(lab, plan), "to") : { ...cable, to: plan.to };
	},
	describe({ machine, label, from, to, cut, off }, lab) {
		const where = portLabel(lab, to);
		const what =
			from === null
				? `plug ${label} into ${where}`
				: samePort(from, to)
					? `change nothing: ${label} is already in ${where}`
					: `move ${label} from ${portLabel(lab, from)} to ${where}`;
		return [what, ...(cut ? ["its cable is cut and stays cut"] : []), ...(off ? [`${machine} is off`] : [])].join(
			" · ",
		);
	},
	async execute({ machine, nic, from, to, label, cut, off }, ctx, deps) {
		const plan = { machine, nic, to };
		deps.dispatch({ type: "cmd/plug", plan, cause: ctx.source });
		const lab = await deps.until((s) => isThere(s, plan), ctx.signal);
		const link = cut ? "cut" : off ? "off" : "up";
		const already = from !== null && samePort(from, to) ? "already in" : "plugged into";
		const data: PluggedCable = { machine, nic: nicName(nic), switch: to.switch, port: to.port, link };
		return { kind: "visible", text: `${label} ${already} ${portLabel(lab, to)} · ${link}`, data };
	},
	tool: { name: "cable_plug", title: "Plug a NIC into a switch", policy: "run" },
});

export const unplug = defineVerb({
	name: "unplug",
	about: "unplug a NIC and free its port",
	description:
		"Take one NIC's cable out of its switch, which frees the port, until plug puts one in. Later boots and reloads leave it out. The machine runs on. To cut a cable that keeps its port, use link down.",
	danger: false,
	phases: ["ready", "off"],
	grammar: { nic: slots.nic() },
	example: { nic: "node2" },
	plan: (a, _lab, ctx) => nicNow(a.nic, ctx),
	describe({ machine, label, from, off }, lab) {
		const what =
			from === null ? `change nothing: ${label} is already unplugged` : `unplug ${label} from ${portLabel(lab, from)}`;
		return [what, ...(off ? [`${machine} is off`] : [])].join(" · ");
	},
	async execute({ machine, nic, from, label }, ctx, deps) {
		const plan = { machine, nic, to: null };
		deps.dispatch({ type: "cmd/plug", plan, cause: ctx.source });
		await deps.until((s) => isThere(s, plan), ctx.signal);
		const data: CableState = { machine, nic: nicName(nic), port: null, link: "unplugged" };
		return { kind: "visible", text: `${label} ${from === null ? "already unplugged" : "unplugged"}`, data };
	},
	tool: { name: "cable_unplug", title: "Unplug a NIC", policy: "run" },
});
