// One machine, in its own thread: the browser worker's NICs and setup, on Node's kernel.
import { parentPort, workerData } from "node:worker_threads";
import { createKernel, directBackend, NetStack } from "unkernel/node";
import type { Address, HostEntry } from "../../src/model/types.ts";
import type { NicNo } from "../../src/net/index.ts";
import { execAsRoot, setupScript } from "../../src/runtime/guest.ts";
import { MachineNics } from "../../src/runtime/machine-nics.ts";
import { alpinePackageSetup, packageBackend } from "../../src/runtime/package-repositories.ts";

export interface MachineData {
	readonly name: string;
	readonly addresses: readonly (Address | null)[];
	readonly image: "alpine" | "debian";
	readonly macs: readonly string[];
	readonly distro: string;
	readonly hosts: readonly HostEntry[];
	/** Whether eth0 reaches the internet through a gateway, or only the package repositories, as the app's does. */
	readonly gateway: boolean | "packages";
}

export type ToMachine =
	| { readonly type: "frame"; readonly nic: NicNo; readonly frame: Uint8Array }
	| { readonly type: "exec"; readonly id: number; readonly cmd: string };

export interface ExecDone {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type FromMachine =
	| { readonly type: "frame"; readonly nic: NicNo; readonly frame: Uint8Array }
	| { readonly type: "ready" }
	| { readonly type: "failed"; readonly reason: string }
	| { readonly type: "lost"; readonly reason: string }
	| { readonly type: "ran"; readonly id: number; readonly result: ExecDone };

const port = parentPort;
if (!port) throw new Error("not a worker");
const say = (message: FromMachine, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);

const data: MachineData = workerData;
const backend = data.gateway === "packages" ? packageBackend() : directBackend();
const gateway = data.gateway ? new NetStack({ mac: data.macs[0], backend }) : undefined;
const nics = new MachineNics({
	macs: data.macs,
	gateway,
	toSwitch: (nic, frame) => say({ type: "frame", nic, frame }, [frame.buffer as ArrayBuffer]),
	lost: (reason) => say({ type: "lost", reason }),
});

try {
	const vm = await createKernel({ distro: data.distro, net: nics.eth0, memoryMiB: 256, log: () => {} });
	const running = vm.exited.then(
		({ reason, code }) => say({ type: "failed", reason: reason ?? `exit ${code}` }),
		(error: unknown) => say({ type: "failed", reason: String(error) }),
	);
	void running;
	await nics.start(vm);
	const script = setupScript({
		hostname: data.name,
		addresses: data.addresses,
		hosts: data.hosts,
		gateway: data.gateway !== false,
		promptToken: "0123456789abcdef",
	});
	const prepareApk = data.gateway === "packages" && data.image === "alpine";
	const setup = await execAsRoot(vm, prepareApk ? `${alpinePackageSetup}\n${script}` : script);
	if (setup.exitCode !== 0) throw new Error(`setup: ${setup.stderr}`);

	port.on("message", (m: ToMachine) => {
		if (m.type === "frame") {
			nics.deliver(m.nic, m.frame);
			return;
		}
		execAsRoot(vm, m.cmd).then(
			({ exitCode, stdout, stderr }) => say({ type: "ran", id: m.id, result: { exitCode, stdout, stderr } }),
			(error: unknown) => say({ type: "ran", id: m.id, result: { exitCode: null, stdout: "", stderr: String(error) } }),
		);
	});
	say({ type: "ready" });
} catch (error) {
	say({ type: "failed", reason: error instanceof Error ? error.message : String(error) });
}
