// The cables between switches. One is named by either of the ports it is in,
// as a NIC's cable is named by its NIC, so nothing here gives a cable a name
// or a number of its own.

import { heldPorts, holderOf, lowestFreePorts, samePort } from "./machines.ts";
import { without } from "./record.ts";
import { andThen, step } from "./step.ts";
import {
	type CableChange,
	type CablePlan,
	type CablePlanError,
	type Cause,
	type Effect,
	type LabState,
	type Place,
	PORTS,
	type PortRef,
	type Step,
	type Storm,
	type SwitchCable,
	type SwitchName,
} from "./types.ts";

type Cabled = Pick<LabState, "switchCables">;

/** The cable in the port that goes to another port of a switch. */
export function cableAt({ switchCables }: Cabled, port: PortRef): SwitchCable | undefined {
	return switchCables.find(({ ends }) => ends.some((end) => samePort(end, port)));
}

/** The cables with an end in the switch. One with both ends there is listed once. */
export function cablesOf({ switchCables }: Cabled, on: SwitchName): readonly SwitchCable[] {
	return switchCables.filter(({ ends }) => ends.some((end) => end.switch === on));
}

/** A cable's ends with the given port, or one of the given switch, first. */
export function endsFrom({ ends: [a, b] }: SwitchCable, near: PortRef | SwitchName): SwitchCable["ends"] {
	const first = typeof near === "string" ? a.switch === near : samePort(a, near);
	return first ? [a, b] : [b, a];
}

/** `lan port 3 to wan port 1`. */
export function cableText([a, b]: SwitchCable["ends"]): string {
	return `${a.switch} port ${a.port} to ${b.switch} port ${b.port}`;
}

/**
 * Whether a frame can get from one switch to the other over cables that are
 * up. A new cable between two such switches closes a loop, and so does one
 * from a switch to itself.
 */
export function joined({ switchCables }: Cabled, from: SwitchName, to: SwitchName): boolean {
	const reached = new Set<SwitchName>([from]);
	for (const at of reached) {
		for (const { ends, link } of switchCables) {
			if (link !== "up") continue;
			for (const [near, far] of [ends, [ends[1], ends[0]]]) if (near.switch === at) reached.add(far.switch);
		}
	}
	return reached.has(to);
}

export function isCablePlanError(plan: CablePlan | CablePlanError): plan is CablePlanError {
	return "kind" in plan;
}

/**
 * The two ports that a cable between the places would be in: those that are
 * named, and else the lowest free one of each switch. Both can be of one switch.
 */
export function planCable(state: LabState, from: Place, to: Place): CablePlan | CablePlanError {
	if (from.port !== null && from.port === to.port && from.switch === to.switch) {
		return { kind: "one-port", port: { switch: from.switch, port: from.port } };
	}
	const resolve = (place: Place, other: Place): PortRef | CablePlanError => {
		const { switch: on, port } = place;
		const free = lowestFreePorts(state, on, PORTS.length);
		const shared = other.switch === on;
		const noPorts: CablePlanError = { kind: "no-ports", switch: on, free: free.length, wanted: shared ? 2 : 1 };
		if (!state.switches.includes(on)) return noPorts;
		if (port !== null) {
			const by = heldPorts(state, on).find((held) => held.port === port);
			return by ? { kind: "port-taken", port: { switch: on, port }, by: holderOf(by) } : { switch: on, port };
		}
		const lowest = free.find((candidate) => !shared || candidate !== other.port);
		return lowest === undefined ? noPorts : { switch: on, port: lowest };
	};
	const a = resolve(from, to);
	if ("kind" in a) return a;
	const b = resolve(to, a);
	return "kind" in b ? b : { ends: [a, b] };
}

/** The effects that put a saved lab's cables back, before its machines boot. */
export function cableEffects({ switchCables }: Cabled): readonly Effect[] {
	return switchCables.flatMap(({ ends, link }): Effect[] => [
		{ type: "cable/attach", ends },
		...(link === "up" ? [{ type: "cable/link", ends, up: true, cause: "runtime", plug: true } as const] : []),
	]);
}

/** The link first, so each switch forgets what it had learned over the cable and the capture says so. */
function takeOut({ ends, link }: SwitchCable, cause: Cause): Effect[] {
	return [
		{ type: "cable/link", ends, up: false, cause, plug: true, ...(link === "cut" ? { cut: true } : {}) },
		{ type: "cable/detach", ends },
	];
}

/** Ignored unless both ports are still free. */
export function cable(state: LabState, { ends }: CablePlan, cause: Cause): Step {
	if (isCablePlanError(planCable(state, ends[0], ends[1]))) return step(state);
	return step({ ...state, switchCables: [...state.switchCables, { ends, link: "up" }] }, [
		{ type: "cable/attach", ends },
		{ type: "cable/link", ends, up: true, cause, plug: true },
		{ type: "announce", text: `${cableText(ends)} cabled` },
	]);
}

/** Takes out the cable that has an end in the port. Both its ports are free then. */
export function uncable(state: LabState, port: PortRef, cause: Cause): Step {
	const held = cableAt(state, port);
	if (!held) return step(state);
	return step({ ...state, switchCables: state.switchCables.filter((other) => other !== held) }, [
		...takeOut(held, cause),
		{ type: "announce", text: `cable from ${cableText(held.ends)} removed` },
	]);
}

/** Every cable out of the switch, at both its ends. */
export function uncableAll(state: LabState, on: SwitchName, cause: Cause): Step {
	const gone = cablesOf(state, on);
	if (gone.length === 0) return step(state);
	return step(
		{ ...state, switchCables: state.switchCables.filter((other) => !gone.includes(other)) },
		gone.flatMap((held) => takeOut(held, cause)),
	);
}

function linkCable(state: LabState, { port, up }: CableChange, cause: Cause): Step {
	const held = cableAt(state, port);
	if (!held || (held.link === "up") === up) return step(state);
	const changed: SwitchCable = { ends: held.ends, link: up ? "up" : "cut" };
	return step({ ...state, switchCables: state.switchCables.map((other) => (other === held ? changed : other)) }, [
		{ type: "cable/link", ends: held.ends, up, cause },
		{ type: "announce", text: `cable from ${cableText(held.ends)} ${up ? "reconnected" : "cut"}` },
	]);
}

/** Cuts or reconnects cables between switches. One that is already as asked, or gone, is left alone. */
export function linkCables(state: LabState, changes: readonly CableChange[], cause: Cause): Step {
	let result = step(state);
	for (const change of changes) result = andThen(result, (s) => linkCable(s, change, cause));
	return result;
}

export const STORM_BEGUN = "A storm has begun: frames go round a loop of cables until one of them is cut";
export const STORM_OVER = "The storm is over";

const noStorm = ({ storms }: Pick<LabState, "storms">): boolean => Object.keys(storms).length === 0;

/**
 * What the runtime says of a switch's storm: its numbers, or null when it is
 * over. The switches of a loop begin within a millisecond of each other, and
 * the page has one voice, so it says that a storm has begun with the first of
 * them and that it is over with the last. Which switches storm is theirs to show.
 */
export function storm(state: LabState, name: SwitchName, reading: Storm | null): Step {
	if (!state.switches.includes(name)) return step(state);
	const was = state.storms[name];
	if (reading === null) {
		if (!was) return step(state);
		const next = { ...state, storms: without(state.storms, name) };
		return step(next, noStorm(next) ? [{ type: "announce", text: STORM_OVER }] : []);
	}
	const same = was && was.since === reading.since && was.rate === reading.rate && was.dropped === reading.dropped;
	if (same) return step(state);
	return step(
		{ ...state, storms: { ...state.storms, [name]: reading } },
		noStorm(state) ? [{ type: "announce", text: STORM_BEGUN }] : [],
	);
}
