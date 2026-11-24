import type { Kernel } from "unkernel";
import { describe, expect, test } from "vitest";
import { arpRequest, BROADCAST, eth, ipv4Packet, mac, ping, udpSegment } from "../../test/support/frames.ts";
import { ip4str, ipAddrs, l4Ports, macStr } from "../net/index.ts";
import { BOOT_LEASE, bootLease } from "./boot-lease.ts";
import { LabNic } from "./nic.ts";

const DISCOVER = 1;
const REQUEST = 3;
const COOKIE = [99, 130, 83, 99];

/** What a DHCP client with node1's MAC broadcasts. */
function dhcp(type: number): Uint8Array {
	const bootp = new Uint8Array(240 + 4);
	bootp.set([1, 1, 6, 0, 0xca, 0xfe, 0xba, 0xbe]);
	bootp.set(mac(1), 28);
	bootp.set([...COOKIE, 53, 1, type, 255], 236);
	const l4 = [...udpSegment(68, 67, bootp.length).slice(0, 8), ...bootp];
	return eth(BROADCAST, mac(1), 0x0800, ipv4Packet(0, 0xffffffff, 17, l4));
}

/** Sends frames out of a NIC that has the lease, and returns what the guest and the switch got. */
function booting() {
	const toGuest: Uint8Array[] = [];
	const toSwitch: Uint8Array[] = [];
	const nic = new LabNic({ mac: macStr(mac(1)), gateway: bootLease(), toSwitch: (frame) => toSwitch.push(frame) });
	nic.attach({ receiveFrame: (frame: Uint8Array) => toGuest.push(frame) } as unknown as Kernel);
	return { nic, toGuest, toSwitch };
}

const options = (f: Uint8Array): Record<number, number[]> => {
	const found: Record<number, number[]> = {};
	for (let at = 14 + 20 + 8 + 240; f[at] !== 255; at += 2 + f[at + 1])
		found[f[at]] = [...f.subarray(at + 2, at + 2 + f[at + 1])];
	return found;
};

describe("a NIC with no gateway, while the guest boots", () => {
	test.each([
		["a discover with an offer", DISCOVER, 2],
		["a request with an ack", REQUEST, 5],
	])("answers %s of the lease, and nothing reaches the switch", (_what, type, answer) => {
		const { nic, toGuest, toSwitch } = booting();
		nic.send(dhcp(type));
		expect(toSwitch).toEqual([]);
		expect(toGuest).toHaveLength(1);
		const [f] = toGuest;
		expect(macStr(f, 0)).toBe(macStr(mac(1)));
		const ip = ipAddrs(f);
		expect(ip && l4Ports(f, ip)).toEqual({ sport: 67, dport: 68 });
		const bootp = f.subarray(42);
		expect([...bootp.subarray(0, 8)]).toEqual([2, 1, 6, 0, 0xca, 0xfe, 0xba, 0xbe]);
		expect(ip4str(new DataView(f.buffer).getUint32(42 + 16))).toBe(BOOT_LEASE.address);
		expect([...bootp.subarray(28, 34)]).toEqual([...mac(1)]);
		const given = options(f);
		expect(given[53]).toEqual([answer]);
		expect(given[1]).toEqual([255, 255, 255, 0]);
		// No router and no DNS server, which the image would keep after the address is gone.
		expect(given[3]).toBeUndefined();
		expect(given[6]).toBeUndefined();
	});

	test("sends the rest to the switch, and once it is dropped, DHCP too", () => {
		const { nic, toGuest, toSwitch } = booting();
		nic.send(ping(1, 2));
		nic.send(arpRequest(1, 2));
		expect(toSwitch).toHaveLength(2);
		nic.dropGateway();
		nic.send(dhcp(DISCOVER));
		expect(toSwitch).toHaveLength(3);
		expect(toGuest).toEqual([]);
	});
});
