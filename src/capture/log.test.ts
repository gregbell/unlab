import { describe, expect, test } from "vitest";
import { arpReply, arpRequest, BROADCAST, eth, ipv4Packet, mac, ping } from "../../test/support/frames.ts";
import type { PortNo } from "../model/types.ts";
import { type CaptureFilter, compileFilter, type Flood } from "../net/index.ts";
import { type CaptureLog, createCaptureLog } from "./log.ts";
import { formatCounters } from "./rows.ts";

const bit = (p: number) => 1 << (p - 1);

function setup(limit = 10_000) {
	let clock = 0;
	const queue: (() => void)[] = [];
	const log = createCaptureLog({ limit, now: () => clock, schedule: (fn) => queue.push(fn) });
	const frame = (bytes: Uint8Array, from: PortNo, to: number, flood: Flood | null = null) =>
		log.appendFrame({ from, to, flood, frame: bytes });
	const at = (ms: number) => {
		clock = ms;
	};
	const flush = () => {
		for (const fn of queue.splice(0)) fn();
	};
	return { log, frame, at, flush, queue };
}

const filter = (source: string): CaptureFilter => {
	const r = compileFilter(source);
	if (!r.ok) throw new Error(r.error.message);
	return r.filter;
};
const seqs = (log: CaptureLog) => log.window(0, log.matchCount).map((r) => r.seq);
const notes = (log: CaptureLog) => log.tail(log.matchCount).map((r) => (r.kind === "frame" ? r.note : r.text));

describe("rows", () => {
	test("a frame row shows time in seconds, protocol, route, length and decode", () => {
		const { log, frame, at } = setup();
		at(1234.5);
		frame(ping(1, 2), 1, bit(2));
		expect(log.tail(1)).toEqual([
			{
				kind: "frame",
				seq: 1,
				time: "1.23",
				proto: "ICMP",
				from: { kind: "machine", name: "node1" },
				to: { kind: "machine", name: "node2" },
				len: 98,
				info: "echo request seq 1, 64 bytes",
				note: null,
			},
		]);
	});

	test("broadcast reads everyone; an address the lab cannot name is raw", () => {
		const { log, frame } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		const outsider = Uint8Array.of(0x02, 0, 0, 0, 0, 9);
		frame(eth(BROADCAST, outsider, 0x0800, ipv4Packet(0x0a000202, 0xffffffff, 17, [0, 68, 0, 67, 0, 8, 0, 0])), 4, 0);
		const [arp, dhcp] = log.tail(2);
		expect(arp).toMatchObject({ from: { kind: "machine", name: "node1" }, to: { kind: "everyone" } });
		expect(dhcp).toMatchObject({ from: { kind: "raw", text: "10.0.2.2:68" }, to: { kind: "everyone" } });
	});

	test("an outsider's MAC carrying a lab address is named by the address", () => {
		const { log, frame } = setup();
		const outsider = Uint8Array.of(0x02, 0, 0, 0, 0, 9);
		frame(eth(mac(2), outsider, 0x0800, ipv4Packet(0x0a58000d, 0x0a58000c, 1, [8, 0, 0, 0, 0, 1, 0, 1])), 5, bit(2));
		expect(log.tail(1)[0]).toMatchObject({
			from: { kind: "machine", name: "node3" },
			to: { kind: "machine", name: "node2" },
		});
	});

	test("link rows say which port changed and who did it", () => {
		const { log, at } = setup();
		at(2000);
		log.appendLink({ port: 3, machine: "node3", up: false, cause: "agent" });
		log.appendLink({ port: 3, machine: "node3", up: true, cause: "bar" });
		log.appendLink({ port: 5, machine: "node5", up: false, cause: "runtime" });
		expect(log.tail(3)).toEqual([
			{
				kind: "link",
				seq: 1,
				time: "2.00",
				port: 3,
				up: false,
				text: "port 3 link down",
				cause: "Cable to node3 cut by the agent.",
			},
			{
				kind: "link",
				seq: 2,
				time: "2.00",
				port: 3,
				up: true,
				text: "port 3 link up",
				cause: "Cable to node3 reconnected by you.",
			},
			{
				kind: "link",
				seq: 3,
				time: "2.00",
				port: 5,
				up: false,
				text: "port 5 link down",
				cause: "Cable to node5 cut by the lab.",
			},
		]);
	});
});

describe("annotations", () => {
	test("say what the switch did beyond forwarding", () => {
		const { log, frame } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		frame(arpRequest(1, 3), 1, bit(2) | bit(3), "group");
		frame(ping(1, 2), 1, bit(2), "unknown");
		frame(ping(1, 2), 1, bit(2) | bit(3) | bit(4), "unknown");
		frame(ping(1, 3), 1, 0, "unknown");
		frame(ping(1, 2), 1, bit(2));
		expect(notes(log)).toEqual([
			"flooded to port 2",
			"flooded to ports 2 and 3",
			"unknown destination, flooded to port 2",
			"unknown destination, flooded to ports 2, 3 and 4",
			"unknown destination, flooded, no other port is up",
			null,
		]);
	});

	test("an ARP request unanswered for a second gets no reply on the next sweep", () => {
		const { log, frame, at } = setup();
		at(100);
		frame(arpRequest(1, 9), 1, bit(2), "group");
		const before = log.revision;
		log.sweep(1099);
		expect(notes(log)).toEqual(["flooded to port 2"]);
		expect(log.revision).toBe(before);
		log.sweep(1100);
		expect(notes(log)).toEqual(["flooded to port 2 · no reply"]);
		expect(log.revision).toBeGreaterThan(before);
	});

	test("an answered request never gets no reply", () => {
		const { log, frame, at } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		at(400);
		frame(arpReply(2, 1), 2, bit(1));
		log.sweep(5000);
		expect(notes(log)).toEqual(["flooded to port 2", null]);
	});

	test("a reply answers only the request it matches", () => {
		const { log, frame, at } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		frame(arpRequest(1, 3), 1, bit(2), "group");
		at(10);
		frame(arpReply(3, 1), 2, bit(1));
		log.sweep(1000);
		expect(notes(log)).toEqual(["flooded to port 2 · no reply", "flooded to port 2", null]);
	});

	test("every unanswered retry is marked", () => {
		const { log, frame, at } = setup();
		for (const t of [0, 1000, 2000]) {
			at(t);
			frame(arpRequest(1, 9), 1, 0, "group");
		}
		log.sweep(2500);
		expect(notes(log)).toEqual([
			"flooded, no other port is up · no reply",
			"flooded, no other port is up · no reply",
			"flooded, no other port is up",
		]);
	});

	test("a gratuitous announcement asks nothing, so it is never no reply", () => {
		const { log, frame } = setup();
		frame(arpRequest(1, 1, 0x0a58000b), 1, bit(2), "group");
		log.sweep(5000);
		expect(notes(log)).toEqual(["flooded to port 2"]);
	});

	test("a request evicted or cleared before its sweep is forgotten", () => {
		const { log, frame } = setup(2);
		frame(arpRequest(1, 9), 1, 0, "group");
		frame(ping(1, 2), 1, bit(2));
		frame(ping(1, 2), 1, bit(2));
		frame(arpRequest(1, 8), 1, 0, "group");
		log.clear();
		log.sweep(5000);
		expect(log.size).toBe(0);
	});
});

describe("pause and clear", () => {
	test("pause stops adding rows while the counters keep running", () => {
		const { log, frame } = setup();
		frame(ping(1, 2), 1, bit(2));
		log.setPaused(true);
		frame(ping(1, 2), 1, bit(2));
		log.appendLink({ port: 2, machine: "node2", up: false, cause: "button" });
		expect(log.size).toBe(1);
		expect(log.counters).toEqual({ in: 2, delivered: 2, flooded: 0 });
		log.setPaused(false);
		frame(ping(2, 1), 2, bit(1));
		expect(log.tail(5).map((r) => r.seq)).toEqual([1, 2]);
	});

	test("a reply that arrives while paused still answers its request", () => {
		const { log, frame } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		log.setPaused(true);
		frame(arpReply(2, 1), 2, bit(1));
		log.sweep(5000);
		expect(notes(log)).toEqual(["flooded to port 2"]);
	});

	test("clear empties the list, keeps the counters, and never reuses a seq", () => {
		const { log, frame } = setup();
		frame(ping(1, 2), 1, bit(2));
		frame(arpRequest(1, 3), 1, bit(2) | bit(3), "group");
		log.clear();
		expect([log.size, log.frameCount, log.matchCount, log.tail(8)]).toEqual([0, 0, 0, []]);
		expect(log.entry(1)).toBeNull();
		expect(formatCounters(log.counters)).toBe("2 in · 3 delivered · 1 flooded");
		frame(ping(1, 2), 1, bit(2));
		expect(log.tail(1)[0].seq).toBe(3);
	});
});

describe("filter", () => {
	test("the filtered view and its counts follow the filter", () => {
		const { log, frame } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		frame(ping(1, 2), 1, bit(2));
		log.appendLink({ port: 3, machine: "node3", up: false, cause: "agent" });
		frame(ping(2, 1, 1, 0), 2, bit(1));
		log.setFilter(filter("icmp"));
		expect([log.matchCount, log.matchedFrames, log.frameCount, log.size]).toEqual([3, 2, 3, 4]);
		expect(seqs(log)).toEqual([2, 3, 4]);
		frame(ping(1, 2, 2), 1, bit(2));
		frame(arpRequest(2, 1), 2, bit(1), "group");
		expect(seqs(log)).toEqual([2, 3, 4, 5]);
		log.setFilter(filter("port:2"));
		expect(seqs(log)).toEqual([1, 2, 4, 5, 6]);
	});

	test("window and indexOf address the filtered view", () => {
		const { log, frame } = setup();
		for (let i = 0; i < 6; i++) frame(i % 2 ? ping(1, 2) : arpRequest(1, 2), 1, bit(2));
		log.setFilter(filter("arp"));
		expect(log.window(1, 2).map((r) => r.seq)).toEqual([3, 5]);
		expect(log.window(2, 10).map((r) => r.seq)).toEqual([5]);
		expect(log.tail(2).map((r) => r.seq)).toEqual([3, 5]);
		expect([log.indexOf(5), log.indexOf(4), log.indexOf(99)]).toEqual([2, -1, -1]);
	});
});

describe("the ring", () => {
	test("keeps the newest entries up to its limit", () => {
		const { log, frame } = setup(3);
		for (let i = 1; i <= 5; i++) frame(ping(1, 2, i), 1, bit(2));
		expect(log.size).toBe(3);
		expect(log.entry(2)).toBeNull();
		expect(log.entry(3)).toMatchObject({ kind: "frame", seq: 3 });
		expect(log.tail(10).map((r) => r.seq)).toEqual([3, 4, 5]);
		expect(Array.from(log.frames(), (e) => e.seq)).toEqual([3, 4, 5]);
	});

	test("frames() ignores the filter and skips link rows", () => {
		const { log, frame } = setup();
		frame(arpRequest(1, 2), 1, bit(2), "group");
		log.appendLink({ port: 2, machine: "node2", up: false, cause: "bar" });
		frame(ping(1, 2), 1, bit(2));
		log.setFilter(filter("icmp"));
		expect(Array.from(log.frames(), (e) => e.seq)).toEqual([1, 3]);
	});
});

describe("notification", () => {
	test("subscribers hear at most once per scheduled flush", () => {
		const { log, frame, flush, queue } = setup();
		let calls = 0;
		const off = log.subscribe(() => calls++);
		for (let i = 0; i < 50; i++) frame(ping(1, 2), 1, bit(2));
		expect(queue.length).toBe(1);
		flush();
		expect(calls).toBe(1);
		flush();
		expect(calls).toBe(1);
		log.appendLink({ port: 1, machine: "node1", up: false, cause: "bar" });
		flush();
		expect(calls).toBe(2);
		off();
		frame(ping(1, 2), 1, bit(2));
		flush();
		expect(calls).toBe(2);
	});

	test("the revision moves with every change a reader can see", () => {
		const { log, frame } = setup();
		const revisions = [log.revision];
		frame(ping(1, 2), 1, bit(2));
		revisions.push(log.revision);
		log.setFilter(filter("arp"));
		revisions.push(log.revision);
		log.clear();
		revisions.push(log.revision);
		expect(new Set(revisions).size).toBe(4);
	});
});
