// The image runs a DHCP client on eth0 at boot and serves no one until the
// client has a lease or has given up, three seconds later. On a machine with no
// gateway this answers it at once, with a lease that setup takes off again, so
// the boot is not held up and nothing of it reaches the switch.

import { ETH_HDR, ETH_IPV4, IP_UDP, ipAddrs, isDhcpRequest } from "../net/index.ts";
import type { Gateway } from "./nic.ts";

/** An address no one else uses, for the moment until setup removes it. */
export const BOOT_LEASE = { address: "192.0.2.15", prefix: 24 } as const;

const NET = 0xc0000200;
const SERVER = NET + 2;
const LEASED = NET + 15;
const GW_MAC = Uint8Array.of(0x52, 0x55, 0xc0, 0, 2, 2);

const UDP = ETH_HDR + 20;
const BOOTP = UDP + 8;
const OPTIONS = BOOTP + 240;
const MESSAGE_TYPE = 53;
const DISCOVER = 1;
const OFFER = 2;
const REQUEST = 3;
const ACK = 5;

const u32 = (n: number): number[] => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function messageType(f: Uint8Array): number | null {
	for (let at = OPTIONS; at + 1 < f.length && f[at] !== 255; ) {
		if (f[at] === 0) {
			at++;
			continue;
		}
		if (f[at] === MESSAGE_TYPE) return f[at + 2] ?? null;
		at += 2 + f[at + 1];
	}
	return null;
}

function checksum(f: Uint8Array, from: number, to: number): number {
	let sum = 0;
	for (let i = from; i < to; i += 2) sum += (f[i] << 8) | f[i + 1];
	while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
	return ~sum & 0xffff;
}

/** The answer to a DHCP client: the lease with no router and no DNS, so it changes nothing else in the guest. */
function reply(request: Uint8Array, type: number): Uint8Array {
	const f = new Uint8Array(OPTIONS + 32);
	const view = new DataView(f.buffer);
	f.set(request.subarray(6, 12), 0);
	f.set(GW_MAC, 6);
	view.setUint16(12, ETH_IPV4);
	f.set([0x45, 0], ETH_HDR);
	view.setUint16(ETH_HDR + 2, f.length - ETH_HDR);
	f[ETH_HDR + 8] = 64;
	f[ETH_HDR + 9] = IP_UDP;
	f.set([...u32(SERVER), ...u32(0xffffffff)], ETH_HDR + 12);
	view.setUint16(ETH_HDR + 10, checksum(f, ETH_HDR, UDP));
	view.setUint16(UDP, 67);
	view.setUint16(UDP + 2, 68);
	view.setUint16(UDP + 4, f.length - UDP);
	// The client's own header, transaction id and MAC, as a reply, with the address it may have.
	f.set(request.subarray(BOOTP, OPTIONS), BOOTP);
	f[BOOTP] = 2;
	f.set(u32(LEASED), BOOTP + 16);
	const server = [54, 4, ...u32(SERVER)];
	const lease = [51, 4, ...u32(3600)];
	const mask = [1, 4, ...u32(0xffffff00)];
	f.set([MESSAGE_TYPE, 1, type, ...server, ...lease, ...mask, 255], OPTIONS);
	return f;
}

export function bootLease(): Gateway {
	let toGuest = (_frame: Uint8Array) => {};
	return {
		gwMac: GW_MAC,
		net: NET,
		mask: 0xffffff00,
		attach(kernel) {
			toGuest = (frame) => kernel.receiveFrame(frame);
		},
		send(frame) {
			if (!isDhcpRequest(frame) || ipAddrs(frame)?.ihl !== 20) return;
			const type = messageType(frame);
			if (type === DISCOVER) toGuest(reply(frame, OFFER));
			if (type === REQUEST) toGuest(reply(frame, ACK));
		},
	};
}
