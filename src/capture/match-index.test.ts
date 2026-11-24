import fc from "fast-check";
import { expect, test } from "vitest";
import { arpReply, arpRequest, eth, ipv4Packet, ping, tcpSegment, udpSegment } from "../../test/support/frames.ts";
import type { Cause, MachineName, PortNo } from "../model/index.ts";
import { type CaptureFilter, compileFilter, type Flood, MATCH_ALL, NICS, type NicNo } from "../net/index.ts";
import { createCaptureLog, type SwitchedFrame } from "./log.ts";

const node = (n: number): MachineName => `node${n}`;
const ip = (n: number) => (0x0a580000 + 10 + n) >>> 0;
const mac = (n: number) => Uint8Array.of(0x52, 0x54, 0, 0x88, 0, 10 + n);

const FRAMES: readonly Uint8Array[] = [1, 2, 3, 4].flatMap((a) =>
	[1, 2, 3, 4]
		.filter((b) => b !== a)
		.flatMap((b) => [
			arpRequest(a, b),
			arpReply(a, b),
			ping(a, b),
			ping(a, b, 7, 0),
			eth(mac(b), mac(a), 0x0800, ipv4Packet(ip(a), ip(b), 6, tcpSegment(40000, 80))),
			eth(mac(b), mac(a), 0x0800, ipv4Packet(ip(a), ip(b), 17, udpSegment(40000, 53, 12))),
		]),
);
const TERMS = [
	"arp",
	"icmp",
	"tcp",
	"udp",
	"dns",
	"ip",
	"node1",
	"node2",
	"node2:eth1",
	"node3",
	"node4",
	"10.88.0.12",
	"52:54:00:88:00:0d",
	"port:1",
	"port:2",
	"port:3",
	"port:4",
];

const port = fc.integer({ min: 1, max: 4 }) as fc.Arbitrary<PortNo>;
const switched: fc.Arbitrary<SwitchedFrame> = fc.record({
	from: port,
	to: fc.integer({ min: 0, max: 15 }),
	flood: fc.constantFrom<Flood | null>(null, "group", "unknown"),
	frame: fc.constantFrom(...FRAMES),
});
const filterSource = fc
	.array(fc.array(fc.constantFrom(...TERMS), { minLength: 1, maxLength: 3 }), { minLength: 0, maxLength: 3 })
	.map((groups) => groups.map((g) => g.join(" ")).join(" or "));

type Op =
	| { op: "frame"; frame: SwitchedFrame }
	| { op: "link"; port: PortNo; n: number; nic: NicNo; up: boolean; cause: Cause }
	| { op: "filter"; source: string }
	| { op: "pause"; paused: boolean }
	| { op: "clear" }
	| { op: "sweep"; dt: number };

const operation: fc.Arbitrary<Op> = fc.oneof(
	{ weight: 20, arbitrary: switched.map((frame) => ({ op: "frame" as const, frame })) },
	{
		weight: 2,
		arbitrary: fc.record({
			op: fc.constant("link" as const),
			port,
			n: fc.integer({ min: 1, max: 4 }),
			nic: fc.constantFrom(...NICS),
			up: fc.boolean(),
			cause: fc.constantFrom<Cause>("bar", "button", "agent", "runtime"),
		}),
	},
	{ weight: 2, arbitrary: filterSource.map((source) => ({ op: "filter" as const, source })) },
	{ weight: 1, arbitrary: fc.boolean().map((paused) => ({ op: "pause" as const, paused })) },
	{ weight: 1, arbitrary: fc.constant({ op: "clear" as const }) },
	{ weight: 2, arbitrary: fc.integer({ min: 0, max: 1500 }).map((dt) => ({ op: "sweep" as const, dt })) },
);

type Kept =
	| { seq: number; kind: "frame"; frame: SwitchedFrame }
	| { seq: number; kind: "link"; port: PortNo; machine: MachineName; nic: NicNo };

function compile(source: string): CaptureFilter {
	const r = compileFilter(source);
	if (!r.ok) throw new Error(r.error.message);
	return r.filter;
}

test("the incremental match index agrees with filtering the whole buffer", () => {
	fc.assert(
		fc.property(fc.integer({ min: 1, max: 24 }), fc.array(operation, { maxLength: 200 }), (limit, ops) => {
			let clock = 0;
			const log = createCaptureLog({ limit, now: () => clock, schedule: () => {} });
			let buffer: Kept[] = [];
			let filter = MATCH_ALL;
			let paused = false;
			let seq = 1;
			const counters = { in: 0, delivered: 0, flooded: 0 };
			const keep = (k: Kept) => {
				buffer.push(k);
				if (buffer.length > limit) buffer = buffer.slice(-limit);
			};

			for (const o of ops) {
				switch (o.op) {
					case "frame":
						log.appendFrame(o.frame);
						counters.in++;
						counters.delivered += [1, 2, 3, 4].filter((p) => o.frame.to & (1 << (p - 1))).length;
						if (o.frame.flood) counters.flooded++;
						if (!paused) keep({ seq: seq++, kind: "frame", frame: o.frame });
						break;
					case "link":
						log.appendLink({ port: o.port, machine: node(o.n), nic: o.nic, up: o.up, cause: o.cause });
						if (!paused) keep({ seq: seq++, kind: "link", port: o.port, machine: node(o.n), nic: o.nic });
						break;
					case "filter":
						filter = compile(o.source);
						log.setFilter(filter);
						break;
					case "pause":
						paused = o.paused;
						log.setPaused(o.paused);
						break;
					case "clear":
						buffer = [];
						log.clear();
						break;
					case "sweep":
						clock += o.dt;
						log.sweep(clock);
						break;
				}

				const expected = buffer.filter((k) =>
					k.kind === "frame"
						? filter.matchesFrame(k.frame.frame, k.frame.from, k.frame.to)
						: filter.matchesLink(k.port, k.machine, k.nic),
				);
				expect(log.window(0, log.matchCount).map((r) => r.seq)).toEqual(expected.map((k) => k.seq));
				expect(log.matchedFrames).toBe(expected.filter((k) => k.kind === "frame").length);
				expect(log.size).toBe(buffer.length);
				expect(log.frameCount).toBe(buffer.filter((k) => k.kind === "frame").length);
				expect(Array.from(log.frames(), (e) => e.seq)).toEqual(
					buffer.filter((k) => k.kind === "frame").map((k) => k.seq),
				);
				expect(log.counters).toEqual(counters);
				for (const [i, k] of expected.entries()) expect(log.indexOf(k.seq)).toBe(i);
			}
		}),
		{ numRuns: 300 },
	);
});

test("100 000 appends into a full ring with a filter stay cheap and notify once per flush", () => {
	const queue: (() => void)[] = [];
	const log = createCaptureLog({ limit: 10_000, now: () => 0, schedule: (fn) => queue.push(fn) });
	log.setFilter(compile("icmp node2 or arp port:3"));
	const frames = FRAMES.map((frame, i) => ({ from: ((i % 4) + 1) as PortNo, to: 1 << (i % 4), flood: null, frame }));
	const calls = [0, 0];
	log.subscribe(() => calls[0]++);
	log.subscribe(() => calls[1]++);

	let flushes = 0;
	const start = performance.now();
	for (let i = 0; i < 100_000; i++) {
		log.appendFrame(frames[i % frames.length]);
		if (i % 1000 === 999) {
			for (const fn of queue.splice(0)) fn();
			flushes++;
		}
	}
	const elapsed = performance.now() - start;

	expect(log.size).toBe(10_000);
	expect(log.matchCount).toBeGreaterThan(0);
	expect(calls).toEqual([flushes, flushes]);
	expect(elapsed).toBeLessThan(1000);
});
