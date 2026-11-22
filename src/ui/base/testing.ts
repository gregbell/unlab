// For component tests only: mounts an element under a services provider whose
// store is the real one, so a test drives it with the same events the app does.

import "../styles/index.css";
import { ContextProvider } from "@lit/context";
import { ReactiveElement } from "lit";
import type { CaptureView } from "../../capture/index.ts";
import { completeLine, createRegistry, parseLine, VERBS } from "../../commands/index.ts";
import {
	type AgentCall,
	type AgentEvent,
	createStore,
	type Effect,
	initialState,
	isPlanError,
	type LabEvent,
	type LabState,
	type MachineName,
	type MachineSpec,
	type PortNo,
	planLink,
	planSpawn,
	type Source,
	type Store,
	update,
} from "../../model/index.ts";
import type { AppServices, SwitchReadout, TerminalService } from "../services.ts";
import { servicesContext } from "./context.ts";

const TEST_IMAGES = [{ name: "alpine", label: "alpine 3.24" }] as const;

/** One step in building a lab: an event, or events made from the state so far. */
export type Step = LabEvent | ((state: LabState) => readonly LabEvent[]);

/** A lab built the way the app builds one: every step goes through `update`. */
export function lab(...steps: readonly Step[]): LabState {
	return steps.reduce<LabState>(
		(state, step) => {
			const events = typeof step === "function" ? step(state) : [step];
			return events.reduce((next, event) => update(next, event).state, state);
		},
		initialState(TEST_IMAGES, { width: 1300, height: 500 }),
	);
}

export const spawn =
	(count: number, net: MachineSpec["net"] = "switch0"): Step =>
	(state) => {
		const plan = planSpawn(state, count, { image: "alpine", memMiB: 256, net });
		if (isPlanError(plan)) throw new Error(`cannot spawn ${count}: ${plan.kind}`);
		return [{ type: "cmd/spawn", plan, at: state.now }];
	};

/** The named machines, or every booting one, reach their prompt after 3582 ms. */
export const ready =
	(...names: readonly MachineName[]): Step =>
	(state) =>
		(names.length > 0 ? names : state.rail).flatMap((machine) => {
			const life = state.machines[machine]?.life;
			return life?.phase === "booting" ? [{ type: "vm/ready", machine, attempt: life.attempt, bootMs: 3582 }] : [];
		});

export const fail =
	(machine: MachineName, reason = "Kernel panic."): Step =>
	(state) => [{ type: "vm/failed", machine, attempt: state.machines[machine]?.life.attempt ?? 1, reason }];

export const link =
	(direction: "up" | "down", ...machines: readonly MachineName[]): Step =>
	(state) => {
		const changes = planLink(state, machines, direction === "up");
		if (isPlanError(changes)) throw new Error(`cannot link ${direction}: ${changes.kind}`);
		return [{ type: "cmd/link", changes, cause: "bar" }];
	};

export const focus = (target: MachineName): LabEvent => ({ type: "cmd/focus", target, mode: "plain" });
export const remove = (...machines: readonly MachineName[]): LabEvent => ({
	type: "cmd/remove",
	machines,
	cause: "bar",
});
export const park = (machine: MachineName): LabEvent => ({ type: "ui/park", machine });
export const tick = (now: number): LabEvent => ({ type: "tick", now });
export const agentCall = (id: number, status: AgentCall["status"] = "done"): AgentEvent => ({
	type: "agent/call",
	call: { id, tool: "machines_list", line: "ls", status, preview: null, actionLabel: null, result: null, at: 0 },
});

export interface Counters {
	readonly rxFrames: number;
	readonly txFrames: number;
}

export interface Mounted<E extends HTMLElement> {
	readonly element: E;
	readonly store: Store;
	readonly services: AppServices;
	/** Every line run through `services.commands.run`, in order. */
	readonly runs: { readonly line: string; readonly source: Exclude<Source, "agent"> }[];
	/** Every line handed to `services.commands.confirmInBar`. */
	readonly confirms: string[];
	/** What `services.switch.counters(port)` answers. */
	readonly counters: Map<PortNo, Counters>;
	/** Resolves once every element in the tree has rendered. */
	settle(): Promise<void>;
}

export interface MountOptions<E extends HTMLElement> {
	/** The state to start from. Defaults to an empty lab with room for three columns and two rows. */
	readonly state?: LabState;
	/** What `services.switch.counters(port)` answers from the start. */
	readonly counters?: Iterable<readonly [PortNo, Counters]>;
	/** Receives every effect the store emits, as the runtime would. */
	readonly onEffect?: (effect: Effect) => void;
	/** The capture the element reads. Defaults to an empty one that never changes. */
	readonly capture?: CaptureView;
	/** The switch's MAC table and clock. Defaults to an empty table at time 0; `counters` still applies. */
	readonly switch?: Pick<SwitchReadout, "macTable" | "now">;
	/** The terminal screens. Defaults to none: every `host` is null. */
	readonly terminals?: TerminalService;
	/** Runs before the element connects: <unlab-app> takes its services here. */
	readonly prepare?: (element: E, services: AppServices) => void;
}

const EMPTY_CAPTURE: CaptureView = {
	revision: 0,
	size: 0,
	frameCount: 0,
	matchCount: 0,
	matchedFrames: 0,
	counters: { in: 0, delivered: 0, flooded: 0 },
	tail: () => [],
	window: () => [],
	indexOf: () => -1,
	entry: () => null,
	frames: () => [],
	subscribe: () => () => {},
};

const mountedHosts = new Set<HTMLElement>();

export async function mount<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	options: MountOptions<HTMLElementTagNameMap[K]> = {},
): Promise<Mounted<HTMLElementTagNameMap[K]>> {
	const store = createStore(options.state ?? lab(), (effect) => options.onEffect?.(effect));
	const runs: Mounted<HTMLElement>["runs"] = [];
	const confirms: string[] = [];
	const counters = new Map<PortNo, Counters>(options.counters);
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: () => {},
			until: (predicate, signal) => store.until(predicate, signal),
			now: () => store.state.now,
			exec: { inject: () => Promise.reject(new Error("This fixture has no runtime.")) },
		},
		VERBS,
	);
	const services: AppServices = {
		store,
		commands: {
			registry,
			parse: (line) => parseLine(registry, line, store.state),
			complete: (line, caret) => completeLine(registry, line, caret, store.state),
			run: async (line, source) => {
				runs.push({ line, source });
				return { kind: "visible", text: "", data: null };
			},
			confirmInBar: (line) => {
				confirms.push(line);
			},
		},
		capture: options.capture ?? EMPTY_CAPTURE,
		switch: { macTable: () => [], now: () => 0, ...options.switch, counters: (port) => counters.get(port) },
		terminals: options.terminals ?? { host: () => null },
	};

	const host = document.createElement("div");
	new ContextProvider(host, { context: servicesContext, initialValue: services });
	document.body.append(host);
	mountedHosts.add(host);
	const element = document.createElement(tag);
	options.prepare?.(element, services);
	host.append(element);
	const settle = () => settled(host);
	await settle();
	return { element, store, services, runs, confirms, counters, settle };
}

/** A token's colour as computed styles report it, `rgb(49, 50, 68)` for --line. */
export function tokenColor(token: string): string {
	const probe = document.createElement("span");
	probe.style.color = `var(--${token})`;
	document.body.append(probe);
	const color = getComputedStyle(probe).color;
	probe.remove();
	return color;
}

/** Removes everything `mount` added. Call it from `afterEach`. */
export function unmountAll(): void {
	for (const host of mountedHosts) host.remove();
	mountedHosts.clear();
}

async function settled(root: Element): Promise<void> {
	for (;;) {
		const pending = [root, ...root.querySelectorAll("*")].filter(
			(node): node is ReactiveElement => node instanceof ReactiveElement && node.isUpdatePending,
		);
		if (pending.length === 0) return;
		await Promise.all(pending.map((node) => node.updateComplete));
	}
}
