// The runtime as the page runs it: real workers, real terminals, real timers.
// Everything it owns stays behind the Engine it returns.

import type { CaptureLog } from "../capture/index.ts";
import { createEngine, type Engine, type RuntimeStore } from "./engine.ts";
import { type DistroManifest, imageSource } from "./image.ts";
import { createScreens } from "./screens.ts";
import { LabSwitch } from "./switch.ts";
import { startVm } from "./vm.ts";
import { spawnVmWorker } from "./worker.ts";

export interface RuntimeOptions {
	readonly store: RuntimeStore;
	/** Created by the page, so it shares the page's notification scheduling. */
	readonly capture: CaptureLog;
	readonly manifest: DistroManifest;
	/** The page's one polite live region. */
	readonly announce: (text: string) => void;
	/** ms since the lab started. The capture log must use the same clock. */
	readonly now: () => number;
}

export function createRuntime(options: RuntimeOptions): Engine {
	const { now } = options;
	return createEngine({
		store: options.store,
		capture: options.capture,
		sw: new LabSwitch({ now }),
		screens: createScreens(),
		startVm: (boot, sink) =>
			startVm(boot, sink, {
				createWorker: spawnVmWorker,
				after: (ms, fn) => {
					setTimeout(fn, ms);
				},
				now,
			}),
		image: imageSource(options.manifest),
		announce: options.announce,
		every(ms, fn) {
			const id = setInterval(fn, ms);
			return () => clearInterval(id);
		},
		now,
		promptToken: () =>
			Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join(""),
	});
}
