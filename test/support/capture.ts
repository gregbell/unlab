// A real capture log for component tests, fed synthetic frames on a clock the
// test sets, and wired to the store the way the composition root and the
// engine wire the app's: filter and pause follow the store, and the
// `capture/clear` effect clears it.

import { type CaptureLog, createCaptureLog } from "../../src/capture/index.ts";
import type { Cause, Effect, MachineName, PortNo, ReadStore } from "../../src/model/index.ts";
import { compileFilter, type Flood, type NicNo } from "../../src/net/index.ts";
import { ADDRESSES } from "./frames.ts";

export interface TestCapture {
	readonly log: CaptureLog;
	/** Sets the log's clock, ms since the lab started. */
	at(ms: number): void;
	frame(bytes: Uint8Array, from: PortNo, to?: readonly PortNo[], flood?: Flood | null): void;
	link(port: PortNo, machine: MachineName, up: boolean, cause?: Cause, nic?: NicNo): void;
	/** Pass as `mount`'s `onEffect`. */
	readonly onEffect: (effect: Effect) => void;
	/** Applies the store's filter and pause to the log from now on, as main.ts does. */
	follow(store: ReadStore): void;
}

export function testCapture(limit?: number): TestCapture {
	let now = 0;
	const log = createCaptureLog({ limit, schedule: (fn) => fn(), now: () => now, addresses: () => ADDRESSES });
	return {
		log,
		at(ms) {
			now = ms;
		},
		frame(bytes, from, to = [], flood = null) {
			const mask = to.reduce((m, p) => m | (1 << (p - 1)), 0);
			log.appendFrame({ from, to: mask, flood, frame: bytes });
		},
		link(port, machine, up, cause = "button", nic = 0) {
			log.appendLink({ port, machine, nic, up, cause });
		},
		onEffect(effect) {
			if (effect.type === "capture/clear") log.clear();
		},
		follow(store) {
			let { filter, paused } = store.state.capture;
			store.subscribe(() => {
				const next = store.state.capture;
				if (next.filter !== filter) {
					filter = next.filter;
					const compiled = compileFilter(filter);
					if (compiled.ok) log.setFilter(compiled.filter);
				}
				if (next.paused !== paused) {
					paused = next.paused;
					log.setPaused(paused);
				}
			});
		},
	};
}
