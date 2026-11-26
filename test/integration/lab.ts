// Machines on switches, each in its own thread, for tests on real kernels in Node.

import { Worker } from "node:worker_threads";
import type { CableCounters, ConditionValues, PortNo, PortVlan } from "../../src/model/index.ts";
import { address } from "../../src/model/testkit.ts";
import { addressStr, defaultAddress, ip4str, macStr, NICS, type NicNo, nodeMac } from "../../src/net/index.ts";
import { nodeClock } from "../../src/runtime/clock.ts";
import { Fabric, type MacEntry, type StormReading, type TapEvent } from "../../src/runtime/fabric.ts";
import type { LinkTarget } from "../../src/runtime/machine-link.ts";
import { createPump } from "../../src/runtime/pump.ts";
import { conditions, seededStreams } from "../support/conditions.ts";
import { imagePath } from "../support/images.ts";
import type { ExecDone, FromMachine, MachineData, ToMachine } from "./vm-worker.ts";

export interface MachineSetup {
	readonly n: number;
	/** A name someone chose. Left out, node<n>. */
	readonly name?: string;
	/** The port each NIC is plugged into, eth0 first. Null leaves it unplugged. */
	readonly ports: readonly (PortNo | null)[];
	/** The switch that those ports are of, by its number. Left out, the first. */
	readonly on?: number;
	/** Each NIC's address, or null for none. Left out, the lab's own choice. */
	readonly addr?: readonly (string | null)[];
	readonly distro?: "alpine" | "debian" | "lab";
	/** `packages` is the app's own gateway, which reaches only the package repositories. */
	readonly gateway?: boolean | "packages";
}

export interface TestMachine {
	readonly name: string;
	/** How long it took to be set up, kernel included. */
	readonly bootMs: number;
	readonly macs: readonly string[];
	/** Run a shell script as root. */
	exec(cmd: string): Promise<ExecDone>;
	/** Run one that must succeed, and return what it printed. */
	run(cmd: string): Promise<string>;
	/** Type into the console. */
	type(data: string): void;
	/** What the console has printed, without escape sequences. */
	console(): string;
	/** What the machine said when a NIC went away. */
	readonly lost: readonly string[];
	/** Link it with a CLI as the page would, or unlink it. */
	link(target: LinkTarget | null): void;
	/** Put a frame on one of its NICs, as the switch would. */
	deliver(nic: NicNo, frame: Uint8Array): void;
}

/** One switch of the lab's, by its ports. */
export interface TestSwitch {
	setLink(port: PortNo, up: boolean): void;
	/** What the port carries from now on. */
	setVlan(port: PortNo, vlan: PortVlan): void;
	/** How the cable in the port treats frames from now on. One between switches is told at both its ports, as the lab does. */
	setConditions(port: PortNo, values: ConditionValues): void;
	/** What the cable in the port has carried and dropped. */
	carried(port: PortNo): CableCounters;
	macTable(): readonly MacEntry[];
	/** What it has dropped at its cables to other switches, which were full. */
	readonly dropped: number;
	/** Its storm now, or null. */
	storm(): StormReading | null;
}

/** A frame as one of the switches carried it. */
export interface SwitchedTap extends TapEvent {
	/** The number of the switch. */
	readonly switch: number;
	/** ms since the lab was made. */
	readonly at: number;
}

export interface TestLab {
	/** The first switch. */
	readonly sw: TestSwitch;
	readonly switches: readonly TestSwitch[];
	/** Every frame that a switch accepted, in order. */
	readonly frames: SwitchedTap[];
	/** Each storm that began or ended, in order. */
	readonly storms: { readonly switch: number; readonly over: boolean; readonly at: number }[];
	readonly machines: readonly TestMachine[];
	/** ms since the lab was made, on the clock that its frames are stamped with. */
	now(): number;
	stop(): Promise<void>;
}

/** A cable between two switches: the number and the port of each. One that is cut is there, and carries nothing. */
export type TestCable = readonly [number, PortNo, number, PortNo, "cut"?];

export interface Wiring {
	/** How many switches. Left out, one. */
	readonly switches?: number;
	readonly cables?: readonly TestCable[];
}

export async function bootLab(setups: readonly MachineSetup[], wiring: Wiring = {}): Promise<TestLab> {
	const clock = nodeClock();
	const frames: SwitchedTap[] = [];
	const storms: TestLab["storms"] = [];
	// What a cable loses and reorders is the same from run to run.
	const fabric = new Fabric(
		{
			tap: (slot, e) => frames.push({ ...e, switch: slot, at: clock.now() }),
			storm: (slot, _reading, over) => storms.push({ switch: slot, over, at: clock.now() }),
		},
		{ random: seededStreams() },
	);
	const pump = createPump(fabric, clock);
	const switches = Array.from({ length: wiring.switches ?? 1 }, (): TestSwitch => {
		const slot = fabric.addSwitch();
		return {
			setLink: (port, up) => fabric.setLink(slot, port, up),
			setVlan: (port, vlan) => fabric.setVlan(slot, port, vlan),
			setConditions(port, values) {
				const far = fabric.farEnd(slot, port);
				fabric.setConditions(slot, port, conditions(values));
				if (far) fabric.setConditions(far.slot, far.port, conditions(values));
			},
			carried: (port) => fabric.carried(slot, port) ?? { delivered: 0, dropped: { loss: 0, rate: 0, mtu: 0 } },
			macTable: () => fabric.macTable(slot, clock.now()),
			get dropped() {
				return fabric.totals(slot).dropped;
			},
			storm: () => fabric.storm(slot, clock.now()),
		};
	});
	for (const [a, portA, b, portB, cut] of wiring.cables ?? []) {
		fabric.cable({ slot: a, port: portA }, { slot: b, port: portB });
		if (cut) fabric.setLink(a, portA, false);
	}
	const workers: Worker[] = [];
	const stop = async () => {
		pump.stop();
		clock.stop();
		await Promise.all(workers.map((worker) => worker.terminate()));
	};
	const addressesOf = ({ n, ports, addr }: MachineSetup) =>
		(addr ?? ports.map((_, nic) => (nic === 0 ? addressStr(defaultAddress(n)) : null))).map((text) =>
			text === null ? null : address(text),
		);
	const nameOf = ({ n, name = `node${n}` }: MachineSetup) => name;
	const hosts = setups.flatMap((setup) => {
		const first = addressesOf(setup).find((a) => a !== null);
		return first ? [{ ip: ip4str(first.ip), name: nameOf(setup) }] : [];
	});

	const boot = async (setup: MachineSetup): Promise<TestMachine> => {
		const data: MachineData = {
			n: setup.n,
			name: nameOf(setup),
			namedPrompt: setup.name !== undefined,
			addresses: addressesOf(setup),
			macs: NICS.slice(0, setup.ports.length).map((nic) => macStr(nodeMac(setup.n, nic))),
			distro: imagePath(setup.distro ?? "alpine"),
			hosts,
			gateway: setup.gateway ?? false,
		};
		const worker = new Worker(new URL("./vm-worker.ts", import.meta.url), { workerData: data });
		workers.push(worker);
		const post = (message: ToMachine, transfer: ArrayBuffer[] = []) => worker.postMessage(message, transfer);
		const deliver = (nic: NicNo, frame: Uint8Array) => {
			// The switch shares a flooded frame with every port.
			const copy = new Uint8Array(frame);
			post({ type: "frame", nic, frame: copy }, [copy.buffer]);
		};
		const slot = setup.on ?? 0;
		for (const nic of NICS) {
			const port = setup.ports[nic];
			if (port) fabric.attach(slot, port, { deliver: (frame) => deliver(nic, frame) });
		}

		const startedAt = performance.now();
		const pending = new Map<number, (result: ExecDone) => void>();
		const lost: string[] = [];
		let printed = "";
		await new Promise<void>((resolve, reject) => {
			worker.on("error", reject);
			worker.on("message", (m: FromMachine) => {
				switch (m.type) {
					case "ready":
						resolve();
						return;
					case "failed":
						reject(new Error(`${data.name}: ${m.reason}`));
						return;
					case "lost":
						lost.push(m.reason);
						return;
					case "console":
						printed += m.text;
						return;
					case "ran":
						pending.get(m.id)?.(m.result);
						pending.delete(m.id);
						return;
					case "frame": {
						const port = setup.ports[m.nic];
						if (port) pump.receive(slot, port, m.frame);
						return;
					}
				}
			});
		});

		const bootMs = performance.now() - startedAt;
		let calls = 0;
		const exec = (cmd: string) =>
			new Promise<ExecDone>((resolve) => {
				const id = ++calls;
				pending.set(id, resolve);
				post({ type: "exec", id, cmd });
			});
		return {
			name: data.name,
			bootMs,
			macs: data.macs,
			exec,
			async run(cmd) {
				const done = await exec(cmd);
				if (done.exitCode !== 0) {
					throw new Error(`${data.name}: ${cmd}: exit ${done.exitCode}\n${done.stdout}${done.stderr}`);
				}
				return done.stdout;
			},
			type: (data) => post({ type: "input", data }),
			// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with one.
			console: () => printed.replace(/\x1b(?:\][^\x07]*\x07|\[[\d;?]*[a-zA-Z])/g, ""),
			lost,
			link: (target) => post({ type: "link", target }),
			deliver,
		};
	};

	try {
		const machines = await Promise.all(setups.map(boot));
		return { sw: switches[0], switches, frames, storms, machines, now: () => clock.now(), stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
