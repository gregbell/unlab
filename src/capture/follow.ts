import { type ReadStore, selectNames } from "../model/index.ts";
import { compileFilter } from "../net/index.ts";
import type { CaptureLog } from "./log.ts";

/**
 * Keeps the log filtered and paused as the lab's state says. A filter that
 * cannot be read leaves the one before it.
 */
export function followLab(log: Pick<CaptureLog, "setFilter" | "setPaused">, store: ReadStore): () => void {
	let read = true;
	let was = store.state;
	let known = selectNames(was);
	return store.subscribe(() => {
		const now = store.state;
		const names = selectNames(now);
		const { filter, paused } = now.capture;
		// A word that named nothing when it was typed can name something later, and one that named a machine that is gone, a switch.
		const renamed =
			(!read && names !== known) || now.switches !== was.switches || now.departedSwitches !== was.departedSwitches;
		if (filter !== was.capture.filter || (filter !== "" && renamed)) {
			const compiled = compileFilter(filter, names);
			read = compiled.ok;
			if (compiled.ok) log.setFilter(compiled.filter);
		}
		if (paused !== was.capture.paused) log.setPaused(paused);
		was = now;
		known = names;
	});
}
