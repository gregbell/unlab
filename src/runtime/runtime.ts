// The runtime as the page runs it: real workers, real terminals, real timers.
// Everything it owns stays behind the Engine it returns.

import type { CaptureLog } from "../capture/index.ts";
import { MAX_EXTRA_DISKS } from "../model/index.ts";
import { browserClock } from "./clock.ts";
import { deleteDisks } from "./disk-stores.ts";
import { createEngine, type Engine, type RuntimeStore } from "./engine.ts";
import { Fabric } from "./fabric.ts";
import { type DistroManifest, imageSource } from "./image.ts";
import { createScreens } from "./screens.ts";
import { startVm } from "./vm.ts";
import { spawnVmWorker, startCopy } from "./worker.ts";

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
	const clock = browserClock(now);
	const engine = createEngine({
		store: options.store,
		capture: options.capture,
		clock,
		newFabric: (events) => new Fabric(events),
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
		deleteDisks: (n, sets) => void deleteDisks(n, sets, MAX_EXTRA_DISKS),
		startCopy,
		announce: options.announce,
		every(ms, fn) {
			const id = setInterval(fn, ms);
			return () => clearInterval(id);
		},
		promptToken: () =>
			Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join(""),
	});
	return {
		...engine,
		dispose() {
			engine.dispose();
			clock.stop();
		},
	};
}
