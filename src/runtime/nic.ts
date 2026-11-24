// The virtual NIC each machine gets. It is a kwnet NetDevice, so the guest
// kernel drives it as ordinary hardware: frames the guest sends arrive in
// send(), and frames we hand to receiveFrame() arrive in the guest.
//
// Two destinations share the one NIC:
//   * the lab segment (10.88.0.0/24)  -> bridged at layer 2 to the other
//     machines, so ARP, ICMP, UDP and TCP between them are the guests' own
//     stacks talking to each other, nothing emulated in between;
//   * everything else                 -> the uplink, a NetStack that owns
//     10.0.2.0/24 and serves DHCP, DNS and the package repositories.

import type { Kernel, NetDevice } from "unkernel";
import { classify, parseMac, type Subnet } from "../net/index.ts";

export interface LabNicOptions {
	/** This machine's MAC; the uplink must be told the same one. */
	mac: string;
	lab: Subnet;
	/** Put a frame on the lab segment. Must not retain the array. */
	toSwitch: (frame: Uint8Array) => void;
	/** The package gateway, when enabled at boot. */
	uplink?: NetDevice;
}

export interface NicCounters {
	labTx: number;
	labRx: number;
	uplinkTx: number;
	dropped: number;
}

export class LabNic implements NetDevice {
	readonly mac: Uint8Array;
	readonly counters: NicCounters = { labTx: 0, labRx: 0, uplinkTx: 0, dropped: 0 };
	readonly #lab: Subnet;
	readonly #toSwitch: (frame: Uint8Array) => void;
	readonly #uplink?: NetDevice;
	#kernel: Kernel | undefined;

	constructor(opts: LabNicOptions) {
		this.mac = parseMac(opts.mac);
		this.#lab = opts.lab;
		this.#toSwitch = opts.toSwitch;
		this.#uplink = opts.uplink;
	}

	/** The guest's driver came up. The uplink writes into the same NIC. */
	attach(kernel: Kernel): void {
		this.#kernel = kernel;
		this.#uplink?.attach?.(kernel);
	}

	/** A frame from the guest. */
	send(frame: Uint8Array): void {
		switch (classify(frame, this.#lab)) {
			case "lab":
				this.counters.labTx++;
				// The array may be a view into wasm memory that is reused as soon
				// as we return, and posting a view would clone the whole heap, so
				// hand on a right-sized copy.
				this.#toSwitch(frame.slice());
				return;
			case "uplink":
				if (!this.#uplink) {
					this.counters.dropped++;
					return;
				}
				this.counters.uplinkTx++;
				this.#uplink.send(frame);
				return;
			default:
				this.counters.dropped++;
		}
	}

	/** A frame from the lab segment, into the guest. */
	deliver(frame: Uint8Array): void {
		if (!this.#kernel) return;
		this.counters.labRx++;
		this.#kernel.receiveFrame(frame);
	}

	close(): void {
		this.#uplink?.close?.();
		this.#kernel = undefined;
	}
}
