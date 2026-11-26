// A clock that moves only when a test moves it, for the lab's network without real timers.

import type { Clock } from "../../src/runtime/clock.ts";

export interface TestClock extends Clock {
	/** Moves time to `ms`, running each timer that falls due on the way at its own time, and what was put off for a task. */
	at(ms: number): void;
	/** Moves time on by `ms`, the same way. */
	pass(ms: number): void;
	/** How long each timer that was set was for, in order. */
	readonly waits: readonly number[];
	/** How many times a task of its own was asked for. */
	readonly tasks: number;
}

/** `tick` is what each look at the clock takes, for work that should be seen to take time. */
export function testClock(tick = 0): TestClock {
	let now = 0;
	let ids = 0;
	let tasks = 0;
	const timers = new Map<number, { readonly due: number; readonly fn: () => void }>();
	const queued: (() => void)[] = [];
	const waits: number[] = [];
	const settle = () => {
		for (let fn = queued.shift(); fn; fn = queued.shift()) fn();
	};
	const clock: TestClock = {
		now() {
			now += tick;
			return now;
		},
		after(ms, fn) {
			const id = ++ids;
			waits.push(ms);
			timers.set(id, { due: now + ms, fn });
			return () => void timers.delete(id);
		},
		soon(fn) {
			tasks++;
			queued.push(fn);
		},
		stop() {
			timers.clear();
			queued.length = 0;
		},
		at(ms) {
			settle();
			for (;;) {
				const next = [...timers].filter(([, timer]) => timer.due <= ms).sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].due);
				next[1].fn();
				settle();
			}
			now = Math.max(now, ms);
		},
		pass(ms) {
			clock.at(now + ms);
		},
		get waits() {
			return waits;
		},
		get tasks() {
			return tasks;
		},
	};
	return clock;
}
