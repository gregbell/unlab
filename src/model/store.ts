import type {
	AgentEvent,
	CommandEvent,
	Effect,
	LabEvent,
	LabState,
	LinkEvent,
	RuntimeEvent,
	UiEvent,
} from "./types.ts";
import { update } from "./update.ts";

export interface ReadStore {
	readonly state: LabState;
	/** `listener` runs after each event that changed the state. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/**
	 * Resolves with the first state for which `predicate` holds, now or after a
	 * later commit. Rejects with the signal's reason on abort. This is how a
	 * command waits until its effect is visible.
	 */
	until(predicate: (state: LabState) => boolean, signal: AbortSignal): Promise<LabState>;
}

/** One dispatcher per producer, each narrowed to its own events. An element that holds only `dispatchUi` cannot spawn. */
export interface Store extends ReadStore {
	readonly dispatchRuntime: (event: RuntimeEvent) => void;
	readonly dispatchCommand: (event: CommandEvent) => void;
	readonly dispatchUi: (event: UiEvent) => void;
	readonly dispatchAgent: (event: AgentEvent) => void;
	readonly dispatchLink: (event: LinkEvent) => void;
}

/** Runs `flush` later, for example on the next animation frame. */
export type Schedule = (flush: () => void) => void;

/**
 * Applies events one at a time: reduce, tell the subscribers, then run the
 * effects. A dispatch made while that is going on (an effect reporting back,
 * a subscriber reacting) waits its turn, first in, first out, so effects run
 * in the order of the events that caused them.
 *
 * A subscriber or effect that throws does not stop the rest. Its error is
 * thrown from the outermost dispatch once the queue is empty.
 *
 * With a `schedule`, subscribers are told once per flush instead of once per
 * commit. Effects and `until` never wait for it.
 */
export function createStore(initial: LabState, runEffect: (effect: Effect) => void, schedule?: Schedule): Store {
	let state = initial;
	let draining = false;
	let flushScheduled = false;
	const queue: LabEvent[] = [];
	const listeners = new Set<{ readonly listener: () => void }>();
	const waiters = new Set<() => void>();

	function tell(errors: unknown[]): void {
		for (const entry of [...listeners]) {
			if (!listeners.has(entry)) continue;
			try {
				entry.listener();
			} catch (error) {
				errors.push(error);
			}
		}
	}

	function flush(): void {
		flushScheduled = false;
		const errors: unknown[] = [];
		tell(errors);
		raise(errors);
	}

	function notify(errors: unknown[]): void {
		if (!schedule) {
			tell(errors);
			return;
		}
		if (flushScheduled) return;
		flushScheduled = true;
		try {
			schedule(flush);
		} catch (error) {
			flushScheduled = false;
			errors.push(error);
		}
	}

	function apply(event: LabEvent, errors: unknown[]): void {
		const step = update(state, event);
		if (step.state !== state) {
			state = step.state;
			notify(errors);
			for (const check of [...waiters]) check();
		}
		for (const effect of step.effects) {
			try {
				runEffect(effect);
			} catch (error) {
				errors.push(error);
			}
		}
	}

	function dispatch(event: LabEvent): void {
		queue.push(event);
		if (draining) return;
		draining = true;
		const errors: unknown[] = [];
		try {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) apply(next, errors);
		} finally {
			draining = false;
		}
		raise(errors);
	}

	return {
		get state() {
			return state;
		},
		subscribe(listener) {
			const entry = { listener };
			listeners.add(entry);
			return () => {
				listeners.delete(entry);
			};
		},
		until(predicate, signal) {
			return new Promise((resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				const stop = (): void => {
					waiters.delete(check);
					signal.removeEventListener("abort", onAbort);
				};
				const onAbort = (): void => {
					stop();
					reject(signal.reason);
				};
				const check = (): void => {
					try {
						if (!predicate(state)) return;
					} catch (error) {
						stop();
						reject(error);
						return;
					}
					stop();
					resolve(state);
				};
				waiters.add(check);
				signal.addEventListener("abort", onAbort);
				check();
			});
		},
		dispatchRuntime: dispatch,
		dispatchCommand: dispatch,
		dispatchUi: dispatch,
		dispatchAgent: dispatch,
		dispatchLink: dispatch,
	};
}

function raise(errors: readonly unknown[]): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "more than one subscriber or effect threw");
}
