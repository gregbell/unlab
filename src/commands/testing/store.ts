import {
	type CommandEvent,
	createStore,
	type Effect,
	initialState,
	type MachineName,
	type RuntimeEvent,
	type SessionId,
} from "../../model/index.ts";
import type { CommandDeps, ExecOutcome, ExecPort, ParsedLine } from "../define.ts";
import { createRegistry, parseLine } from "../index.ts";
import { isLineError, type LineError } from "../types.ts";
import { VERBS } from "../verbs/index.ts";
import { IMAGES, NO_EXEC } from "./lab.ts";

/**
 * The real store with every verb registered. The runtime is a recording
 * stand-in that answers `vm/stop` with `vm/stopped`, so removals finish.
 */
export function storeLab(exec: ExecPort = NO_EXEC) {
	const effects: Effect[] = [];
	const events: CommandEvent[] = [];
	let clock = 0;
	const store = createStore(initialState(IMAGES, { width: 1300, height: 500 }), (effect) => {
		effects.push(effect);
		if (effect.type === "vm/stop") {
			store.dispatchRuntime({ type: "vm/stopped", machine: effect.machine, attempt: effect.attempt });
		}
	});
	const deps: CommandDeps = {
		state: () => store.state,
		dispatch(event) {
			events.push(event);
			store.dispatchCommand(event);
		},
		until: store.until,
		now: () => clock,
		exec,
	};
	const registry = createRegistry(deps, VERBS);
	const signal = new AbortController().signal;

	const parsed = (line: string): ParsedLine => {
		const result = parseLine(registry, line, store.state);
		if (isLineError(result)) throw new Error(`expected ${line} to parse: ${result.message}`);
		return result;
	};

	const ready = (...names: readonly MachineName[]) => {
		for (const machine of names) store.dispatchRuntime({ type: "vm/ready", machine, attempt: 1, bootMs: 3582 });
	};

	return {
		store,
		registry,
		effects,
		events,
		signal,
		advance(ms: number) {
			clock += ms;
		},
		runtime(...list: readonly RuntimeEvent[]) {
			for (const event of list) store.dispatchRuntime(event);
		},
		ready,
		parse: (line: string): ParsedLine | LineError => parseLine(registry, line, store.state),
		parsed,
		/** Runs a safe line from the bar, as typed. */
		async run(line: string, source: "bar" | "button" | "agent" = "bar") {
			const p = parsed(line);
			if (p.danger) throw new Error(`${line} needs an approval`);
			return p.run({ source, signal });
		},
		/** Spawns `count` alpine machines and brings them all to ready. */
		async lab(count: number) {
			const before = store.state.nextN;
			const p = parsed(`spawn ${count} alpine`);
			if (p.danger) throw new Error("spawn is safe");
			await p.run({ source: "bar", signal });
			const names = Array.from({ length: count }, (_, i): MachineName => `node${before + i}`);
			ready(...names);
			events.length = 0;
			effects.length = 0;
			return names;
		},
	};
}

export interface InjectCall {
	readonly session: SessionId;
	readonly line: string;
	readonly source: string;
	readonly resolve: (outcome: ExecOutcome) => void;
	readonly reject: (error: Error) => void;
}

/** An exec port whose calls the test settles by hand, so it can see they all started before any finished. */
export function manualExec() {
	const calls: InjectCall[] = [];
	const port: ExecPort = {
		inject(session, line, source, signal) {
			return new Promise((resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason));
				calls.push({ session, line, source, resolve, reject });
			});
		},
	};
	return { port, calls };
}
