// What each port of a switch carries. A port is in VLAN 1 until it is set
// otherwise, and is again once nothing is in it, so whatever is plugged in
// next starts there too. `settleVlans` keeps that after every change.

import { heldPorts, samePort, type Wiring } from "./machines.ts";
import { step } from "./step.ts";
import {
	DEFAULT_PORT_VLAN,
	DEFAULT_VLAN,
	type Effect,
	type LabState,
	MAX_VLAN,
	MIN_VLAN,
	type PortRef,
	type PortVlan,
	type Step,
	type VlanId,
	type VlanPort,
} from "./types.ts";

export function parseVlanId(text: string): VlanId | null {
	if (!/^\d{1,4}$/.test(text)) return null;
	const n = Number(text);
	return n >= MIN_VLAN && n <= MAX_VLAN ? (n as VlanId) : null;
}

export function vlanOf({ portVlans }: Pick<LabState, "portVlans">, port: PortRef): PortVlan {
	return portVlans.find((held) => samePort(held.port, port))?.vlan ?? DEFAULT_PORT_VLAN;
}

export function sameVlan(a: PortVlan, b: PortVlan): boolean {
	if (a.mode === "access" || b.mode === "access") {
		return a.mode === "access" && b.mode === "access" && a.vlan === b.vlan;
	}
	if (a.native !== b.native) return false;
	if (a.allowed === "all" || b.allowed === "all") return a.allowed === b.allowed;
	return a.allowed.length === b.allowed.length && a.allowed.every((id, i) => id === b.allowed[i]);
}

/** Whether frames of the VLAN go in and out of a port of this setting. */
export function carries(vlan: PortVlan, id: VlanId): boolean {
	if (vlan.mode === "access") return vlan.vlan === id;
	return vlan.allowed === "all" || vlan.allowed.includes(id);
}

/** `vlan 10`, `trunk of all VLANs, native 1`, `trunk of 10 and 20, native 1`. */
export function vlanText(vlan: PortVlan): string {
	if (vlan.mode === "access") return `vlan ${vlan.vlan}`;
	const of = vlan.allowed === "all" ? "all VLANs" : listText(vlan.allowed);
	return `trunk of ${of}, native ${vlan.native}`;
}

function listText(ids: readonly VlanId[]): string {
	if (ids.length === 1) return String(ids[0]);
	return `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/** Sorted and without repeats, so that one setting is written one way. */
export function vlanList(ids: readonly VlanId[]): readonly VlanId[] {
	return [...new Set(ids)].sort((a, b) => a - b);
}

const isDefault = (vlan: PortVlan): boolean => vlan.mode === "access" && vlan.vlan === DEFAULT_VLAN;

/** Ignored unless something is in the port. */
export function setVlan(state: LabState, port: PortRef, vlan: PortVlan): Step {
	const held = heldPorts(state, port.switch).some((other) => other.port === port.port);
	if (!held || sameVlan(vlanOf(state, port), vlan)) return step(state);
	const others = state.portVlans.filter((other) => !samePort(other.port, port));
	return step({ ...state, portVlans: isDefault(vlan) ? others : [...others, { port, vlan }] });
}

/** Those that something is in, on switches that are there. */
export function heldVlans(state: Wiring & Pick<LabState, "switches">, vlans: readonly VlanPort[]): readonly VlanPort[] {
	return vlans.filter(
		({ port }) =>
			state.switches.includes(port.switch) && heldPorts(state, port.switch).some((held) => held.port === port.port),
	);
}

/**
 * After every change: a port that nothing is in any more is in VLAN 1 again,
 * and the switches carry each port as the lab now has it. A switch that is
 * gone takes its ports with it.
 */
export function settleVlans(before: LabState, after: LabState): Step {
	const unchanged =
		before.portVlans === after.portVlans &&
		before.machines === after.machines &&
		before.switchCables === after.switchCables &&
		before.switches === after.switches;
	if (unchanged || (before.portVlans.length === 0 && after.portVlans.length === 0)) return step(after);
	const kept = heldVlans(after, after.portVlans);
	const state = kept.length === after.portVlans.length ? after : { ...after, portVlans: kept };
	const effects: Effect[] = [];
	for (const { port } of before.portVlans) {
		if (state.switches.includes(port.switch) && !kept.some((now) => samePort(now.port, port))) {
			effects.push({ type: "port/vlan", port, vlan: DEFAULT_PORT_VLAN });
		}
	}
	for (const { port, vlan } of kept) {
		const was = vlanOf(before, port);
		if (!sameVlan(was, vlan)) effects.push({ type: "port/vlan", port, vlan });
	}
	return step(state, effects);
}

/** The effects that put a saved lab's ports back as they were, once their cables are in. */
export function vlanEffects({ portVlans }: Pick<LabState, "portVlans">): readonly Effect[] {
	return portVlans.map(({ port, vlan }) => ({ type: "port/vlan", port, vlan }));
}
