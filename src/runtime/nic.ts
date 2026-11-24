// eth0: a kwnet NetDevice, so the guest kernel drives it as ordinary hardware.
// Frames the guest sends arrive in send(), and frames handed to deliver()
// arrive in the guest.
//
// Two things sit on this one cable, as if a small hub joined them:
//   * the switch, and so the other machines: their own stacks talk to each
//     other, nothing emulated in between;
//   * the package gateway, a NetStack that owns 10.0.2.0/24 and serves DHCP,
//     DNS and the package repositories. Only this machine can see it.

import type { Kernel, NetDevice } from "unkernel";
import { arpAddrs, ipAddrs, isDhcpRequest, isGroupMac, macStr, parseMac } from "../net/index.ts";

/** The NetStack, as much of it as tells which frames are its own. */
export interface Gateway extends NetDevice {
	readonly gwMac: Uint8Array;
	readonly net: number;
	readonly mask: number;
}

export interface LabNicOptions {
	/** This NIC's MAC; the gateway must be told the same one. */
	mac: string;
	/** Put a frame on the cable to the switch. Must not retain the array. */
	toSwitch: (frame: Uint8Array) => void;
	/** The package gateway, when enabled at boot. */
	gateway?: Gateway;
}

/**
 * Whether a frame is for the gateway rather than the switch. A frame is
 * addressed by its MAC, whatever IP addresses it carries: a guest reaches any
 * subnet through another machine by sending to that machine's MAC.
 */
export function isForGateway(f: Uint8Array, gateway: Gateway): boolean {
	if (!isGroupMac(f)) return macStr(f) === macStr(gateway.gwMac);
	const asked = arpAddrs(f)?.tpa ?? ipAddrs(f)?.dst;
	return isDhcpRequest(f) || (asked !== undefined && (asked & gateway.mask) >>> 0 === gateway.net);
}

export class LabNic implements NetDevice {
	readonly mac: Uint8Array;
	readonly #toSwitch: (frame: Uint8Array) => void;
	readonly #gateway?: Gateway;
	#kernel: Kernel | undefined;

	constructor(opts: LabNicOptions) {
		this.mac = parseMac(opts.mac);
		this.#toSwitch = opts.toSwitch;
		this.#gateway = opts.gateway;
	}

	/** The guest's driver came up. The gateway writes into the same NIC. */
	attach(kernel: Kernel): void {
		this.#kernel = kernel;
		this.#gateway?.attach?.(kernel);
	}

	/** A frame from the guest. */
	send(frame: Uint8Array): void {
		if (this.#gateway && isForGateway(frame, this.#gateway)) {
			this.#gateway.send(frame);
			return;
		}
		// The array may be a view into wasm memory that is reused as soon as we
		// return, and posting a view would clone the whole heap, so hand on a
		// right-sized copy.
		this.#toSwitch(frame.slice());
	}

	/** A frame from the switch, into the guest. A NIC whose driver is not up yet drops it. */
	deliver(frame: Uint8Array): void {
		this.#kernel?.receiveFrame(frame);
	}

	close(): void {
		this.#gateway?.close?.();
		this.#kernel = undefined;
	}
}
