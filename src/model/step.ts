import type { Effect, LabState, Step } from "./types.ts";

const NO_EFFECTS: readonly Effect[] = [];

export function step(state: LabState, effects: readonly Effect[] = NO_EFFECTS): Step {
	return { state, effects };
}

/** Runs `next` on the state `first` produced and keeps the effects in order. */
export function andThen(first: Step, next: (state: LabState) => Step): Step {
	const second = next(first.state);
	if (second.effects.length === 0) return step(second.state, first.effects);
	return step(second.state, [...first.effects, ...second.effects]);
}

/** The lab clock never runs backwards, and a stamp that is not a number does not move it. */
export const later = (now: number, at: number): number => (Number.isNaN(at) ? now : Math.max(now, at));

/** `target` with `fields` set, or `target` itself when they already hold. */
export function patch<T extends object>(target: T, fields: Partial<T>): T {
	const same = Object.entries(fields).every(([key, value]) => Object.is(Reflect.get(target, key), value));
	return same ? target : { ...target, ...fields };
}
