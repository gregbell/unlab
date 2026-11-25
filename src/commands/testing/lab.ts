import {
	type Address,
	type CheckpointName,
	type CommandEvent,
	DEFAULT_POLICIES,
	DEFAULT_SWITCH,
	HUES,
	type ImageInfo,
	type LabState,
	type Lifecycle,
	type Machine,
	type MachineName,
	PANELS,
	type Phase,
	type Plug,
	PORTS,
	type PortRef,
	type Session,
	type SessionId,
} from "../../model/index.ts";
import { defaultAddress } from "../../net/index.ts";
import type { CommandDeps, ExecPort, FilePort } from "../define.ts";

export interface MachineFixture {
	readonly n: number;
	/** Left out, node<n>. */
	readonly name?: MachineName;
	readonly phase?: Phase;
	/** Ready, stopping and off machines only. Plugged machines sit on port n. */
	readonly link?: "up" | "cut" | "none";
	readonly shells?: number;
	/** Null for a machine with none. Left out, the lab's own choice. */
	readonly address?: Address | null;
	readonly gateway?: boolean;
}

export const IMAGES: readonly ImageInfo[] = [
	{ name: "alpine", label: "alpine 3.24" },
	{ name: "debian", label: "debian 13" },
];

function portOf(n: number): PortRef {
	return { switch: DEFAULT_SWITCH, port: PORTS[(n - 1) % PORTS.length] };
}

function plugged(f: MachineFixture, port: PortRef): Plug {
	return f.link === "none" ? { kind: "none" } : { kind: "port", port, link: f.link ?? "up" };
}

function life(f: MachineFixture): Lifecycle {
	const port = portOf(f.n);
	switch (f.phase ?? "ready") {
		case "booting":
			return { phase: "booting", attempt: 1, since: 0, stage: "kernel", plugs: [{ kind: "port", port, link: "up" }] };
		case "ready":
			return {
				phase: "ready",
				attempt: 1,
				bootMs: 3582,
				plugs: [plugged(f, port)],
			};
		case "stopping":
			return { phase: "stopping", attempt: 1, next: "off", plugs: [plugged(f, port)], linked: true, closed: [] };
		case "off":
			return { phase: "off", attempt: 1, plugs: [plugged(f, port)] };
		case "restoring":
			return {
				phase: "restoring",
				attempt: 2,
				from: { name: "before" as CheckpointName, set: 1, bytes: 0 },
				set: 2,
				percent: 0,
				plugs: [plugged(f, port)],
				closed: [],
			};
		case "failed":
			return { phase: "failed", attempt: 1, reason: "No prompt after 120 s." };
		case "removing":
			return { phase: "removing", attempt: 1, ports: [port] };
	}
}

/** A hand-built lab: one machine for each fixture, in the order given, everything else at rest. */
export function labWith(fixtures: readonly MachineFixture[], images: readonly ImageInfo[] = IMAGES): LabState {
	const machines: Partial<Record<MachineName, Machine>> = {};
	const sessions: Partial<Record<SessionId, Session>> = {};
	const rail: MachineName[] = [];
	for (const f of fixtures) {
		const name: MachineName = f.name ?? `node${f.n}`;
		const ids: SessionId[] = [`${name}:console`];
		for (let k = 1; k <= (f.shells ?? 0); k++) ids.push(`${name}:sh${k}`);
		machines[name] = {
			n: f.n,
			name,
			mac: `02:00:0a:58:00:${(10 + f.n).toString(16).padStart(2, "0")}`,
			life: life(f),
			hue: HUES[(f.n - 1) % HUES.length],
			spec: {
				image: "alpine",
				memMiB: 256,
				disks: { root: "4", extra: [] },
				gateway: f.gateway ?? true,
				nics: [{ net: DEFAULT_SWITCH, address: f.address === undefined ? defaultAddress(f.n) : f.address }],
			},
			sessions: ids,
			activeSession: ids[0],
			nextShell: (f.shells ?? 0) + 1,
			lastStop: null,
			sets: { live: 0, next: 1, checkpoints: [] },
			unsaved: null,
		};
		for (const id of ids) {
			sessions[id] = {
				id,
				machine: name,
				kind: id.endsWith(":console") ? "console" : "shell",
				state: "open",
				shell: "prompt",
				agentLines: false,
			};
		}
		rail.push(name);
	}
	return {
		cli: { kind: "off" },
		now: 0,
		nextN: Math.max(0, ...fixtures.map((f) => f.n)) + 1,
		machines,
		rail,
		departed: {},
		departedSwitches: [],
		switches: [DEFAULT_SWITCH],
		shownSwitch: DEFAULT_SWITCH,
		sessions,
		panes: { order: rail, parked: {}, focusStamp: {}, focusClock: 0, maximised: null, grid: { cols: 2, rows: 2 } },
		keyboard: { kind: "none" },
		view: "lab",
		agentPanel: false,
		panels: { open: PANELS, maximised: null },
		capture: { filter: "", paused: false, selected: null },
		agent: {
			webmcp: { kind: "absent" },
			policies: DEFAULT_POLICIES,
			paused: false,
			calls: [],
			firstCallAt: null,
			lastCallAt: null,
		},
		log: [],
		nextLogId: 1,
		images,
	};
}

/** For tests that never exec: any inject fails loudly. */
export const NO_EXEC: ExecPort = {
	inject: () => Promise.reject(new Error("This test has no exec port.")),
};

/** For tests that never write a file: any write fails loudly. */
export const NO_FILES: FilePort = {
	write: () => Promise.reject(new Error("This test has no file port.")),
};

/** Deps over a mutable lab: tests swap the state to simulate the store changing under a command. */
export function fakeDeps(initial: LabState, exec: ExecPort = NO_EXEC) {
	let state = initial;
	let clock = 1000;
	const events: CommandEvent[] = [];
	const waiters = new Set<() => void>();
	const deps: CommandDeps = {
		state: () => state,
		dispatch(event) {
			events.push(event);
		},
		until(predicate, signal) {
			return new Promise((resolve, reject) => {
				const check = () => {
					if (!predicate(state)) return;
					waiters.delete(check);
					resolve(state);
				};
				signal.addEventListener("abort", () => {
					waiters.delete(check);
					reject(signal.reason);
				});
				waiters.add(check);
				check();
			});
		},
		now: () => clock++,
		exec,
		files: NO_FILES,
	};
	return {
		deps,
		events,
		setState(next: LabState) {
			state = next;
			for (const waiter of [...waiters]) waiter();
		},
	};
}
