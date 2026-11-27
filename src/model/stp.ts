// Which switches take part in the spanning tree, and how it is steered: each
// switch's priority, and what each port costs. A switch takes no part until it
// is told to, a free port costs what every port starts with, and a switch that
// is removed takes its settings with it, so a switch that is added under its
// name starts as any other. `settleStp` keeps that after every change, and
// tells the runtime. What each switch is in the tree is the runtime's to work
// out, with real messages between the switches, and `trees` has what it last
// said.

import { heldPorts, samePort, type Wiring } from "./machines.ts";
import { without } from "./record.ts";
import { step } from "./step.ts";
import {
	type BridgePriority,
	type BridgeRef,
	DEFAULT_COST,
	DEFAULT_PRIORITY,
	type Effect,
	type LabState,
	MAX_COST,
	MAX_PRIORITY,
	MIN_COST,
	type PathCost,
	type PortCost,
	type PortRef,
	PRIORITY_STEP,
	type Step,
	type SwitchName,
	type Tree,
	type TreePort,
} from "./types.ts";

type Setting = Pick<LabState, "stp">;

export function stpOn({ stp }: Setting, on: SwitchName): boolean {
	return stp.includes(on);
}

/** Turns it on or off for each of the switches that is there. One that is already so is left alone. */
export function setStp(state: LabState, switches: readonly SwitchName[], on: boolean): Step {
	const stp = state.switches.filter((name) => (switches.includes(name) ? on : stpOn(state, name)));
	const same = stp.length === state.stp.length && stp.every((name, i) => name === state.stp[i]);
	return step(same ? state : { ...state, stp });
}

const WHOLE = /^(0|[1-9][0-9]*)$/;

/** A step of 4096 from 0 to 61440, written as a whole number, or null. */
export function parsePriority(text: string): BridgePriority | null {
	if (!WHOLE.test(text)) return null;
	const n = Number(text);
	return n <= MAX_PRIORITY && n % PRIORITY_STEP === 0 ? (n as BridgePriority) : null;
}

/** A whole number from 1 to 200,000,000, or null. */
export function parseCost(text: string): PathCost | null {
	if (!WHOLE.test(text)) return null;
	const n = Number(text);
	return n >= MIN_COST && n <= MAX_COST ? (n as PathCost) : null;
}

export function priorityOf({ priorities }: Pick<LabState, "priorities">, on: SwitchName): BridgePriority {
	return priorities[on] ?? DEFAULT_PRIORITY;
}

export function costOf({ portCosts }: Pick<LabState, "portCosts">, port: PortRef): PathCost {
	return portCosts.find((held) => samePort(held.port, port))?.cost ?? DEFAULT_COST;
}

/** Sets it for each of the switches that is there. 32768 is kept as no setting, as it is where every switch starts. */
export function setPriority(state: LabState, switches: readonly SwitchName[], priority: BridgePriority): Step {
	const changed = switches.filter((name) => state.switches.includes(name) && priorityOf(state, name) !== priority);
	if (changed.length === 0) return step(state);
	const kept = Object.entries(state.priorities).filter(([name]) => !changed.some((other) => other === name));
	const set = priority === DEFAULT_PRIORITY ? [] : changed.map((name) => [name, priority] as const);
	return step({ ...state, priorities: Object.fromEntries([...kept, ...set]) });
}

/** Ignored unless something is in the port. 20000 is kept as no setting. */
export function setCost(state: LabState, port: PortRef, cost: PathCost): Step {
	const held = heldPorts(state, port.switch).some((other) => other.port === port.port);
	if (!held || costOf(state, port) === cost) return step(state);
	const others = state.portCosts.filter((other) => !samePort(other.port, port));
	return step({ ...state, portCosts: cost === DEFAULT_COST ? others : [...others, { port, cost }] });
}

/** Those that something is in, on switches that are there. */
export function heldCosts(state: Wiring & Pick<LabState, "switches">, costs: readonly PortCost[]): readonly PortCost[] {
	return costs.filter(
		({ port }) =>
			state.switches.includes(port.switch) && heldPorts(state, port.switch).some((held) => held.port === port.port),
	);
}

/**
 * After every change: a switch that is gone takes its priority with it, a port
 * that nothing is in costs 20000 again, and the runtime is told of each switch
 * and port whose setting changed and that it still has.
 */
function settleSteering(before: LabState, after: LabState): Step {
	const unchanged =
		before.priorities === after.priorities &&
		before.portCosts === after.portCosts &&
		before.machines === after.machines &&
		before.switchCables === after.switchCables &&
		before.switches === after.switches;
	if (unchanged) return step(after);
	const gone = Object.keys(after.priorities).filter((name) => !after.switches.some((on) => on === name));
	const priorities = gone.reduce<LabState["priorities"]>(
		(held, name) => without(held, name as SwitchName),
		after.priorities,
	);
	const kept = heldCosts(after, after.portCosts);
	const portCosts = kept.length === after.portCosts.length ? after.portCosts : kept;
	const state = gone.length === 0 && portCosts === after.portCosts ? after : { ...after, priorities, portCosts };
	// A switch that was not there before is new in the runtime, where it has the priority that every switch starts with.
	const was = (on: SwitchName): BridgePriority =>
		before.switches.includes(on) ? priorityOf(before, on) : DEFAULT_PRIORITY;
	const effects: Effect[] = state.switches.flatMap((on): Effect[] => {
		const priority = priorityOf(state, on);
		return priority === was(on) ? [] : [{ type: "switch/priority", switch: on, priority }];
	});
	for (const { port } of before.portCosts) {
		if (state.switches.includes(port.switch) && !kept.some((now) => samePort(now.port, port))) {
			effects.push({ type: "port/cost", port, cost: DEFAULT_COST });
		}
	}
	for (const { port, cost } of kept) {
		if (costOf(before, port) !== cost) effects.push({ type: "port/cost", port, cost });
	}
	return step(state, effects);
}

/**
 * After every change: a switch that is gone takes part in nothing, the
 * runtime is told of each switch that begins or stops, and no reading is kept
 * of a switch that takes no part. Then its priority and its ports' costs, as
 * `settleSteering` keeps them.
 */
export function settleStp(before: LabState, after: LabState): Step {
	const taking = settleTaking(before, after);
	const steering = settleSteering(before, taking.state);
	return step(steering.state, [...steering.effects, ...taking.effects]);
}

function settleTaking(before: LabState, after: LabState): Step {
	if (before.stp === after.stp && before.switches === after.switches) return step(after);
	const kept = after.stp.filter((name) => after.switches.includes(name));
	const stp = kept.length === after.stp.length ? after.stp : kept;
	const stale = Object.keys(after.trees).filter((name) => !stp.some((on) => on === name));
	const trees = stale.reduce<LabState["trees"]>((left, name) => without(left, name as SwitchName), after.trees);
	const state = stp === after.stp && stale.length === 0 ? after : { ...after, stp, trees };
	// A switch that was removed is gone from the runtime with its tree, and one of its name that is there now is new.
	const was = (name: SwitchName): boolean => stpOn(before, name) && before.switches.includes(name);
	const effects = after.switches.flatMap((name): Effect[] => {
		const on = stpOn(state, name);
		return on === was(name) ? [] : [{ type: "switch/stp", switch: name, on }];
	});
	return step(state, effects);
}

const sameBridge = (a: Tree["bridge"], b: Tree["bridge"]): boolean =>
	a.priority === b.priority && a.address === b.address;

function sameTree(a: Tree, b: Tree): boolean {
	return (
		sameBridge(a.bridge, b.bridge) &&
		sameBridge(a.root, b.root) &&
		a.cost === b.cost &&
		a.ports.length === b.ports.length &&
		a.ports.every((port, i) => {
			const other = b.ports[i];
			return port.port === other.port && port.role === other.role && port.state === other.state;
		})
	);
}

/** What the runtime says of a switch's part in the tree. Ignored for a switch that takes none. */
export function tree(state: LabState, name: SwitchName, reading: Tree): Step {
	if (!stpOn(state, name) || !state.switches.includes(name)) return step(state);
	const was = state.trees[name];
	if (was && sameTree(was, reading)) return step(state);
	return step({ ...state, trees: { ...state.trees, [name]: reading } });
}

/** The switch that the tree of `on` takes for its root, once that switch has said what it is. */
export function rootOf({ switches, trees }: Pick<LabState, "switches" | "trees">, on: SwitchName): SwitchName | null {
	const root = trees[on]?.root;
	if (!root) return null;
	return switches.find((name) => trees[name]?.bridge.address === root.address) ?? null;
}

/** `32768.02:00:a1:b2:c3:d4`: a bridge's priority as a command takes it, and then its address. */
export const bridgeText = ({ priority, address }: BridgeRef): string => `${priority}.${address}`;

/** What the port is in its switch's tree, or undefined for a port with no link, or of a switch that takes no part. */
export function treePortAt({ trees }: Pick<LabState, "trees">, { switch: on, port }: PortRef): TreePort | undefined {
	return trees[on]?.ports.find((held) => held.port === port);
}

/** What a port that the tree keeps out of use is called where there is room for one word. */
export const BLOCKED = "blocked";

/** `blocked` for a port that carries nothing, `learning` for one on its way into use, and null for one that carries. */
export function treeWord(port: Pick<TreePort, "state"> | undefined): typeof BLOCKED | "learning" | null {
	if (!port || port.state === "forwarding") return null;
	return port.state === "discarding" ? BLOCKED : "learning";
}

/** `blocked by spanning tree`, where there is room to say what blocked it. */
export function treeText(port: Pick<TreePort, "state"> | undefined): string | null {
	const word = treeWord(port);
	return word === BLOCKED ? `${BLOCKED} by spanning tree` : word;
}

/** `root port`, `alternate port · blocked`: its role, and its state where it does not carry. */
export function treeRoleText(port: Pick<TreePort, "role" | "state"> | undefined): string | null {
	if (!port) return null;
	const word = treeWord(port);
	return [`${port.role} port`, ...(word ? [word] : [])].join(" · ");
}

/**
 * The effects that give a saved lab's switches their priorities and its ports their costs, and then have its
 * switches take part again, before their cables are in.
 */
export function stpEffects({
	stp,
	priorities,
	portCosts,
}: Pick<LabState, "stp" | "priorities" | "portCosts">): readonly Effect[] {
	return [
		...Object.entries(priorities).flatMap(([name, priority]): Effect[] =>
			priority === undefined ? [] : [{ type: "switch/priority", switch: name as SwitchName, priority }],
		),
		...portCosts.map(({ port, cost }): Effect => ({ type: "port/cost", port, cost })),
		...stp.map((name): Effect => ({ type: "switch/stp", switch: name, on: true })),
	];
}
