import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type BridgePriority, DEFAULT_PRIORITY, type PathCost, type PortNo, type TreePort } from "../model/index.ts";
import { type Bpdu, bridgeIdOf, decodeBpdu, encodeBpdu } from "../net/index.ts";
import { Bridge, EDGE_DELAY_MS, FORWARD_DELAY_MS, HELLO_MS, MOST_COST, TX_HOLD } from "./rstp.ts";

type Cable = readonly [a: number, portA: PortNo, b: number, portB: PortNo];

/**
 * Bridges on cables, with time that moves only when a test moves it. `a`,
 * `b`, `c` and so on are in the order of their addresses, so `a` is the root
 * of any tree that it is in.
 */
function wired(count: number, cables: readonly Cable[] = []) {
	let now = 0;
	/** By their ends, so that a cable that is written out twice is one cable. */
	const up = new Map<string, Cable>();
	const waiting: { to: number; port: PortNo; frame: Uint8Array }[] = [];
	const sent: { from: number; port: PortNo; bpdu: Bpdu; at: number }[] = [];
	const flushed: string[] = [];
	/** The most cables that both ends forwarded on at once round a loop, at any moment. */
	let loops = 0;
	/** The same, of the moments when every bridge had come to rest. */
	let left = 0;
	const bridges = Array.from(
		{ length: count },
		(_, i) =>
			new Bridge(0x0200_0000_0001 + i, {
				send(port, frame) {
					const bpdu = decodeBpdu(frame);
					if (bpdu) sent.push({ from: i, port, bpdu, at: now });
					for (const [a, portA, b, portB] of up.values()) {
						if (a === i && portA === port) waiting.push({ to: b, port: portB, frame });
						if (b === i && portB === port) waiting.push({ to: a, port: portA, frame });
					}
				},
				flush: (port) => void flushed.push(`${NAMES[i]}${port}`),
			}),
	);
	const carrying = (): Cable[] =>
		[...up.values()].filter(([a, portA, b, portB]) => bridges[a].forwards(portA) && bridges[b].forwards(portB));
	const looped = (): number => {
		const group = bridges.map((_, i) => i);
		const find = (i: number): number => (group[i] === i ? i : find(group[i]));
		let closed = 0;
		for (const [a, , b] of carrying()) {
			if (find(a) === find(b)) closed++;
			else group[find(a)] = find(b);
		}
		return closed;
	};
	/** Runs every bridge that has something to do, and carries what they send, until all is quiet at this time. */
	const settle = () => {
		for (let turn = 0; turn < 10_000; turn++) {
			const next = waiting.shift();
			if (next) bridges[next.to].receive(next.port, next.frame, now);
			const busy = bridges.filter((bridge) => bridge.pending || bridge.due <= now);
			if (!next && busy.length === 0) {
				left = Math.max(left, looped());
				return;
			}
			for (const bridge of next ? [bridges[next.to]] : busy) bridge.run(now);
			loops = Math.max(loops, looped());
		}
		throw new Error("the bridges never came to rest");
	};
	const t = {
		bridges,
		sent,
		flushed,
		get now() {
			return now;
		},
		get loops() {
			return loops;
		},
		get left() {
			return left;
		},
		plug(cable: Cable) {
			const [a, portA, b, portB] = cable;
			up.set(cable.join(), cable);
			bridges[a].enable(portA, false);
			bridges[b].enable(portB, false);
			settle();
		},
		cut(cable: Cable) {
			const [a, portA, b, portB] = cable;
			up.delete(cable.join());
			bridges[a].disable(portA);
			bridges[b].disable(portB);
			settle();
		},
		/** A machine's cable: nothing answers on it. */
		machine(on: number, port: PortNo) {
			bridges[on].enable(port, true);
			settle();
		},
		settle,
		/** Moves time on, running each bridge when a timer of its runs out. */
		pass(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = Math.min(...bridges.map((bridge) => bridge.due));
				if (due > end) break;
				now = due;
				settle();
			}
			now = end;
			settle();
		},
		/** `a7 designated forwarding`, for each port of each bridge that has a link. */
		ports(): string[] {
			return bridges.flatMap((bridge, i) =>
				bridge.reading().ports.map(({ port, role, state }: TreePort) => `${NAMES[i]}${port} ${role} ${state}`),
			);
		},
		roots: () => bridges.map((bridge) => bridge.reading().root.address.slice(-2)),
		carrying,
	};
	for (const cable of cables) t.plug(cable);
	return t;
}

/** A bridge with a higher address than any of a test's, which says that it is the root and hears no answer. */
function deaf(to: (frame: Uint8Array) => void) {
	const bridge = new Bridge(0x0200_0000_00ff, { send: (_port, frame) => to(frame), flush() {} });
	return {
		propose(now: number) {
			bridge.disable(1);
			bridge.enable(1, false);
			bridge.run(now);
		},
	};
}

const NAMES = "abcdefgh";
const AB: Cable = [0, 7, 1, 8];
const BC: Cable = [1, 7, 2, 8];
const CA: Cable = [2, 7, 0, 8];

describe("a bridge", () => {
	test("with no neighbour is its own root, and a machine's port forwards at once", () => {
		const t = wired(1);
		t.machine(0, 1);
		expect(t.ports()).toEqual(["a1 designated forwarding"]);
		expect(t.bridges[0].reading()).toMatchObject({
			bridge: { priority: 32768, address: "02:00:00:00:00:01" },
			root: { priority: 32768, address: "02:00:00:00:00:01" },
			cost: 0,
		});
		expect(t.now).toBe(0);
	});

	test("takes no frame on a port from when its link comes up until it has run", () => {
		const bridge = new Bridge(1, { send() {}, flush() {} });
		bridge.enable(1, true);
		expect([bridge.learns(1), bridge.forwards(1)]).toEqual([false, false]);
		bridge.run(0);
		expect([bridge.learns(1), bridge.forwards(1)]).toEqual([true, true]);
		bridge.disable(1);
		expect([bridge.learns(1), bridge.forwards(1)]).toEqual([false, false]);
	});

	test("says what it knows on each designated port once a hello, and answers a lesser bridge each time, up to its bound for a second", () => {
		const t = wired(1);
		t.machine(0, 1);
		const before = t.sent.length;
		t.pass(10 * HELLO_MS);
		const hellos = t.sent.slice(before);
		expect(hellos).toHaveLength(10);
		expect(hellos.every(({ bpdu }) => bpdu.role === "designated" && bpdu.forwarding && bpdu.cost === 0)).toBe(true);
		expect(hellos.map(({ at }) => at)).toEqual(Array.from({ length: 10 }, (_, i) => (i + 1) * HELLO_MS));

		// A lesser bridge that proposes over and over in one moment is answered each time, until the bound that is there
		// for a mistake. One more answer goes after the second.
		const lesser = deaf((frame) => t.bridges[0].receive(1, frame, t.now));
		t.pass(1000);
		const from = t.sent.length;
		for (let i = 0; i < 20; i++) {
			lesser.propose(t.now);
			t.settle();
		}
		expect(t.sent.length - from).toBe(20);
		for (let i = 20; i < TX_HOLD + 20; i++) {
			lesser.propose(t.now);
			t.settle();
		}
		expect(t.sent.length - from).toBe(TX_HOLD);
		t.pass(1000);
		expect(t.sent.length - from).toBe(TX_HOLD + 1);
	});
});

describe("two bridges on a cable", () => {
	test("agree at once that the one with the lower address is the root, and both ports forward", () => {
		const t = wired(2, [AB]);
		expect(t.ports()).toEqual(["a7 designated forwarding", "b8 root forwarding"]);
		expect(t.roots()).toEqual(["01", "01"]);
		expect(t.bridges[1].reading().cost).toBe(20_000);
		expect(t.now).toBe(0);
		// The proposal and the agreement that let the root's port forward without a timer.
		const flags = t.sent.map(
			({ from, bpdu }) =>
				`${NAMES[from]} ${bpdu.role}${bpdu.proposal ? " proposal" : ""}${bpdu.agreement ? " agreement" : ""}`,
		);
		expect(flags).toContain("a designated proposal");
		expect(flags).toContain("b root agreement");
	});

	test("on two cables use one, and the other is the far bridge's alternate, which carries nothing", () => {
		const t = wired(2, [AB, [0, 6, 1, 6]]);
		expect(t.ports()).toEqual([
			"a6 designated forwarding",
			"a7 designated forwarding",
			"b6 root forwarding",
			"b8 alternate discarding",
		]);
		expect(t.loops).toBe(0);
	});

	test("with a cable from one port to another of the same bridge, that bridge blocks the higher as a backup", () => {
		const t = wired(1, [[0, 3, 0, 4]]);
		expect(t.ports()).toEqual(["a3 designated forwarding", "a4 backup discarding"]);
		expect(t.loops).toBe(0);
	});
});

describe("a triangle of bridges", () => {
	test("blocks one port: the last bridge's, on its cable to the bridge that is not the root", () => {
		const t = wired(3, [AB, BC, CA]);
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"a8 designated forwarding",
			"b7 designated forwarding",
			"b8 root forwarding",
			"c7 root forwarding",
			"c8 alternate discarding",
		]);
		expect(t.roots()).toEqual(["01", "01", "01"]);
		expect([t.loops, t.now]).toEqual([0, 0]);
	});

	test("brings the blocked port into use at once when the cable of its bridge's root port is cut, and has the others forget", () => {
		const t = wired(3, [AB, BC, CA]);
		t.flushed.length = 0;
		const from = t.sent.length;
		t.cut(CA);
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"b7 designated forwarding",
			"b8 root forwarding",
			"c8 root forwarding",
		]);
		expect(t.bridges[2].reading().cost).toBe(40_000);
		expect(t.now).toBe(0);
		// c says that the topology changed, and b forgets what it learned towards a, where c's machines were.
		expect(t.sent.slice(from).some(({ from: by, bpdu }) => by === 2 && bpdu.topologyChange)).toBe(true);
		expect(t.flushed).toEqual(["b8"]);
		expect(t.loops).toBe(0);
	});

	test("finds the way round when a cable that the blocked port's bridge is not on is cut", () => {
		const t = wired(3, [AB, BC, CA]);
		t.cut(AB);
		expect(t.ports()).toEqual([
			"a8 designated forwarding",
			"b7 root forwarding",
			"c7 root forwarding",
			"c8 designated forwarding",
		]);
		expect(t.roots()).toEqual(["01", "01", "01"]);
		expect([t.loops, t.now]).toEqual([0, 0]);
	});

	test("blocks again when the cable is back, with no loop at any moment", () => {
		const t = wired(3, [AB, BC, CA]);
		t.cut(CA);
		t.plug(CA);
		expect(t.ports()).toContain("c8 alternate discarding");
		expect(t.carrying()).toHaveLength(2);
		expect([t.loops, t.now]).toEqual([0, 0]);
	});
});

describe("a triangle of bridges that is steered", () => {
	test("takes a bridge whose priority is lowered for its root at once, which moves the blocked port, and takes the old one back when it is raised again", () => {
		const t = wired(3, [AB, BC, CA]);
		t.bridges[2].setPriority(4096 as BridgePriority);
		t.settle();
		expect(t.roots()).toEqual(["03", "03", "03"]);
		expect(t.bridges[2].reading()).toMatchObject({
			bridge: { priority: 4096, address: "02:00:00:00:00:03" },
			root: { priority: 4096, address: "02:00:00:00:00:03" },
			cost: 0,
		});
		expect(t.bridges[0].reading()).toMatchObject({ root: { priority: 4096 }, cost: 20_000 });
		// a and b each reach c by its own cable, and the cable between them is blocked at b, whose address is the higher.
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"a8 root forwarding",
			"b7 root forwarding",
			"b8 alternate discarding",
			"c7 designated forwarding",
			"c8 designated forwarding",
		]);
		expect([t.left, t.now]).toEqual([0, 0]);

		t.bridges[2].setPriority(DEFAULT_PRIORITY);
		t.settle();
		expect(t.roots()).toEqual(["01", "01", "01"]);
		expect(t.ports()).toContain("c8 alternate discarding");
		expect(t.left).toBe(0);
	});

	test("blocks the other port of a bridge when the cost of its root port makes that way dearer", () => {
		const t = wired(3, [AB, BC, CA]);
		t.bridges[2].setCost(7, 100_000 as PathCost);
		t.settle();
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"a8 designated forwarding",
			"b7 designated forwarding",
			"b8 root forwarding",
			"c7 alternate discarding",
			"c8 root forwarding",
		]);
		expect(t.bridges[2].reading().cost).toBe(40_000);
		expect([t.left, t.now]).toEqual([0, 0]);
		// A cost that the port had when its link went down is the one it has when the link comes back.
		t.cut(CA);
		t.plug(CA);
		expect(t.ports()).toContain("c7 alternate discarding");
	});
});

describe("the cost of the way to the root", () => {
	/** A designated port's word from bridge `from` that root 01 is `cost` away. */
	const told = (from: number, cost: number): Uint8Array =>
		encodeBpdu(
			{
				rapid: true,
				root: bridgeIdOf(32768, 0x0200_0000_0001),
				cost,
				bridge: bridgeIdOf(32768, from),
				port: 0x8001,
				role: "designated",
				proposal: false,
				agreement: false,
				learning: true,
				forwarding: true,
				topologyChange: false,
				age: 1,
				maxAge: 20,
				hello: 2,
				forwardDelay: 15,
			},
			from,
		);

	test("goes by the cheaper of two ways, however near the most that a message can say the dearer is", () => {
		const bridge = new Bridge(0x0200_0000_00f0, { send() {}, flush() {} });
		for (const port of [1, 2, 3] as const) {
			bridge.enable(port, false);
			bridge.setCost(port, 200_000_000 as PathCost);
		}
		bridge.receive(1, told(0x0200_0000_0002, 0xf000_0000), 0);
		bridge.receive(2, told(0x0200_0000_0003, 0xffff_ff00), 0);
		bridge.run(0);
		expect(bridge.reading().ports.map(({ port, role }) => `${port} ${role}`)).toEqual([
			"1 root",
			"2 designated",
			"3 designated",
		]);
		expect(bridge.reading().cost).toBe(0xf000_0000 + 200_000_000);
	});

	test("goes no higher than the most that a message can say, which is what a bridge then says", () => {
		const sent: Bpdu[] = [];
		const bridge = new Bridge(0x0200_0000_00f0, {
			send: (_port, frame) => void sent.push(decodeBpdu(frame) as Bpdu),
			flush() {},
		});
		bridge.enable(1, false);
		bridge.enable(2, false);
		bridge.setCost(1, 200_000_000 as PathCost);
		bridge.receive(1, told(0x0200_0000_0002, 0xffff_ff00), 0);
		bridge.run(0);
		expect(bridge.reading().cost).toBe(MOST_COST);
		expect(sent.findLast((bpdu) => bpdu.role === "designated")?.cost).toBe(MOST_COST);
	});
});

describe("a line of four bridges", () => {
	const CD: Cable = [2, 6, 3, 8];
	const DA: Cable = [3, 7, 0, 6];

	test("that a cable closes into a ring takes the shorter way at once: the last bridge turns round, and the ring is blocked on its far side", () => {
		const t = wired(4, [AB, BC, CD]);
		expect(t.ports()).toContain("d8 root forwarding");
		expect(t.bridges[3].reading().cost).toBe(60_000);
		t.plug(DA);
		expect(t.ports()).toEqual([
			"a6 designated forwarding",
			"a7 designated forwarding",
			"b7 designated forwarding",
			"b8 root forwarding",
			"c6 alternate discarding",
			"c8 root forwarding",
			"d7 root forwarding",
			"d8 designated forwarding",
		]);
		expect(t.bridges[3].reading().cost).toBe(20_000);
		expect([t.loops, t.now]).toEqual([0, 0]);
	});
});

describe("a ring of bridges that loses its root", () => {
	// The root hangs off b, and b, c and d are a ring.
	const ROOT: Cable = [0, 2, 1, 2];
	const RING: Cable[] = [
		[1, 7, 2, 8],
		[2, 7, 3, 8],
		[3, 7, 1, 8],
	];

	test("settles at once on a root of its own, though word of the old one goes round it until it is too old to be believed", () => {
		const t = wired(4, [ROOT, ...RING]);
		expect(t.ports()).toContain("d8 alternate discarding");
		const from = t.sent.length;
		t.cut(ROOT);
		expect(t.roots().slice(1)).toEqual(["02", "02", "02"]);
		expect(t.ports()).toEqual([
			"b7 designated forwarding",
			"b8 designated forwarding",
			"c7 designated forwarding",
			"c8 root forwarding",
			"d7 root forwarding",
			"d8 alternate discarding",
		]);
		expect([t.loops, t.now]).toEqual([0, 0]);
		// Each bridge of the ring had the old root from its neighbour, which had it from the next: counting to infinity.
		const stale = t.sent.slice(from).filter(({ bpdu }) => bpdu.root.endsWith("01"));
		expect(stale.length).toBeGreaterThan(10);
		expect(Math.max(...stale.map(({ bpdu }) => bpdu.age))).toBe(20);
	});

	test("and so does a pair of bridges on two cables, which at no moment both carry", () => {
		const pair: Cable[] = [
			[1, 7, 2, 8],
			[1, 6, 2, 6],
		];
		const t = wired(3, [ROOT, ...pair]);
		expect(t.carrying()).toHaveLength(2);
		t.cut(ROOT);
		expect(t.roots().slice(1)).toEqual(["02", "02"]);
		expect(t.ports()).toEqual([
			"b6 designated forwarding",
			"b7 designated forwarding",
			"c6 root forwarding",
			"c8 alternate discarding",
		]);
		expect([t.carrying().length, t.loops, t.now]).toEqual([1, 0, 0]);
	});

	test("and a port takes no answer that is to what it said of another root: a cable from one port of a bridge to another of its own carries at no moment", () => {
		// c has the root's cable, two cables to b, and a cable from its port 4 to its port 2.
		const own: Cable = [2, 4, 2, 2];
		const t = wired(3, [[0, 1, 2, 1], [2, 3, 1, 2], [1, 1, 2, 5], own]);
		expect(t.ports()).toContain("c4 backup discarding");
		t.cut([0, 1, 2, 1]);
		expect(t.roots().slice(1)).toEqual(["02", "02"]);
		expect(t.ports()).toContain("c4 backup discarding");
		expect([t.loops, t.now]).toEqual([0, 0]);
	});
});

describe("a bridge whose neighbour says nothing", () => {
	test("waits three seconds for an answer to its proposal, and then forwards as to a machine", () => {
		const t = wired(1);
		t.bridges[0].enable(7, false);
		t.settle();
		expect(t.ports()).toEqual(["a7 designated discarding"]);
		t.pass(EDGE_DELAY_MS - 1);
		expect(t.ports()).toEqual(["a7 designated discarding"]);
		t.pass(1);
		expect(t.ports()).toEqual(["a7 designated forwarding"]);
	});

	test("takes its place three hellos after the last it heard of it", () => {
		const t = wired(2, [AB]);
		t.pass(HELLO_MS);
		// b hears no more of a, though the link stays up: a's bridge has stopped.
		const heard = t.now;
		t.bridges[0].disable(7);
		t.pass(3 * HELLO_MS - 1);
		expect(t.roots()[1]).toBe("01");
		t.pass(1);
		expect(t.roots()[1]).toBe("02");
		expect(t.now - heard).toBe(3 * HELLO_MS);
		expect(t.ports()).toEqual(["b8 designated forwarding"]);
	});

	test("stops taking a port for a machine's when a bridge speaks on it, and blocks it if that makes a loop", () => {
		const t = wired(2, [AB]);
		// Both think the second cable is a machine's.
		t.bridges[0].enable(6, true);
		t.bridges[1].enable(6, true);
		t.settle();
		expect(t.ports()).toContain("b6 designated forwarding");
		// Now the cable is seen to join them, and their hellos cross it.
		t.plug([0, 6, 1, 6]);
		expect(t.ports()).toEqual([
			"a6 designated forwarding",
			"a7 designated forwarding",
			"b6 root forwarding",
			"b8 alternate discarding",
		]);
	});

	test("falls back on its timers when a bridge at the far end agrees to nothing: fifteen seconds discarding, fifteen learning", () => {
		const t = wired(1);
		t.bridges[0].enable(7, false);
		t.settle();
		expect(t.sent[0].bpdu.proposal).toBe(true);
		// A bridge that is heard every second keeps the port from being taken for a machine's.
		const lesser = deaf((frame) => t.bridges[0].receive(7, frame, t.now));
		const speak = () => {
			lesser.propose(t.now);
			t.settle();
		};
		for (let s = 0; s < 14; s++) {
			speak();
			t.pass(1000);
		}
		expect(t.ports()).toEqual(["a7 designated discarding"]);
		speak();
		t.pass(1000);
		expect(t.ports()).toEqual(["a7 designated learning"]);
		for (let s = 0; s < 14; s++) {
			speak();
			t.pass(1000);
		}
		expect(t.ports()).toEqual(["a7 designated learning"]);
		t.pass(1000);
		expect(t.ports()).toEqual(["a7 designated forwarding"]);
		expect(t.now).toBe(2 * FORWARD_DELAY_MS);
	});
});

describe("any wiring of bridges", () => {
	const cable = fc
		.tuple(fc.nat(4), fc.integer({ min: 1, max: 8 }), fc.nat(4), fc.integer({ min: 1, max: 8 }))
		.map(([a, portA, b, portB]): Cable => [a, portA as PortNo, b, portB as PortNo]);
	const step = fc.oneof(
		fc.record({ kind: fc.constant("plug" as const), cable }),
		fc.record({ kind: fc.constant("cut" as const), which: fc.nat(20) }),
		fc.record({ kind: fc.constant("pass" as const), ms: fc.integer({ min: 0, max: 8000 }) }),
	);

	// Not at every moment: while word of a root that is gone goes round, an answer to what a port said before can reach
	// it after it has said otherwise, and until the next message a loop carries. The protocol has no defence against
	// that, and .audit/phase2/spanning-tree/moments.mjs counts how often it happens.
	test("is never left with a loop of cables that both ends forward on, and once quiet has one way between any two bridges that are joined", () => {
		fc.assert(
			fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
				const t = wired(5);
				const up: Cable[] = [];
				const taken = (on: number, port: PortNo) =>
					up.some(([a, portA, b, portB]) => (a === on && portA === port) || (b === on && portB === port));
				for (const next of steps) {
					if (next.kind === "pass") {
						t.pass(next.ms);
					} else if (next.kind === "cut") {
						const [gone] = up.splice(next.which % Math.max(1, up.length), 1);
						if (gone) t.cut(gone);
					} else {
						const [a, portA, b, portB] = next.cable;
						if ((a === b && portA === portB) || taken(a, portA) || taken(b, portB)) continue;
						up.push(next.cable);
						t.plug(next.cable);
					}
					expect(t.left).toBe(0);
				}
				// Long enough for every timer: a port with no answer forwards after three seconds.
				t.pass(2 * FORWARD_DELAY_MS + 1000);
				expect(t.left).toBe(0);
				// The cables that carry join exactly the bridges that the cables join, and a tree has one cable fewer than bridges.
				const groups = (cables: readonly Cable[]): number => {
					const group = [0, 1, 2, 3, 4];
					const find = (i: number): number => (group[i] === i ? i : find(group[i]));
					for (const [a, , b] of cables) group[find(a)] = find(b);
					return new Set(group.map(find)).size;
				};
				expect(groups(t.carrying())).toBe(groups(up));
				expect(t.carrying()).toHaveLength(5 - groups(up));
			}),
			{ numRuns: 300 },
		);
	});
});
