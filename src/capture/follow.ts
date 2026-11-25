import { type ReadStore, selectNames } from "../model/index.ts";
import { compileFilter, type NameBook } from "../net/index.ts";
import type { CaptureLog } from "./log.ts";

const switchNames = ({ switches }: NameBook): string => [...switches].join();

/**
 * Keeps the log filtered and paused as the lab's state says. A filter that
 * cannot be read leaves the one before it.
 */
export function followLab(log: Pick<CaptureLog, "setFilter" | "setPaused">, store: ReadStore): () => void {
	let read = true;
	let { filter, paused } = store.state.capture;
	let known = selectNames(store.state);
	return store.subscribe(() => {
		const next = store.state.capture;
		const names = selectNames(store.state);
		// A word that named nothing when it was typed can name something later, and a machine's that is gone, a switch.
		const renamed = names !== known && (!read || switchNames(names) !== switchNames(known));
		known = names;
		if (next.filter !== filter || renamed) {
			filter = next.filter;
			const compiled = compileFilter(filter, names);
			read = compiled.ok;
			if (compiled.ok) log.setFilter(compiled.filter);
		}
		if (next.paused !== paused) {
			paused = next.paused;
			log.setPaused(paused);
		}
	});
}
