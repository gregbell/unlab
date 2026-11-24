// Machines on a switch, each in its own thread, for tests on real kernels in Node.
import { Worker } from "node:worker_threads";
import { fetchDistro } from "unkernel/node";
import type { PortNo } from "../../src/model/types.ts";
import { ip4str, macStr, NICS, type NicNo, nodeIp, nodeMac } from "../../src/net/index.ts";
import { LabSwitch, type TapEvent } from "../../src/runtime/switch.ts";
import type { ExecDone, FromMachine, MachineData, ToMachine } from "./vm-worker.ts";

export interface MachineSetup {
	readonly n: number;
	/** The port each NIC is plugged into, eth0 first. Null leaves it unplugged. */
	readonly ports: readonly (PortNo | null)[];
	readonly distro?: "alpine" | "debian";
	readonly gateway?: boolean;
}

export interface TestMachine {
	readonly name: string;
	readonly ip: string;
	readonly macs: readonly string[];
	/** Run a shell script as root. */
	exec(cmd: string): Promise<ExecDone>;
	/** Run one that must succeed, and return what it printed. */
	run(cmd: string): Promise<string>;
	/** What the machine said when a NIC went away. */
	readonly lost: readonly string[];
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
	const hosts = setups.map(({ n }) => ({ ip: ip4str(nodeIp(n)), name: `node${n}` }));

	const boot = async (setup: MachineSetup): Promise<TestMachine> => {
		const data: MachineData = {
			name: `node${setup.n}`,
			ip: ip4str(nodeIp(setup.n)),
			macs: NICS.slice(0, setup.ports.length).map((nic) => macStr(nodeMac(setup.n, nic))),
			distro: await fetchDistro(setup.distro ?? "alpine"),
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

		const pending = new Map<number, (result: ExecDone) => void>();
		const lost: string[] = [];
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

		let calls = 0;
		const exec = (cmd: string) =>
			new Promise<ExecDone>((resolve) => {
				const id = ++calls;
				pending.set(id, resolve);
				post({ type: "exec", id, cmd });
			});
		return {
			name: data.name,
			ip: data.ip,
			macs: data.macs,
			exec,
			async run(cmd) {
				const done = await exec(cmd);
				if (done.exitCode !== 0) {
					throw new Error(`${data.name}: ${cmd}: exit ${done.exitCode}\n${done.stdout}${done.stderr}`);
				}
				return done.stdout;
			},
			lost,
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
