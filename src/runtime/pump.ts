// What calls the fabric when its cables have frames to carry. Frames that are
// due go on in the task that brought them, for at most a few milliseconds, and
// then in a task of their own, so a storm never keeps the page from its other
// work. For what is due later it sets one timer. A frame that is due is
// waited for to the millisecond, and a timer of the spanning tree, which
// counts in seconds, with one wait however long it is.

import type { PortNo } from "../model/index.ts";
import type { Clock } from "./clock.ts";
import type { Fabric } from "./fabric.ts";

export interface Pump {
	/** A machine put a frame on the wire. */
	receive(slot: number, port: PortNo, frame: Uint8Array): void;
	/** The fabric was told something that it works out when it is next drained, which is now. */
	wake(): void;
	stop(): void;
}

/** How long the fabric has a task for, before the page's other tasks have theirs. */
const BUDGET_MS = 4;
/** Turns between two looks at the clock. */
const BATCH = 64;
/** Chromium lets a timer of more than about 32 ms be 8 ms late, so a longer wait is taken in steps. */
const STEP_MS = 30;

export function createPump(fabric: Fabric, clock: Clock): Pump {
	let running = false;
	/** A task of its own is on its way. */
	let resuming = false;
	let stopped = false;
	let cancel: (() => void) | null = null;
	let wakesAt = Number.POSITIVE_INFINITY;

	const sleep = (now: number): void => {
		const at = fabric.next();
		const timer = fabric.timer();
		if (at < 0 && timer < 0) {
			cancel?.();
			cancel = null;
			wakesAt = Number.POSITIVE_INFINITY;
			return;
		}
		// Whole milliseconds, rounded up: a timer cuts a fraction off, wakes early, and is set again for nothing.
		const until = (due: number): number => (due < 0 ? Number.POSITIVE_INFINITY : Math.max(0, Math.ceil(due - now)));
		const wait = Math.min(until(timer), at < 0 ? Number.POSITIVE_INFINITY : Math.min(STEP_MS, until(at)));
		if (cancel && wakesAt <= now + wait) return;
		cancel?.();
		wakesAt = now + wait;
		cancel = clock.after(wait, () => {
			cancel = null;
			wakesAt = Number.POSITIVE_INFINITY;
			run();
		});
	};

	const run = (started = clock.now()): void => {
		if (running || resuming || stopped) return;
		running = true;
		let now = started;
		// Until the fabric says that nothing is due, it has more: its time is up, or it threw on a frame, which by
		// then had left its cable. Whoever called hears what it threw, and the rest goes on in a task of its own.
		let more = true;
		try {
			while (fabric.drain(now, BATCH) > 0) {
				now = clock.now();
				if (now - started >= BUDGET_MS) return;
			}
			more = false;
		} finally {
			running = false;
			if (more) {
				resuming = true;
				clock.soon(() => {
					resuming = false;
					run();
				});
			} else {
				sleep(now);
			}
		}
	};

	return {
		receive(slot, port, frame) {
			const now = clock.now();
			fabric.receive(slot, port, frame, now);
			if (fabric.busy) run(now);
		},
		wake() {
			run();
		},
		stop() {
			stopped = true;
			cancel?.();
			cancel = null;
		},
	};
}
