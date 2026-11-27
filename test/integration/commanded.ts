// A lab that command-bar lines build, on real kernels in Node: the page's store and every verb, through the
// parser that the bar and the agent tools use, with the engine's part played here. What the model asks of
// the switches goes to a fabric as the engine sends it, and a machine it boots is a kernel in its own thread.

import type { Worker } from "node:worker_threads";
import { createRegistry, type ExecPort, isLineError, parseLine, type Result, VERBS } from "../../src/commands/index.ts";
import {
	type CableCounters,
	createStore,
	type Effect,
	initialState,
	type LabState,
	type MachineName,
	machineList,
	nicMac,
	type PortRef,
	parseSessionId,
	restoreWorkspace,
	type SwitchName,
	saveWorkspace,
} from "../../src/model/index.ts";
import { defaultName, NICS, type NicNo, switchAddress } from "../../src/net/index.ts";
import { nodeClock } from "../../src/runtime/clock.ts";
import { Fabric, type TapEvent } from "../../src/runtime/fabric.ts";
import { createPump } from "../../src/runtime/pump.ts";
import { seededStreams } from "../support/conditions.ts";
import { imagePath } from "../support/images.ts";
import { startMachine, type TestMachine } from "./lab.ts";

/** A frame as a switch carried it, by the switch's name. */
export interface NamedTap extends TapEvent {
	readonly switch: SwitchName;
	/** ms since the lab was made. */
	readonly at: number;
}

/** What a line that ran answered. */
export type Ran = Exclude<Result, { kind: "failed" }>;

export interface CommandedLab {
	/** Runs a line as the bar runs it. One that cannot run, asks first or fails throws with what it said. */
	run(line: string): Promise<Ran>;
	/** Waits until every machine is ready. */
	ready(): Promise<void>;
	readonly state: LabState;
	/** Every frame that a switch accepted, in order. */
	readonly frames: readonly NamedTap[];
	/** What the cable in the port has carried and dropped. */
	carried(port: PortRef): CableCounters;
	/** The lab as the page saves it before a reload. */
	saved(): string;
	stop(): Promise<void>;
}

const IMAGES = [
	{ name: "alpine", label: "alpine" },
	{ name: "debian", label: "debian" },
	{ name: "lab", label: "lab" },
];
const READY_MS = 120_000;

/** A new lab, or the one that `saved` holds, as the page opens it after a reload. */
export async function commandLab(saved: string | null = null): Promise<CommandedLab> {
	const clock = nodeClock();
	const frames: NamedTap[] = [];
	const names: SwitchName[] = [];
	const slots = new Map<SwitchName, number>();
	const fabric = new Fabric(
		{
			tap: (slot, e) => frames.push({ ...e, switch: names[slot], at: clock.now() }),
			storm: () => {},
			tree: (slot, tree) => store.dispatchRuntime({ type: "switch/tree", switch: names[slot], tree }),
		},
		{ random: seededStreams() },
	);
	const pump = createPump(fabric, clock);
	const slotOf = (name: SwitchName): number => {
		const known = slots.get(name);
		if (known !== undefined) return known;
		const slot = fabric.addSwitch();
		slots.set(name, slot);
		names[slot] = name;
		return slot;
	};

	const workers: Worker[] = [];
	const running = new Map<MachineName, TestMachine>();
	const delivers = new Map<MachineName, (nic: NicNo, frame: Uint8Array) => void>();
	/** Where each machine's NICs are plugged in. */
	const sockets = new Map<MachineName, Map<NicNo, PortRef>>();
	const socketsOf = (machine: MachineName) => sockets.get(machine) ?? sockets.set(machine, new Map()).get(machine);

	const boot = (effect: Extract<Effect, { type: "vm/boot" }>): void => {
		const { machine, attempt, config } = effect;
		const { identity, spec, hosts } = config;
		const started = startMachine(
			{
				n: identity.n,
				name: identity.name,
				namedPrompt: identity.name !== defaultName(identity.n),
				addresses: spec.nics.map(({ address }) => address),
				macs: NICS.slice(0, spec.nics.length).map((nic) => nicMac(identity.n, nic)),
				distro: imagePath(spec.image as "alpine" | "debian" | "lab"),
				hosts,
				gateway: spec.gateway ? "packages" : false,
			},
			workers,
			(nic, frame) => {
				const at = sockets.get(machine)?.get(nic);
				if (at) pump.receive(slotOf(at.switch), at.port, frame);
			},
		);
		delivers.set(machine, started.deliver);
		started.ready.then(
			(vm) => {
				running.set(machine, vm);
				store.dispatchRuntime({ type: "vm/ready", machine, attempt, bootMs: Math.round(vm.bootMs) });
			},
			(error: unknown) => store.dispatchRuntime({ type: "vm/failed", machine, attempt, reason: String(error) }),
		);
	};

	// As the engine runs them, for what a switch or a machine's kernel does. The rest is the page's own.
	const runEffect = (effect: Effect): void => {
		switch (effect.type) {
			case "vm/boot":
				boot(effect);
				return;
			case "vm/stop":
				running.delete(effect.machine);
				store.dispatchRuntime({
					type: "vm/stopped",
					machine: effect.machine,
					attempt: effect.attempt,
					clean: true,
					at: clock.now(),
				});
				return;
			case "port/attach": {
				const { machine, nic, port } = effect;
				const slot = slotOf(port.switch);
				socketsOf(machine)?.set(nic, port);
				fabric.attach(slot, port.port, { deliver: (frame) => delivers.get(machine)?.(nic, frame) });
				fabric.setLink(slot, port.port, false);
				return;
			}
			case "port/detach":
				fabric.detach(slotOf(effect.port.switch), effect.port.port);
				return;
			case "cable/attach": {
				const [a, b] = effect.ends;
				fabric.cable({ slot: slotOf(a.switch), port: a.port }, { slot: slotOf(b.switch), port: b.port });
				fabric.setLink(slotOf(a.switch), a.port, false);
				return;
			}
			case "cable/detach":
				fabric.detach(slotOf(effect.ends[0].switch), effect.ends[0].port);
				return;
			case "cable/link":
				if (!effect.cut) fabric.setLink(slotOf(effect.ends[0].switch), effect.ends[0].port, effect.up);
				break;
			case "link/set":
				fabric.setLink(slotOf(effect.port.switch), effect.port.port, effect.up);
				break;
			case "port/vlan":
				fabric.setVlan(slotOf(effect.port.switch), effect.port.port, effect.vlan);
				return;
			case "port/conditions":
				fabric.setConditions(slotOf(effect.port.switch), effect.port.port, effect.conditions);
				return;
			case "switch/stp":
				fabric.setTree(slotOf(effect.switch), effect.on ? { address: switchAddress(effect.switch) } : null);
				break;
			case "switch/priority":
				fabric.setPriority(slotOf(effect.switch), effect.priority);
				break;
			case "port/cost":
				fabric.setCost(slotOf(effect.port.switch), effect.port.port, effect.cost);
				break;
			default:
				return;
		}
		pump.wake();
	};

	const restored = restoreWorkspace(initialState(IMAGES, { width: 1300, height: 500 }), saved);
	const store = createStore(restored.state, runEffect);
	for (const effect of restored.effects) runEffect(effect);

	const exec: ExecPort = {
		async inject(session, line) {
			const machine = parseSessionId(session)?.machine;
			const vm = machine && running.get(machine);
			if (!vm) throw new Error(`${session} is not at a prompt.`);
			const started = performance.now();
			const { exitCode, stdout, stderr } = await vm.exec(line);
			const output = `${stdout}${stderr}`;
			const lines = output.split("\n").filter((one) => one.trim() !== "");
			return { exitCode, output, truncated: false, lastLine: lines.at(-1) ?? "", ms: performance.now() - started };
		},
	};
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: (event) => store.dispatchCommand(event),
			until: store.until,
			now: () => clock.now(),
			carried: (port) => fabric.carried(slotOf(port.switch), port.port),
			exec,
			files: { write: () => Promise.reject(new Error("This lab writes no files.")) },
		},
		VERBS,
	);
	const signal = new AbortController().signal;

	return {
		async run(line) {
			const parsed = parseLine(registry, line, store.state);
			if (isLineError(parsed)) throw new Error(`${line}: ${parsed.message}`);
			if (parsed.danger) throw new Error(`${line} asks first`);
			const result = await parsed.run({ source: "bar", signal });
			if (result.kind === "failed") throw new Error(`${line}: ${result.error.message}`);
			return result;
		},
		async ready() {
			const timeout = AbortSignal.timeout(READY_MS);
			await store.until(
				(state) => machineList(state).every(({ name, life }) => life.phase === "ready" && running.has(name)),
				timeout,
			);
		},
		get state() {
			return store.state;
		},
		frames,
		carried: (port) =>
			fabric.carried(slotOf(port.switch), port.port) ?? { delivered: 0, dropped: { loss: 0, rate: 0, mtu: 0 } },
		saved: () => saveWorkspace(store.state),
		async stop() {
			pump.stop();
			clock.stop();
			await Promise.all(workers.map((worker) => worker.terminate()));
		},
	};
}

/** The machine that has a MAC, by its name and NIC, as the capture names it. */
export function macNames(state: LabState): Map<string, string> {
	return new Map(
		machineList(state).flatMap(({ n, name, spec }) =>
			spec.nics.map((_, nic) => [nicMac(n, nic as NicNo), spec.nics.length > 1 ? `${name}:eth${nic}` : name] as const),
		),
	);
}
