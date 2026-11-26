import {
	type CablePlanError,
	cableAt,
	endsFrom,
	isCablePlanError,
	joined,
	type LabState,
	type PortRef,
	planCable,
	portLabel,
	portName,
	samePort,
} from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { plugErrorSentence } from "./words.ts";

/** A cable between two switches as `switch_cable` and `switch_uncable` report it. */
export interface CabledSwitches {
	readonly from: PortRef;
	readonly to: PortRef;
}

export interface NewCable extends CabledSwitches {
	readonly link: "up";
	/** Whether it closed a loop of cables, so that frames now come back to the switches on it. */
	readonly loop: boolean;
}

/** `lan port 3 to wan port 1`, or with one switch `port 3 to port 4`. */
export function cableLabel(lab: LabState, [a, b]: readonly [PortRef, PortRef]): string {
	return `${portLabel(lab, a)} to ${portLabel(lab, b)}`;
}

/** `lan:3 to wan:1`, as a result names what it did. */
const cableName = ([a, b]: readonly [PortRef, PortRef]): string => `${portName(a)} to ${portName(b)}`;

export const LOOP = "closes a loop, so a broadcast goes round until a cable of the loop is cut";

function cableErrorSentence(lab: LabState, error: CablePlanError): string {
	if (error.kind === "one-port") {
		return `Both ends are ${portName(error.port)}, and a cable has two, so name another port for one of them.`;
	}
	if (error.kind === "no-ports" && error.wanted > 1 && error.free > 0) {
		return `${error.switch} has 1 free port and a cable from it to itself takes 2, so free one with unplug or uncable.`;
	}
	return plugErrorSentence(lab, error);
}

export const cable = defineVerb({
	name: "cable",
	about: "cable two switches together",
	description:
		"Put a cable between two switches, at a port such as lan:3 or at a switch's lowest free one, so that their machines share a segment. Two switches can have several, and both ends can be on one. A loop of cables is allowed: a broadcast goes round until a cable of it is cut, topology marks the switches as storming, and the lab lets 1,000 looped frames a second along each cable. link cuts and reconnects the cable, and uncable removes it. Returns both ports, and whether it closed a loop.",
	danger: false,
	grammar: { from: slots.place(), to: slots.place() },
	example: { from: "lan", to: "wan:8" },
	plan(a, lab) {
		const from = slots.readPlace(a.from, lab);
		if (from instanceof slots.Miss) return refuse(String(from.message), "from");
		const to = slots.readPlace(a.to, lab);
		if (to instanceof slots.Miss) return refuse(String(to.message), "to");
		const plan = planCable(lab, from, to);
		if (isCablePlanError(plan)) {
			const first =
				plan.kind === "port-taken"
					? from.switch === plan.port.switch && from.port === plan.port.port
					: plan.kind === "no-ports" && plan.wanted === 1 && from.switch === plan.switch && from.port === null;
			return refuse(cableErrorSentence(lab, plan), first ? "from" : "to");
		}
		const [near, far] = plan.ends;
		return { ends: plan.ends, loop: joined(lab, near.switch, far.switch) };
	},
	describe: ({ ends, loop }, lab) => [`cable ${cableLabel(lab, ends)}`, ...(loop ? [LOOP] : [])].join(" · "),
	async execute({ ends, loop }, ctx, deps) {
		deps.dispatch({ type: "cmd/cable", plan: { ends }, cause: ctx.source });
		await deps.until((s) => cableAt(s, ends[0]) !== undefined, ctx.signal);
		const data: NewCable = { from: ends[0], to: ends[1], link: "up", loop };
		return {
			kind: "visible",
			text: [`cabled ${cableName(ends)}`, ...(loop ? ["closes a loop"] : [])].join(" · "),
			data,
		};
	},
	tool: { name: "switch_cable", title: "Cable two switches together", policy: "run" },
});

export const uncable = defineVerb({
	name: "uncable",
	about: "remove a cable between switches",
	description:
		"Take out a cable between two switches, named by either of the ports it is in, which frees both. Each switch forgets what it learned over it. To cut a cable that keeps its ports, use link down. A NIC's cable comes out with unplug.",
	danger: false,
	grammar: { cable: slots.switchCable() },
	example: { cable: "lan:3" },
	plan(a, lab) {
		// It may have gone since the line was read.
		const port = slots.readSwitchCable(a.cable, lab);
		if (port instanceof slots.Miss) return refuse(String(port.message), "cable");
		const held = cableAt(lab, port);
		return held ? { port, ends: endsFrom(held, port) } : refuse(`${portName(port)} has no cable.`, "cable");
	},
	describe: ({ ends }, lab) => `remove the cable from ${cableLabel(lab, ends)}`,
	async execute({ port, ends }, ctx, deps) {
		deps.dispatch({ type: "cmd/uncable", port, cause: ctx.source });
		await deps.until((s) => !s.switchCables.some((other) => other.ends.some((end) => samePort(end, port))), ctx.signal);
		const data: CabledSwitches = { from: ends[0], to: ends[1] };
		return { kind: "visible", text: `removed the cable from ${cableName(ends)}`, data };
	},
	tool: { name: "switch_uncable", title: "Remove a cable between switches", policy: "run" },
});
