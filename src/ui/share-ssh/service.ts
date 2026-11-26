import type { MachineName, ReadStore } from "../../model/index.ts";
import type { ShareService, ShareState } from "../services.ts";

type BackendState =
	| { readonly kind: "starting" }
	| { readonly kind: "ready"; readonly code: string }
	| { readonly kind: "failed"; readonly reason: string }
	| { readonly kind: "stopped" };

interface Entry {
	state: ShareState;
	generation: number;
	handle: { stop(): void } | null;
}

const IDLE: ShareState = { kind: "idle" };

/** Owns one share per guest while the page lives, independently of open views. */
export function createShareService(
	store: ReadStore,
	startBackend: (machine: MachineName, key: string, onState: (state: BackendState) => void) => { stop(): void },
): ShareService & { dispose(): void } {
	const entries = new Map<MachineName, Entry>();
	const listeners = new Map<MachineName, Set<() => void>>();
	const entry = (machine: MachineName): Entry => {
		let found = entries.get(machine);
		if (!found) {
			found = { state: IDLE, generation: 0, handle: null };
			entries.set(machine, found);
		}
		return found;
	};
	const publish = (machine: MachineName, current: Entry, state: ShareState): void => {
		current.state = state;
		for (const listener of listeners.get(machine) ?? []) listener();
	};
	const stop = (machine: MachineName): void => {
		const current = entries.get(machine);
		if (!current || current.state.kind === "idle") return;
		current.generation++;
		current.handle?.stop();
		current.handle = null;
		publish(machine, current, IDLE);
	};
	const start: ShareService["start"] = (machine, key) => {
		const current = entry(machine);
		if (current.state.kind === "starting" || current.state.kind === "ready") return;
		if (store.state.machines[machine]?.life.phase !== "ready") {
			publish(machine, current, { kind: "failed", reason: `${machine} is not ready.` });
			return;
		}
		const generation = ++current.generation;
		publish(machine, current, { kind: "starting" });
		try {
			const handle = startBackend(machine, key, (next) => {
				if (current.generation !== generation) return;
				switch (next.kind) {
					case "starting":
						publish(machine, current, { kind: "starting" });
						break;
					case "ready":
						publish(machine, current, { kind: "ready", command: `tailcat ssh user@${next.code}` });
						break;
					case "failed":
						current.generation++;
						current.handle?.stop();
						current.handle = null;
						publish(machine, current, { kind: "failed", reason: next.reason });
						break;
					case "stopped":
						current.generation++;
						current.handle = null;
						publish(machine, current, IDLE);
						break;
				}
			});
			if (current.generation === generation) current.handle = handle;
			else handle.stop();
		} catch (error) {
			if (current.generation !== generation) return;
			current.generation++;
			publish(machine, current, {
				kind: "failed",
				reason: error instanceof Error ? error.message : "The share could not start.",
			});
		}
	};
	const unsubscribeStore = store.subscribe(() => {
		for (const [machine, current] of entries) {
			if (
				(current.state.kind === "starting" || current.state.kind === "ready") &&
				store.state.machines[machine]?.life.phase !== "ready"
			)
				stop(machine);
		}
	});
	return {
		state: (machine) => entries.get(machine)?.state ?? IDLE,
		subscribe(machine, listener) {
			let group = listeners.get(machine);
			if (!group) {
				group = new Set();
				listeners.set(machine, group);
			}
			group.add(listener);
			return () => {
				group.delete(listener);
				if (group.size === 0) listeners.delete(machine);
			};
		},
		start,
		stop,
		dispose() {
			unsubscribeStore();
			for (const machine of entries.keys()) stop(machine);
		},
	};
}
