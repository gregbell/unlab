// For component tests only: mounts an element under a services provider whose
// store is the real one, so a test drives it with the same events the app does.

import "../styles/index.css";
import { ContextProvider } from "@lit/context";
import { ReactiveElement } from "lit";
import type { CaptureView } from "../../capture/index.ts";
import { completeLine, createRegistry, parseLine, type Registry, VERBS } from "../../commands/index.ts";
import {
	type AgentCall,
	type AgentEvent,
	type CommandEvent,
	createStore,
	DEFAULT_POLICIES,
	DEFAULT_SWITCH,
	type Effect,
	initialState,
	isNameFault,
	isPlanError,
	type LabEvent,
	type LabState,
	MAX_NAME,
	type MachineName,
	type Next,
	type NicRef,
	type NicRequest,
	type NicSpec,
	type PortNo,
	parseChosenName,
	parseSwitchName,
	planLink,
	planSpawn,
	type Source,
	type Store,
	type SwitchName,
	update,
	type WebMcp,
} from "../../model/index.ts";
import { isAddressFault, parseAddress } from "../../net/index.ts";
import type { AgentService, AppServices, SwitchReadout, TerminalService } from "../services.ts";
import { servicesContext } from "./context.ts";

const TEST_IMAGES = [{ name: "alpine", label: "alpine 3.24" }] as const;

/** One step in building a lab: an event, or events made from the state so far. */
export type Step = LabEvent | ((state: LabState) => readonly LabEvent[]);

/** A lab built the way the app builds one, in a browser that took the tools: every step goes through `update`. */
export function lab(...steps: readonly Step[]): LabState {
	return [webmcp({ kind: "registered" }), ...steps].reduce<LabState>(
		(state, step) => {
			const events = typeof step === "function" ? step(state) : [step];
			return events.reduce((next, event) => update(next, event).state, state);
		},
		initialState(TEST_IMAGES, { width: 1300, height: 500 }),
	);
}

export const spawn =
	(count: number, ...nets: readonly NicSpec["net"][]): Step =>
	(state) => {
		const nics = (nets.length > 0 ? nets : [DEFAULT_SWITCH]).map(
			(net, nic): NicRequest => ({ net, address: nic === 0 ? "default" : null }),
		);
		const plan = planSpawn(state, count, {
			image: "alpine",
			memMiB: 256,
			disks: { root: "4", extra: [] },
			gateway: nics[0].net !== "none",
			nics,
		});
		if (isPlanError(plan)) throw new Error(`cannot spawn ${count}: ${plan.kind}`);
		return [{ type: "cmd/spawn", plan, at: state.now }];
	};

/** One machine, with each NIC on switch0 at the address given or with none. */
export const spawnAt =
	(...addresses: readonly (string | null)[]): Step =>
	(state) => {
		const nics = addresses.map((text): NicRequest => {
			const address = text === null ? null : parseAddress(text);
			if (address && isAddressFault(address)) throw new Error(`${text}: ${address.kind}`);
			return { net: DEFAULT_SWITCH, address };
		});
		const plan = planSpawn(state, 1, {
			image: "alpine",
			memMiB: 256,
			disks: { root: "4", extra: [] },
			gateway: true,
			nics,
		});
		if (isPlanError(plan)) throw new Error(`cannot spawn: ${plan.kind}`);
		return [{ type: "cmd/spawn", plan, at: state.now }];
	};

/** As long as a name can be. */
export const LONG_NAME = named(`a-very-long-name-${"x".repeat(MAX_NAME - 19)}-z`);

export function named(text: string): MachineName {
	const name = parseChosenName(text);
	if (isNameFault(name)) throw new Error(`${text}: ${name.kind}`);
	return name;
}

/** One machine with the name, plugged in. */
export const spawnNamed =
	(name: MachineName) =>
	(state: LabState): readonly CommandEvent[] => {
		const nics: NicRequest[] = [{ net: DEFAULT_SWITCH, address: "default" }];
		const plan = planSpawn(state, 1, {
			image: "alpine",
			memMiB: 256,
			disks: { root: "4", extra: [] },
			gateway: true,
			nics,
			name,
		});
		if (isPlanError(plan)) throw new Error(`cannot spawn ${name}: ${plan.kind}`);
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

/** The machines are stopped, for what comes next. */
export const power = (next: Next, ...machines: readonly MachineName[]): LabEvent => ({
	type: "cmd/power",
	machines,
	next,
});

/** The named machines' workers are gone. */
export const stopped =
	(machine: MachineName, clean = true): Step =>
	(state) => [
		{ type: "vm/stopped", machine, attempt: state.machines[machine]?.life.attempt ?? 1, clean, at: state.now },
	];

export const link =
	(direction: "up" | "down", ...cables: readonly (MachineName | NicRef)[]): Step =>
	(state) => {
		const changes = planLink(state, cables, direction === "up");
		if (isPlanError(changes)) throw new Error(`cannot link ${direction}: ${changes.kind}`);
		return [{ type: "cmd/link", changes, cause: "bar" }];
	};

export function switchNamed(text: string): SwitchName {
	const name = parseSwitchName(text);
	if (isNameFault(name)) throw new Error(`${text}: ${name.kind}`);
	return name;
}

export const addSwitch = (name: SwitchName): LabEvent => ({ type: "cmd/switch-add", plan: { name } });
export const removeSwitch = (name: SwitchName): LabEvent => ({ type: "cmd/switch-remove", switch: name, cause: "bar" });

export const focus = (target: MachineName): LabEvent => ({ type: "cmd/focus", target, mode: "plain" });
export const remove = (...machines: readonly MachineName[]): LabEvent => ({
	type: "cmd/remove",
	machines,
	cause: "bar",
});
export const park = (machine: MachineName): LabEvent => ({ type: "ui/park", machine });
export const webmcp = (webmcp: WebMcp): AgentEvent => ({ type: "agent/webmcp", webmcp });
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
	/** Every answer given through `services.agent.answer`, in order. */
	readonly answers: { readonly call: number; readonly allow: boolean }[];
	/** What `services.switch.counters` answers for the default switch's ports. */
	readonly counters: Map<PortNo, Counters>;
	/** Resolves once every element in the tree has rendered. */
	settle(): Promise<void>;
}

export interface MountOptions<E extends HTMLElement> {
	/** The state to start from. Defaults to an empty lab with room for three columns and two rows. */
	readonly state?: LabState;
	/** What `services.switch.counters` answers for the default switch's ports from the start. */
	readonly counters?: Iterable<readonly [PortNo, Counters]>;
	/** Receives every effect the store emits, as the runtime would. */
	readonly onEffect?: (effect: Effect) => void;
	/** The capture the element reads. Defaults to an empty one that never changes. */
	readonly capture?: CaptureView;
	/** The switch's MAC table and clock. Defaults to an empty table at time 0; `counters` still applies. */
	readonly switch?: Partial<Pick<SwitchReadout, "macTable" | "totals" | "now">>;
	/** The terminal screens. Defaults to none: every `host` is null. */
	readonly terminals?: TerminalService;
	/** What `services.agent.tryCall` is. Defaults to null, as where a page cannot call tools. */
	readonly tryCall?: AgentService["tryCall"];
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
	const answers: Mounted<HTMLElement>["answers"] = [];
	const counters = new Map<PortNo, Counters>(options.counters);
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: () => {},
			until: (predicate, signal) => store.until(predicate, signal),
			now: () => store.state.now,
			exec: { inject: () => Promise.reject(new Error("This fixture has no runtime.")) },
			files: { write: () => Promise.reject(new Error("This fixture has no runtime.")) },
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
		switch: {
			macTable: () => [],
			totals: () => ({ in: 0, delivered: 0, flooded: 0 }),
			now: () => 0,
			...options.switch,
			counters: ({ switch: on, port }) => (on === DEFAULT_SWITCH ? counters.get(port) : undefined),
		},
		terminals: options.terminals ?? { host: () => null },
		agent: {
			tools: toolRows(registry),
			answer: (call, allow) => {
				answers.push({ call, allow });
			},
			tryCall: options.tryCall ?? null,
		},
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
	return { element, store, services, runs, confirms, answers, counters, settle };
}

/** The tool list the agent layer derives, rebuilt here because ui may not import agent. */
function toolRows(registry: Registry): AgentService["tools"] {
	const order = Object.keys(DEFAULT_POLICIES);
	const verbs = registry.commands.flatMap(({ tool }) =>
		tool ? [{ name: tool.name, args: Object.keys(tool.inputSchema.properties ?? {}) }] : [],
	);
	return [
		...verbs,
		{ name: "shell_read" as const, args: ["machine", "lines"] },
		{ name: "capture_read" as const, args: ["filter", "limit"] },
	].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
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
