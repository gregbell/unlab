import type { Kernel } from "unkernel";
import { expect, test, vi } from "vitest";
import { decode, ip4, ipAddrs, macStr, parseMac } from "../net/index.ts";
import type { Gateway } from "./nic.ts";
import { echoReply, echoRequest, PingingGateway } from "./ping.ts";

const GUEST = parseMac("52:54:00:88:00:0b");
const GATEWAY = parseMac("52:55:0a:00:02:02");

function checksum(bytes: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0);
	while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
	return sum;
}

/** An echo request as a guest sends one, with an Ethernet trailer that is not part of the packet. */
function request(to: string, type = 8): Uint8Array {
	const payload = Uint8Array.from({ length: 56 }, (_, i) => i);
	const frame = new Uint8Array(14 + 20 + 8 + payload.length + 4);
	const view = new DataView(frame.buffer);
	frame.set(GATEWAY, 0);
	frame.set(GUEST, 6);
	view.setUint16(12, 0x0800);
	frame[14] = 0x45;
	view.setUint16(16, 20 + 8 + payload.length);
	frame[22] = 64;
	frame[23] = 1;
	view.setUint32(26, ip4("10.0.2.15"));
	view.setUint32(30, ip4(to));
	frame[34] = type;
	view.setUint16(38, 0x1234);
	view.setUint16(40, 7);
	frame.set(payload, 42);
	return frame;
}

test("a reply comes from the address that was pinged, to the guest, with the echo's own id, sequence and data", () => {
	const asked = request("93.184.216.34");
	expect(echoRequest(asked)).toBe(ip4("93.184.216.34"));
	const reply = echoReply(asked, GATEWAY, 55);
	expect(reply.length).toBe(14 + 84);
	expect(macStr(reply)).toBe(macStr(GUEST));
	expect(macStr(reply, 6)).toBe(macStr(GATEWAY));
	expect(ipAddrs(reply)).toMatchObject({ proto: 1, src: ip4("93.184.216.34"), dst: ip4("10.0.2.15") });
	expect(reply[22]).toBe(55);
	expect(checksum(reply.subarray(14, 34))).toBe(0xffff);
	expect(checksum(reply.subarray(34))).toBe(0xffff);
	expect(decode(reply)).toMatchObject({ proto: "ICMP", info: "echo reply seq 7, 64 bytes" });
	expect(reply.subarray(38, 98)).toEqual(asked.subarray(38, 98));
});

test("what is no echo request is not one", () => {
	expect(echoRequest(request("1.1.1.1", 0))).toBeNull();
	const tcp = request("1.1.1.1");
	tcp[23] = 6;
	expect(echoRequest(tcp)).toBeNull();
	expect(echoRequest(new Uint8Array(20))).toBeNull();
});

function rig(ping: (address: string) => Promise<{ ttl: number } | null> | null) {
	const inner: Gateway & { sent: Uint8Array[] } = {
		gwMac: GATEWAY,
		net: ip4("10.0.2.0"),
		mask: ip4("255.255.255.0"),
		sent: [],
		send(frame) {
			inner.sent.push(frame);
		},
	};
	const received: Uint8Array[] = [];
	const gateway = new PingingGateway(inner, ping);
	gateway.attach({ receiveFrame: (frame: Uint8Array) => received.push(frame) } as unknown as Kernel);
	return { inner, received, gateway };
}

test("an echo is answered once the far end answers, and not at all when it does not", async () => {
	const answers: PromiseWithResolvers<{ ttl: number } | null>[] = [];
	const { gateway, received, inner } = rig(() => {
		answers.push(Promise.withResolvers());
		return answers[answers.length - 1].promise;
	});
	gateway.send(request("1.1.1.1"));
	gateway.send(request("8.8.8.8"));
	expect(received).toEqual([]);
	answers[0].resolve({ ttl: 57 });
	answers[1].resolve(null);
	await vi.waitFor(() => expect(received).toHaveLength(1));
	expect(ipAddrs(received[0])?.src).toBe(ip4("1.1.1.1"));
	expect(inner.sent).toEqual([]);
});

test("the gateway's own addresses, everything else, and every echo without a CLI go to the gateway as before", () => {
	const { gateway, inner } = rig(() => null);
	const own = request("10.0.2.2");
	const out = request("1.1.1.1");
	gateway.send(own);
	gateway.send(out);
	expect(inner.sent).toEqual([own, out]);
	const linked = rig(() => new Promise(() => {}));
	linked.gateway.send(own);
	expect(linked.inner.sent).toEqual([own]);
});

test("no more than sixteen wait at once", () => {
	const asked: string[] = [];
	const { gateway } = rig((address) => {
		asked.push(address);
		return new Promise(() => {});
	});
	for (let i = 0; i < 20; i++) gateway.send(request("1.1.1.1"));
	expect(asked).toHaveLength(16);
});
