// A real capture log for component tests, fed synthetic frames on a clock the
// test sets, and wired to the store the way the composition root and the
// engine wire the app's: filter and pause follow the store, and the
// `capture/clear` effect clears it.

import { type CaptureLog, createCaptureLog, followLab } from "../../src/capture/index.ts";
import {
	type Cause,
	DEFAULT_SWITCH,
	type Effect,
	type LabState,
	type MachineName,
	type PortNo,
	type ReadStore,
	type SwitchName,
	switchLabel,
} from "../../src/model/index.ts";
import type { Flood, NameBook, NicNo } from "../../src/net/index.ts";
import { NAMES } from "./frames.ts";

export interface TestCapture {
	readonly log: CaptureLog;
	/** Sets the log's clock, ms since the lab started. */
	at(ms: number): void;
	/** Who is who from now on: node1 to node8 until it is set. */
	names(names: NameBook): void;
	/** Rows name their switch from now on as they do in that lab. */
	switches(lab: Pick<LabState, "switches">): void;
	frame(bytes: Uint8Array, from: PortNo, to?: readonly PortNo[], flood?: Flood | null, on?: SwitchName): void;
	link(port: PortNo, machine: MachineName, up: boolean, cause?: Cause, nic?: NicNo): void;
	/** Pass as `mount`'s `onEffect`. */
	readonly onEffect: (effect: Effect) => void;
	/** Applies the store's filter and pause to the log from now on, as main.ts does. */
	follow(store: ReadStore): void;
}

export function testCapture(limit?: number): TestCapture {
	let now = 0;
	let names: NameBook = NAMES;
	let lab: Pick<LabState, "switches"> = { switches: [DEFAULT_SWITCH] };
	const log = createCaptureLog({
		limit,
		schedule: (fn) => fn(),
		now: () => now,
		names: () => names,
		rowNames: { switchLabel: (on) => switchLabel(lab, on) },
	});
	return {
		log,
		at(ms) {
			now = ms;
		},
		names(next) {
			names = next;
		},
		switches(next) {
			lab = next;
		},
		frame(bytes, from, to = [], flood = null, on = DEFAULT_SWITCH) {
			const mask = to.reduce((m, p) => m | (1 << (p - 1)), 0);
			log.appendFrame({ switch: on, from, to: mask, flood, frame: bytes });
		},
		link(port, machine, up, cause = "button", nic = 0) {
			log.appendLink({ port: { switch: DEFAULT_SWITCH, port }, machine, nic, up, cause });
		},
		onEffect(effect) {
			if (effect.type === "capture/clear") log.clear();
		},
		follow(store) {
			followLab(log, store);
		},
	};
}
