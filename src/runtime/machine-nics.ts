// Every NIC of one machine, as its kernel sees them. eth0 is the kernel's own
// network device; the rest are TAP devices. The browser's worker and the Node
// tests share this, so what one proves holds for the other.

import type { KernelHandle } from "unkernel";
import { NICS, type NicNo, nicName } from "../net/index.ts";
import { type Gateway, LabNic } from "./nic.ts";
import { NIC_HELPER } from "./nic-helper.ts";
import { NIC_HELPER_PATH, openTap, type Tap } from "./tap.ts";

export interface MachineNicsOptions {
	/** One MAC for each NIC, eth0 first. */
	readonly macs: readonly string[];
	/** The package gateway, on eth0 alone. */
	readonly gateway?: Gateway;
	/** A frame a NIC sent, in a buffer of its own. */
	readonly toSwitch: (nic: NicNo, frame: Uint8Array) => void;
	/** A NIC went away in a running guest. One sentence. */
	readonly lost: (reason: string) => void;
}

export class MachineNics {
	/** Pass it to the kernel as its network device. */
	readonly eth0: LabNic;
	readonly #opts: MachineNicsOptions;
	readonly #taps = new Map<NicNo, Tap>();

	constructor(opts: MachineNicsOptions) {
		this.#opts = opts;
		this.eth0 = new LabNic({
			mac: opts.macs[0],
			gateway: opts.gateway,
			toSwitch: (frame) => opts.toSwitch(0, frame),
		});
	}

	/**
	 * Adds the NICs past eth0 to the guest, before anything in it looks for
	 * them. eth0 stops offloading at the same time: it would send segments
	 * larger than the wire takes, with no checksum, and a guest that routes
	 * them onto a TAP device, or receives them from one, drops them.
	 */
	async start(vm: Pick<KernelHandle, "exec" | "spawn">): Promise<void> {
		const install = `cat > ${NIC_HELPER_PATH} && chmod 755 ${NIC_HELPER_PATH} && ${NIC_HELPER_PATH} plain eth0`;
		const installed = await vm.exec("/bin/sh", ["-c", install], { user: "root", input: NIC_HELPER });
		if (installed.exitCode !== 0) {
			throw new Error(`eth0: ${installed.stderr.trim() || `exit ${installed.exitCode}`}`);
		}
		await Promise.all(
			NICS.slice(1, this.#opts.macs.length).map(async (nic) => {
				const tap = await openTap(vm, {
					name: nicName(nic),
					mac: this.#opts.macs[nic],
					toSwitch: (frame) => this.#opts.toSwitch(nic, frame),
					lost: this.#opts.lost,
				});
				this.#taps.set(nic, tap);
			}),
		);
	}

	/** A frame from the switch, into the guest. Dropped when the guest has no such NIC yet. */
	deliver(nic: NicNo, frame: Uint8Array): void {
		if (nic === 0) this.eth0.deliver(frame);
		else this.#taps.get(nic)?.deliver(frame);
	}
}
