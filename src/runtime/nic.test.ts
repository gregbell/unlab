import { describe, expect, test } from "vitest";
import {
	arpPacket,
	BROADCAST,
	eth,
	ip,
	ipv4Packet,
	mac,
	ping,
	udpSegment,
	ZERO_MAC,
} from "../../test/support/frames.ts";
import { macStr } from "../net/index.ts";
import { type Gateway, LabNic } from "./nic.ts";

const GATEWAY_MAC = Uint8Array.of(0x52, 0x55, 0x0a, 0, 2, 2);
const address = (a: number, b: number, c: number, d: number): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const LEASE = address(10, 0, 2, 15);

function eth0(withGateway = true) {
	const toGateway: Uint8Array[] = [];
	const toSwitch: Uint8Array[] = [];
	const gateway: Gateway = {
		gwMac: GATEWAY_MAC,
		net: address(10, 0, 2, 0),
		mask: address(255, 255, 255, 0),
		send: (frame) => toGateway.push(frame),
	};
	const nic = new LabNic({
		mac: macStr(mac(1)),
		gateway: withGateway ? gateway : undefined,
		toSwitch: (frame) => toSwitch.push(frame),
	});
	const where = (frame: Uint8Array): string => {
		toGateway.length = 0;
		toSwitch.length = 0;
		nic.send(frame);
		return [...toGateway.map(() => "gateway"), ...toSwitch.map(() => "switch")].join(" and ");
	};
	return { nic, where, toSwitch };
}

const ask = (spa: number, tpa: number): Uint8Array =>
	eth(BROADCAST, mac(1), 0x0806, arpPacket(1, mac(1), spa, ZERO_MAC, tpa));
const packet = (to: Uint8Array, src: number, dst: number): Uint8Array =>
	eth(to, mac(1), 0x0800, ipv4Packet(src, dst, 6, new Array(20).fill(0)));
const discover = eth(BROADCAST, mac(1), 0x0800, ipv4Packet(0, 0xffffffff, 17, udpSegment(68, 67, 300)));

describe("eth0 sends to the gateway only what is addressed to it", () => {
	test.each([
		["a packet sent through the gateway", packet(GATEWAY_MAC, LEASE, address(151, 101, 2, 132))],
		["an ARP request for the gateway", ask(LEASE, address(10, 0, 2, 2))],
		["one that asks from the lab address", ask(ip(1), address(10, 0, 2, 2))],
		["a DHCP request", discover],
		["a broadcast on the gateway's subnet", packet(BROADCAST, LEASE, address(10, 0, 2, 255))],
	])("%s", (_what, frame) => {
		expect(eth0().where(frame)).toBe("gateway");
	});
});

describe("eth0 sends everything else to the switch", () => {
	test.each([
		["a packet for another machine", ping(1, 2)],
		["a packet for another subnet, through another machine", packet(mac(2), ip(1), address(10, 2, 0, 3))],
		["a packet for the internet, through another machine", packet(mac(2), ip(1), address(8, 8, 8, 8))],
		["an ARP request in a subnet the lab did not choose", ask(address(10, 1, 0, 1), address(10, 1, 0, 2))],
		["a broadcast on the lab's subnet", packet(BROADCAST, ip(1), address(10, 88, 0, 255))],
		["a frame that is not IPv4", eth(mac(2), mac(1), 0x8100, new Array(46).fill(0))],
	])("%s", (_what, frame) => {
		expect(eth0().where(frame)).toBe("switch");
	});

	test("and all of it when there is no gateway", () => {
		const { where } = eth0(false);
		for (const frame of [discover, ask(LEASE, address(10, 0, 2, 2)), ping(1, 2)]) expect(where(frame)).toBe("switch");
	});

	test("as a copy, because the kernel reuses the memory it sent", () => {
		const { nic, toSwitch } = eth0();
		const heap = new Uint8Array(4096);
		const frame = heap.subarray(100, 100 + ping(1, 2).length);
		frame.set(ping(1, 2));
		nic.send(frame);
		frame.fill(0);
		expect(toSwitch).toEqual([ping(1, 2)]);
		expect(toSwitch[0].buffer.byteLength).toBe(ping(1, 2).length);
	});
});
