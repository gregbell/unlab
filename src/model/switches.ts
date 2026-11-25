import { parseSwitchName } from "./identity.ts";
import { nameHolder, unplugAll } from "./machines.ts";
import { patch, step } from "./step.ts";
import {
	type Cause,
	DEFAULT_SWITCH,
	type LabState,
	MAX_SWITCHES,
	type PortNo,
	type PortRef,
	type Step,
	type SwitchName,
	type SwitchPlan,
	type SwitchPlanError,
} from "./types.ts";

/** The name to show a switch's ports with, or null in a lab that has only that switch. */
export function switchLabel({ switches }: Pick<LabState, "switches">, on: SwitchName): SwitchName | null {
	return switches.length === 1 && switches[0] === on ? null : on;
}

/** `port 3`, or `lan port 3` by a label that there is. */
export function portText(label: SwitchName | null, port: PortNo): string {
	return label === null ? `port ${port}` : `${label} port ${port}`;
}

/** `port 3`, or `lan port 3` in a lab that has several switches. */
export function portLabel(lab: Pick<LabState, "switches">, { switch: on, port }: PortRef): string {
	return portText(switchLabel(lab, on), port);
}

function nextSwitchName(state: LabState): SwitchName {
	for (let n = 1; ; n++) {
		const name = parseSwitchName(`switch${n}`);
		if (typeof name === "string" && nameHolder(state, name) === null) return name;
	}
}

/** The switch that would be added, by a chosen name or by the lowest free `switch<n>`. */
export function planSwitch(state: LabState, chosen: SwitchName | null): SwitchPlan | SwitchPlanError {
	if (state.switches.length >= MAX_SWITCHES) return { kind: "no-switch-room" };
	const name = chosen ?? nextSwitchName(state);
	const by = nameHolder(state, name);
	return by ? { kind: "name-taken", name, by } : { name };
}

/** Ignored unless that is still the plan. */
export function addSwitch(state: LabState, { name }: SwitchPlan): Step {
	if ("kind" in planSwitch(state, name)) return step(state);
	return step({ ...state, switches: [...state.switches, name] }, [{ type: "announce", text: `${name} added` }]);
}

/** The links go down first, so the capture says which cables were in. */
export function removeSwitch(state: LabState, name: SwitchName, cause: Cause): Step {
	if (name === DEFAULT_SWITCH || !state.switches.includes(name)) return step(state);
	const { state: alone, effects } = unplugAll(state, name, cause);
	const [first, ...others] = alone.switches;
	const next: LabState = { ...alone, switches: [first, ...others.filter((other) => other !== name)] };
	return step(showSwitch(next, next.shownSwitch), [
		...effects,
		{ type: "switch/remove", switch: name },
		{ type: "announce", text: `${name} removed` },
	]);
}

/** The switch on the page, or the default one when it is not there. */
export function showSwitch(state: LabState, name: SwitchName): LabState {
	return patch(state, { shownSwitch: state.switches.includes(name) ? name : DEFAULT_SWITCH });
}
