import {
	carries,
	DEFAULT_VLAN,
	type HeldPort,
	holdsNic,
	type LabState,
	nicLabel,
	type Phase,
	type PortRef,
	type PortVlan,
	portLabel,
	portName,
	sameVlan,
	vlanOf,
	vlanText,
} from "../../model/index.ts";
import { type CommandDeps, defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import type { Result } from "../types.ts";

/** A port and what it carries, as `port_vlan` and `port_trunk` return it. */
export type PortVlanState = PortRef & PortVlan;

/** Whatever a machine is doing, its cable holds the port. */
export const HOLDING: readonly Phase[] = ["booting", "ready", "stopping", "off", "restoring", "removing"];

/** `node2 is in it`, or `its cable goes to wan port 1`. */
export function inIt(lab: LabState, held: HeldPort): string {
	return holdsNic(held)
		? `${nicLabel(held.machine, held.nic)} is in it`
		: `its cable goes to ${portLabel(lab, held.far)}`;
}

interface VlanPlan {
	readonly port: PortRef;
	readonly held: HeldPort;
	readonly vlan: PortVlan;
	readonly already: boolean;
	/** What it does that someone may not expect, said before it runs and in what it returns. */
	readonly notes: readonly string[];
}

function planned(lab: LabState, port: PortRef, held: HeldPort, vlan: PortVlan): VlanPlan {
	const notes =
		vlan.mode === "trunk" && !carries(vlan, vlan.native)
			? [`native ${vlan.native} is not allowed, so nothing crosses it untagged`]
			: [];
	return { port, held, vlan, already: sameVlan(vlanOf(lab, port), vlan), notes };
}

function described({ port, held, vlan, already, notes }: VlanPlan, lab: LabState): string {
	const where = portLabel(lab, port);
	const what = already
		? `change nothing: ${where} is already ${vlanText(vlan)}`
		: vlan.mode === "access"
			? `put ${where} in vlan ${vlan.vlan}`
			: `make ${where} a ${vlanText(vlan)}`;
	return [what, inIt(lab, held), ...notes].join(" · ");
}

async function applied(
	{ port, vlan, already, notes }: VlanPlan,
	signal: AbortSignal,
	deps: CommandDeps,
): Promise<Result> {
	if (!already) {
		deps.dispatch({ type: "cmd/vlan", port, vlan });
		await deps.until((s) => sameVlan(vlanOf(s, port), vlan), signal);
	}
	const data: PortVlanState = { ...port, ...vlan };
	const text = [`${portName(port)} ${already ? "already " : ""}${vlanText(vlan)}`, ...notes].join(" · ");
	return { kind: "visible", text, data };
}

export const vlan = defineVerb({
	name: "vlan",
	about: "put a switch port in a VLAN",
	description:
		"Put one port of a switch in a VLAN, from 1 to 4094, as an access port: its machine sends and gets frames without tags, and reaches only the ports of that VLAN. Broadcasts stay in the VLAN, and the switch learns addresses for each VLAN apart. Name the port (lan:3), or the NIC whose cable is in it (node2). A new port is in VLAN 1, and so is a port again once nothing is in it. A cut or a reboot leaves it as it is. vlan on a trunk makes it an access port again. Returns the switch, port and VLAN.",
	danger: false,
	phases: HOLDING,
	grammar: { port: slots.port(), vlan: slots.vlanId("The VLAN, from 1 to 4094. VLAN 1 is where every port starts.") },
	example: { port: "node2", vlan: 10 },
	plan(a, lab, ctx) {
		const read = slots.readPort(a.port, ctx);
		if (read instanceof slots.Miss) return refuse(String(read.message), "port");
		return planned(lab, read.ref, read.held, { mode: "access", vlan: a.vlan });
	},
	describe: (plan, lab) => described(plan, lab),
	execute: (plan, ctx, deps) => applied(plan, ctx.signal, deps),
	tool: { name: "port_vlan", title: "Put a switch port in a VLAN", policy: "run" },
});

export const trunk = defineVerb({
	name: "trunk",
	about: "make a switch port a trunk of several VLANs",
	description:
		"Make the port of a cable between switches a trunk, to carry several VLANs over it, each frame with an 802.1Q tag. --allow names the VLANs (10,20), all by default. The native VLAN, 1 by default, goes untagged, if it is allowed. The far end needs to be a trunk too, and ends with different native VLANs move untagged frames from one VLAN to the other. A NIC cannot be on a trunk: its kernel has no 802.1Q. vlan makes the port an access port again. Returns the port and what it carries.",
	danger: false,
	phases: HOLDING,
	grammar: {
		port: slots.port(),
		allow: slots.option(
			"--allow",
			slots.vlans("The VLANs the trunk carries, as a comma list (10,20), or all."),
			slots.ALL_VLANS,
		),
		native: slots.option("--native", slots.vlanId("The VLAN that goes without a tag."), DEFAULT_VLAN),
	},
	example: { port: "lan:3", allow: "1,10,20", native: 1 },
	plan(a, lab, ctx) {
		const read = slots.readPort(a.port, ctx);
		if (read instanceof slots.Miss) return refuse(String(read.message), "port");
		const { ref, held } = read;
		if (holdsNic(held)) {
			const nic = nicLabel(held.machine, held.nic);
			return refuse(
				`${portName(ref)} holds the cable of ${nic}, whose kernel has no 802.1Q to read tags with, so make a trunk of a port that a cable between switches is in, or put ${nic} in one VLAN with vlan ${nic} 10.`,
				"port",
			);
		}
		return planned(lab, ref, held, { mode: "trunk", allowed: a.allow, native: a.native });
	},
	describe: (plan, lab) => described(plan, lab),
	execute: (plan, ctx, deps) => applied(plan, ctx.signal, deps),
	tool: { name: "port_trunk", title: "Make a switch port a trunk", policy: "run" },
});
