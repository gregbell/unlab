import { describe, expect, it } from "vitest";
import { arpReply, arpRequest, eth, ip, ipv4Packet, mac, ping, udpSegment } from "../../../test/support/frames.ts";
import type { FrameEntry } from "../../capture/index.ts";
import type { MachineName, PortNo } from "../../model/index.ts";
import { frameDetail } from "./frame-detail-model.ts";

const ports = (mask: readonly PortNo[]): number => mask.reduce((m, p) => m | (1 << (p - 1)), 0);

function entry(bytes: Uint8Array, fields: Partial<Omit<FrameEntry, "kind" | "bytes">> = {}): FrameEntry {
	return { kind: "frame", seq: 189, t: 1_618_520, from: 1, to: 0, flood: null, noReply: false, ...fields, bytes };
}

/** node1, node2 and node3 hold ports 1 to 3. */
const holder = (port: PortNo): MachineName | null => (port <= 3 ? `node${port}` : null);

describe("frameDetail", () => {
	it("heads the frame with its number, size, time and ingress port", () => {
		const d = frameDetail(entry(arpRequest(1, 3)), holder);
		expect(d.title).toBe("frame 189");
		expect(d.summary).toBe("42 bytes · 1618.52 s · in on port 1");
	});

	it("decodes the ethernet II header, naming broadcast and lab machines", () => {
		const d = frameDetail(entry(arpRequest(1, 3)), holder);
		expect(d.groups[0]).toEqual({
			title: "ethernet II",
			fields: [
				{ label: "destination", value: "ff:ff:ff:ff:ff:ff", who: { kind: "everyone" } },
				{ label: "source", value: "52:54:00:88:00:0b", who: { kind: "machine", name: "node1" } },
				{ label: "type", value: "0x0806 ARP", who: null },
			],
		});
	});

	it("decodes an ARP request as the group under ethernet", () => {
		const d = frameDetail(entry(arpRequest(1, 3)), holder);
		expect(d.groups[1]).toEqual({
			title: "arp request",
			fields: [
				{ label: "sender mac", value: "52:54:00:88:00:0b", who: { kind: "machine", name: "node1" } },
				{ label: "sender ip", value: "10.88.0.11", who: { kind: "machine", name: "node1" } },
				{ label: "target mac", value: "00:00:00:00:00:00", who: null },
				{ label: "target ip", value: "10.88.0.13", who: { kind: "machine", name: "node3" } },
			],
		});
		expect(frameDetail(entry(arpReply(2, 1)), holder).groups[1]?.title).toBe("arp reply");
	});

	it("decodes IPv4 and ICMP as groups under ethernet", () => {
		const d = frameDetail(entry(ping(1, 2, 5)), holder);
		expect(d.groups.map((g) => g.title)).toEqual(["ethernet II", "ipv4", "icmp echo request"]);
		expect(d.groups[1]?.fields).toEqual([
			{ label: "source", value: "10.88.0.11", who: { kind: "machine", name: "node1" } },
			{ label: "destination", value: "10.88.0.12", who: { kind: "machine", name: "node2" } },
			{ label: "ttl", value: "64", who: null },
			{ label: "protocol", value: "1 ICMP", who: null },
		]);
		expect(d.groups[2]?.fields).toEqual([
			{ label: "type", value: "8", who: null },
			{ label: "code", value: "0", who: null },
			{ label: "id", value: "1", who: null },
			{ label: "seq", value: "5", who: null },
		]);
	});

	it("decodes UDP ports", () => {
		const frame = eth(mac(2), mac(1), 0x0800, ipv4Packet(ip(1), ip(2), 17, udpSegment(5353, 53, 12)));
		const d = frameDetail(entry(frame), holder);
		expect(d.groups[2]).toEqual({
			title: "udp",
			fields: [
				{ label: "source port", value: "5353", who: null },
				{ label: "destination port", value: "53", who: null },
				{ label: "length", value: "20", who: null },
			],
		});
	});

	describe("what switch0 did", () => {
		it("says a broadcast went out every live port, and who never saw it", () => {
			const d = frameDetail(entry(arpRequest(1, 3), { flood: "group", to: ports([2]) }), holder);
			expect(d.did).toEqual([
				["Broadcast, so sent out every live port: delivered to ", { machine: "node2" }, " on port 2."],
				["Port 3 was down, so ", { machine: "node3" }, " never saw it."],
			]);
		});

		it("lists every port a broadcast reached, with no second sentence when none was missed", () => {
			const d = frameDetail(entry(arpRequest(1, 3), { flood: "group", to: ports([2, 3]) }), holder);
			expect(d.did).toEqual([
				[
					"Broadcast, so sent out every live port: delivered to ",
					{ machine: "node2" },
					" on port 2 and ",
					{ machine: "node3" },
					" on port 3.",
				],
			]);
		});

		it("says when a broadcast had nowhere to go", () => {
			const d = frameDetail(entry(arpRequest(1, 2), { flood: "group", to: 0 }), (p) => (p === 1 ? "node1" : null));
			expect(d.did).toEqual([["Broadcast, so sent out every live port, but no other port was up."]]);
		});

		it("says an unknown destination was flooded", () => {
			const d = frameDetail(entry(ping(1, 3), { flood: "unknown", to: ports([2]) }), holder);
			expect(d.did).toEqual([
				[
					"switch0 did not know where ",
					{ machine: "node3" },
					" is, so it flooded the frame: delivered to ",
					{ machine: "node2" },
					" on port 2.",
				],
				["Port 3 was down, so ", { machine: "node3" }, " never saw it."],
			]);
		});

		it("names every machine a flood missed in one sentence", () => {
			const four = (p: PortNo): MachineName | null => (p <= 4 ? `node${p}` : null);
			const d = frameDetail(entry(arpRequest(1, 3), { flood: "group", to: ports([2]) }), four);
			expect(d.did[1]).toEqual([
				"Ports 3 and 4 were down, so ",
				{ machine: "node3" },
				" and ",
				{ machine: "node4" },
				" never saw it.",
			]);
		});

		it("says a learned destination got the frame alone", () => {
			const d = frameDetail(entry(ping(1, 2), { to: ports([2]) }), holder);
			expect(d.did).toEqual([
				["switch0 had learned ", { machine: "node2" }, " on port 2, so it forwarded the frame there only."],
			]);
		});

		it("says a learned destination that leads nowhere live was not delivered", () => {
			const d = frameDetail(entry(ping(1, 2), { to: 0 }), holder);
			expect(d.did).toEqual([
				[
					"switch0 did not deliver it: the address it learned for ",
					{ machine: "node2" },
					" leads back to port 1 or to a port that is down.",
				],
			]);
		});
	});

	it("dumps the bytes 16 to a row, giving a machine's MAC and IP bytes that machine", () => {
		const d = frameDetail(entry(arpRequest(1, 3)), holder);
		expect(d.dump).toEqual([
			{
				offset: "0000",
				runs: [
					{ text: "ff ff ff ff ff ff", machine: null },
					{ text: "52 54 00 88 00 0b", machine: "node1" },
					{ text: "08 06 00 01", machine: null },
				],
			},
			{
				offset: "0010",
				runs: [
					{ text: "08 00 06 04 00 01", machine: null },
					{ text: "52 54 00 88 00 0b", machine: "node1" },
					{ text: "0a 58 00 0b", machine: "node1" },
				],
			},
			{
				offset: "0020",
				runs: [
					{ text: "00 00 00 00 00 00", machine: null },
					{ text: "0a 58 00 0d", machine: "node3" },
				],
			},
		]);
	});

	it("colours IPv4 addresses in the dump", () => {
		const d = frameDetail(entry(ping(1, 2)), holder);
		const coloured = d.dump.flatMap((row) => row.runs.filter((r) => r.machine).map((r) => `${r.machine} ${r.text}`));
		expect(coloured).toEqual([
			"node2 52 54 00 88 00 0c",
			"node1 52 54 00 88 00 0b",
			"node1 0a 58 00 0b",
			"node2 0a 58",
			"node2 00 0c",
		]);
	});
});
