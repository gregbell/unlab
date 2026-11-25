// Machines on a switch, each in its own thread, for tests on real kernels in Node.

import { Worker } from "node:worker_threads";
import { address } from "../../src/model/testkit.ts";
import type { PortNo } from "../../src/model/types.ts";
import { addressStr, defaultAddress, ip4str, macStr, NICS, type NicNo, nodeMac } from "../../src/net/index.ts";
import type { LinkTarget } from "../../src/runtime/machine-link.ts";
import { LabSwitch, type TapEvent } from "../../src/runtime/switch.ts";
import { imagePath } from "../support/images.ts";
import type { ExecDone, FromMachine, MachineData, ToMachine } from "./vm-worker.ts";

export interface MachineSetup {
	readonly n: number;
	/** A name someone chose. Left out, node<n>. */
	readonly name?: string;
	/** The port each NIC is plugged into, eth0 first. Null leaves it unplugged. */
	readonly ports: readonly (PortNo | null)[];
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

export interface TestLab {
	readonly sw: LabSwitch;
	/** Every frame the switch accepted, in order. */
	readonly frames: TapEvent[];
	readonly machines: readonly TestMachine[];
	stop(): Promise<void>;
}

export async function bootLab(setups: readonly MachineSetup[]): Promise<TestLab> {
	const sw = new LabSwitch();
	const frames: TapEvent[] = [];
	sw.onTap((e) => frames.push(e));
	const workers: Worker[] = [];
	const stop = async () => {
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
		for (const nic of NICS) {
			const port = setup.ports[nic];
			if (port) sw.attach(port, { deliver: (frame) => deliver(nic, frame) });
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
						if (port) sw.receive(port, m.frame);
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
		return { sw, frames, machines: await Promise.all(setups.map(boot)), stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
