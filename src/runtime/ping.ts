// Echo requests to the internet, through the CLI. unkernel's gateway answers
// those for its own two addresses and drops the rest, as it has no way to
// send them. While a CLI is linked, this one sends them on: the CLI pings the
// address from its computer, and the reply is made here from the request, with
// the far end's TTL, once the far end has answered. So the time a guest sees is
// the far end's, and the CLI's own on top.

import type { Kernel } from "unkernel";
import { ethertype, ip4str, ipAddrs } from "../net/index.ts";
import type { Gateway } from "./nic.ts";

const ETH_IPV4 = 0x0800;
const ICMP = 1;
const ECHO_REQUEST = 8;
const ECHO_REPLY = 0;
const ETH = 14;
/** Echoes that wait for an answer at once. More are dropped, as a busy link drops them. */
const IN_FLIGHT = 16;

export interface Echoed {
	/** The far end's TTL as it arrived. */
	readonly ttl: number;
}

/** Sends one echo to an address and resolves when it is answered, or with null when it is not. Null itself when there is no CLI. */
export type Pinger = (address: string) => Promise<Echoed | null> | null;

function checksum(bytes: Uint8Array, from: number, to: number): number {
	let sum = 0;
	for (let i = from; i < to; i += 2) sum += (bytes[i] << 8) | (i + 1 < to ? bytes[i + 1] : 0);
	while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
	return ~sum & 0xffff;
}

/** The address an echo request is for, when the frame is one. */
export function echoRequest(frame: Uint8Array): number | null {
	if (ethertype(frame) !== ETH_IPV4) return null;
	const ip = ipAddrs(frame);
	if (!ip || ip.proto !== ICMP || frame.length < ETH + ip.ihl + 8) return null;
	return frame[ETH + ip.ihl] === ECHO_REQUEST ? ip.dst : null;
}

/** The reply to an echo request, as from the address it was for, through the gateway's MAC. */
export function echoReply(request: Uint8Array, gatewayMac: Uint8Array, ttl: number): Uint8Array {
	const ip = ipAddrs(request);
	if (!ip) throw new Error("not an IPv4 frame");
	const total = new DataView(request.buffer, request.byteOffset).getUint16(ETH + 2);
	const reply = request.slice(0, ETH + total);
	const view = new DataView(reply.buffer);
	reply.set(request.subarray(6, 12), 0);
	reply.set(gatewayMac, 6);
	reply[ETH + 8] = ttl;
	view.setUint32(ETH + 12, ip.dst);
	view.setUint32(ETH + 16, ip.src);
	view.setUint16(ETH + 10, 0);
	view.setUint16(ETH + 10, checksum(reply, ETH, ETH + ip.ihl));
	const icmp = ETH + ip.ihl;
	reply[icmp] = ECHO_REPLY;
	view.setUint16(icmp + 2, 0);
	view.setUint16(icmp + 2, checksum(reply, icmp, ETH + total));
	return reply;
}

/** The package gateway, with echoes to the internet sent on while there is a CLI. */
export class PingingGateway implements Gateway {
	readonly #inner: Gateway;
	readonly #ping: Pinger;
	#kernel: Kernel | undefined;
	#waiting = 0;

	constructor(inner: Gateway, ping: Pinger) {
		this.#inner = inner;
		this.#ping = ping;
	}

	get gwMac(): Uint8Array {
		return this.#inner.gwMac;
	}

	get net(): number {
		return this.#inner.net;
	}

	get mask(): number {
		return this.#inner.mask;
	}

	attach(kernel: Kernel): void {
		this.#kernel = kernel;
		this.#inner.attach?.(kernel);
	}

	send(frame: Uint8Array): void {
		const to = echoRequest(frame);
		// The gateway's own addresses it answers itself.
		if (to === null || (to & this.mask) >>> 0 === this.net) {
			this.#inner.send(frame);
			return;
		}
		if (this.#waiting >= IN_FLIGHT) return;
		const answered = this.#ping(ip4str(to));
		if (!answered) {
			this.#inner.send(frame);
			return;
		}
		const request = frame.slice();
		this.#waiting++;
		void answered
			.catch(() => null)
			.then((echoed) => {
				this.#waiting--;
				if (echoed) this.#kernel?.receiveFrame(echoReply(request, this.gwMac, echoed.ttl));
			});
	}

	close(): void {
		this.#inner.close?.();
	}
}
