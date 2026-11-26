import { uncableAll } from "./cables.ts";
import { parseSwitchName } from "./identity.ts";
import { nameHolder, unplugAll } from "./machines.ts";
import { without } from "./record.ts";
import { andThen, patch, step } from "./step.ts";
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

/** How a command names a port, and how it is named where someone is told what to type. No other name has that form. */
export function portName({ switch: on, port }: PortRef): `${SwitchName}:${PortNo}` {
	return `${on}:${port}`;
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
	const departedSwitches = state.departedSwitches.filter((gone) => gone !== name);
	return step({ ...state, switches: [...state.switches, name], departedSwitches }, [
		{ type: "announce", text: `${name} added` },
	]);
}

/** The links go down first, so the capture says which cables were in. */
export function removeSwitch(state: LabState, name: SwitchName, cause: Cause): Step {
	if (name === DEFAULT_SWITCH || !state.switches.includes(name)) return step(state);
	const { state: alone, effects } = andThen(unplugAll(state, name, cause), (s) => uncableAll(s, name, cause));
	const [first, ...others] = alone.switches;
	const next: LabState = {
		...alone,
		switches: [first, ...others.filter((other) => other !== name)],
		departedSwitches: [...state.departedSwitches, name],
		storms: without(alone.storms, name),
	};
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
