import { type Conditions, type ConditionValues, conditionsOf, isConditionsFault } from "../../src/model/index.ts";

/** A cable's conditions, for a test: `conditions({ delay: 100, loss: 20 })`. */
export function conditions(values: ConditionValues): Conditions {
	const read = conditionsOf(values);
	if (isConditionsFault(read)) throw new Error(`${JSON.stringify(values)}: ${read.kind}`);
	return read;
}

/** Numbers from 0 up to 1 that are the same for the same seed (mulberry32). */
export function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * What a fabric draws its losses and reorderings from, the same from run to
 * run: a stream of its own each time it asks for one. The seed was written
 * down before any result was seen, and is not to be changed for one.
 */
export function seededStreams(seed = 20261126): () => () => number {
	let streams = 0;
	return () => seeded(seed + streams++);
}
