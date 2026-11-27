// Which switches take part in the spanning tree. A switch takes none until it
// is told to, and one that is removed takes the setting with it, so a switch
// that is added under its name starts as any other. `settleStp` keeps that
// after every change, and tells the runtime. What each switch is in the tree
// is the runtime's to work out, with real messages between the switches, and
// `trees` has what it last said.

import { without } from "./record.ts";
import { step } from "./step.ts";
import type { Effect, LabState, PortRef, Step, SwitchName, Tree, TreePort } from "./types.ts";

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

/**
 * After every change: a switch that is gone takes part in nothing, the
 * runtime is told of each switch that begins or stops, and no reading is kept
 * of a switch that takes no part.
 */
export function settleStp(before: LabState, after: LabState): Step {
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

/** The effects that have a saved lab's switches take part again, before their cables are in. */
export function stpEffects({ stp }: Setting): readonly Effect[] {
	return stp.map((name) => ({ type: "switch/stp", switch: name, on: true }));
}
