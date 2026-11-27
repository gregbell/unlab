import { describe, expect, test } from "vitest";
import { conditions, seededStreams } from "../../test/support/conditions.ts";
import { arpReply, arpRequest, BROADCAST, eth, mac, ping } from "../../test/support/frames.ts";
import {
	type BridgePriority,
	type ConditionValues,
	DEFAULT_COST,
	DEFAULT_PRIORITY,
	type PathCost,
	type PortNo,
	type PortVlan,
	type Tree,
	type VlanId,
} from "../model/index.ts";
import { bridgeIdOf, decodeBpdu, encodeBpdu, isForBridges, vlanTag, withoutTag, withTag } from "../net/index.ts";
import {
	Fabric,
	type FabricOptions,
	HELD_LIMIT,
	PACE_MS,
	PACED_LIMIT,
	QUEUE_LIMIT,
	RATE_QUEUE_BYTES,
	STORM_QUIET_MS,
	type StormReading,
	type TapEvent,
} from "./fabric.ts";
import { EDGE_DELAY_MS, HELLO_MS } from "./rstp.ts";

const bit = (p: number) => 1 << (p - 1);

/** One switch, as the lab had before there were cables between switches. */
function lab(ports: readonly PortNo[]) {
	let clock = 1000;
	const taps: TapEvent[] = [];
	const fabric = new Fabric({ tap: (_, e) => taps.push(e) });
	const slot = fabric.addSwitch();
	const inbox = new Map<PortNo, Uint8Array[]>();
	for (const p of ports) {
		inbox.set(p, []);
		fabric.attach(slot, p, { deliver: (f) => inbox.get(p)?.push(f) });
	}
	const sw = {
		receive: (p: PortNo, frame: Uint8Array) => fabric.receive(slot, p, frame, clock),
		setLink: (p: PortNo, up: boolean) => fabric.setLink(slot, p, up),
		detach: (p: PortNo) => fabric.detach(slot, p),
		attach: (p: PortNo) => fabric.attach(slot, p, { deliver: () => {} }),
		isUp: (p: PortNo) => fabric.isUp(slot, p),
		macTable: () => fabric.macTable(slot, clock),
		counters: (p: PortNo) => fabric.counters(slot, p),
	};
	const received = (p: PortNo) => inbox.get(p)?.length ?? 0;
	const advance = (ms: number) => {
		clock += ms;
	};
	return { sw, taps, received, advance, last: () => taps[taps.length - 1] };
}

describe("numbered ports", () => {
	test("a broadcast floods every other port and says it was a group address", () => {
		const { sw, received, last } = lab([1, 3, 7]);
		sw.receive(1, arpRequest(1, 3));
		expect([received(1), received(3), received(7)]).toEqual([0, 1, 1]);
		expect(last()).toMatchObject({ from: 1, to: bit(3) | bit(7), flood: "group", looped: false });
	});

	test("a learned unicast goes to one port and is not a flood", () => {
		const { sw, received, last } = lab([1, 3, 7]);
		sw.receive(3, arpRequest(3, 1));
		sw.receive(1, arpReply(1, 3));
		expect(last()).toMatchObject({ from: 1, to: bit(3), flood: null });
		expect(received(7)).toBe(1);
	});

	test("a unicast to an address never seen floods as unknown", () => {
		const { sw, last } = lab([1, 2, 3]);
		sw.receive(1, ping(1, 2));
		expect(last()).toMatchObject({ from: 1, to: bit(2) | bit(3), flood: "unknown" });
	});

	test("the MAC table names the learning port", () => {
		const { sw, advance } = lab([2, 5]);
		sw.receive(5, arpRequest(4, 1));
		advance(250);
		sw.receive(2, arpRequest(1, 4));
		expect(sw.macTable()).toEqual(
			expect.arrayContaining([
				{ vlan: 1, mac: "52:54:00:88:00:0e", port: 5, seen: 1000, flushed: false },
				{ vlan: 1, mac: "52:54:00:88:00:0b", port: 2, seen: 1250, flushed: false },
			]),
		);
		expect(sw.macTable()).toHaveLength(2);
	});

	test("the tap snapshot survives a port that consumes the frame", () => {
		const taps: TapEvent[] = [];
		const fabric = new Fabric({ tap: (_, e) => taps.push(e) });
		const slot = fabric.addSwitch();
		fabric.attach(slot, 1, { deliver: () => {} });
		fabric.attach(slot, 2, { deliver: (f) => f.fill(0) });
		const frame = arpRequest(1, 2);
		const original = frame.slice();
		fabric.receive(slot, 1, frame, 0);
		expect(taps[0].frame).toEqual(original);
	});

	test("a tap that throws does not keep the frame from its port", () => {
		const fabric = new Fabric({
			tap() {
				throw new Error("broken");
			},
		});
		const slot = fabric.addSwitch();
		let got = 0;
		fabric.attach(slot, 1, { deliver: () => {} });
		fabric.attach(slot, 2, { deliver: () => void got++ });
		fabric.receive(slot, 1, arpRequest(1, 2), 0);
		fabric.receive(slot, 1, arpRequest(1, 2), 0);
		expect(got).toBe(2);
	});

	test("an attached port number cannot be attached twice", () => {
		const { sw } = lab([1]);
		expect(() => sw.attach(1)).toThrow();
	});
});

describe("a cut", () => {
	function twoLearned() {
		const t = lab([1, 2, 3]);
		t.sw.receive(1, arpRequest(1, 2));
		t.sw.receive(2, arpReply(2, 1));
		return t;
	}

	test("frames from a cut port are dropped", () => {
		const { sw, received, taps } = twoLearned();
		const before = taps.length;
		sw.setLink(2, false);
		sw.receive(2, ping(2, 1));
		expect(taps.length).toBe(before);
		expect(received(1)).toBe(1);
		expect(sw.isUp(2)).toBe(false);
	});

	test("keeps the port's MAC entries, marked flushed", () => {
		const { sw } = twoLearned();
		sw.setLink(2, false);
		expect(sw.macTable()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mac: "52:54:00:88:00:0c", port: 2, flushed: true }),
				expect.objectContaining({ mac: "52:54:00:88:00:0b", port: 1, flushed: false }),
			]),
		);
	});

	test("frames to the cut machine flood as unknown, to the ports still up", () => {
		const { sw, received, last } = twoLearned();
		sw.setLink(2, false);
		sw.receive(1, ping(1, 2));
		expect(last()).toMatchObject({ from: 1, to: bit(3), flood: "unknown" });
		expect(received(2)).toBe(1);
	});

	test("reconnecting does not relearn until the machine speaks", () => {
		const { sw, last } = twoLearned();
		sw.setLink(2, false);
		sw.setLink(2, true);
		sw.receive(1, ping(1, 2));
		expect(last()).toMatchObject({ to: bit(2) | bit(3), flood: "unknown" });
		expect(sw.macTable()).toEqual(expect.arrayContaining([expect.objectContaining({ port: 2, flushed: true })]));

		sw.receive(2, ping(2, 1, 1, 0));
		expect(sw.macTable()).toEqual(expect.arrayContaining([expect.objectContaining({ port: 2, flushed: false })]));
		sw.receive(1, ping(1, 2));
		expect(last()).toMatchObject({ to: bit(2), flood: null });
	});

	test("a flushed address relearned on another port moves there", () => {
		const { sw } = twoLearned();
		sw.setLink(2, false);
		sw.receive(3, ping(2, 1));
		const entry = sw.macTable().find((e) => e.mac === "52:54:00:88:00:0c");
		expect(entry).toMatchObject({ port: 3, flushed: false });
	});

	test("detach deletes the port's entries, flushed or not", () => {
		const { sw } = twoLearned();
		sw.setLink(2, false);
		sw.detach(2);
		sw.detach(1);
		expect(sw.macTable()).toEqual([]);
	});

	test("idle entries age out, flushed ones stay", () => {
		const t = lab([1, 2]);
		t.sw.receive(1, arpRequest(1, 2));
		t.sw.receive(2, arpReply(2, 1));
		t.sw.setLink(2, false);
		t.advance(10 * 60_000);
		t.sw.receive(1, arpRequest(3, 1));
		expect(t.sw.macTable().map((e) => [e.mac, e.port, e.flushed])).toEqual(
			expect.arrayContaining([
				["52:54:00:88:00:0c", 2, true],
				["52:54:00:88:00:0d", 1, false],
			]),
		);
		expect(t.sw.macTable()).toHaveLength(2);
	});

	test("an address that has not been heard for five minutes is flooded to, and no longer in the table", () => {
		const t = lab([1, 2, 3]);
		t.sw.receive(1, arpRequest(1, 2));
		t.sw.receive(2, arpReply(2, 1));
		t.advance(4 * 60_000);
		t.sw.receive(1, ping(1, 2));
		expect(t.last()).toMatchObject({ to: bit(2), flood: null });
		t.advance(5 * 60_000 + 1);
		t.sw.receive(1, ping(1, 2));
		expect(t.last()).toMatchObject({ to: bit(2) | bit(3), flood: "unknown" });
		expect(t.sw.macTable().map((e) => e.mac)).toEqual(["52:54:00:88:00:0b"]);
	});
});

describe("counters", () => {
	test("per-port counters count frames in, out and flooded", () => {
		const { sw } = lab([1, 2, 3]);
		sw.receive(1, arpRequest(1, 2));
		expect(sw.counters(1)).toMatchObject({ rxFrames: 1, flooded: 1 });
		expect(sw.counters(2)).toMatchObject({ txFrames: 1 });
		expect(sw.counters(4)).toBeUndefined();
	});
});

type Letter = "a" | "b" | "c" | "d";

/**
 * Switches by letter, each with machine n on its port 1 (a has node1, b node2
 * and so on), and cables written `a8-b7`. Time is the test's.
 */
function net(letters: readonly Letter[], cables: readonly string[], options: FabricOptions = {}) {
	const taps: { on: Letter; at: number; e: TapEvent }[] = [];
	const storms: { on: Letter; over: boolean; reading: StormReading }[] = [];
	const trees: { on: Letter; reading: Tree }[] = [];
	const slots = new Map<Letter, number>();
	const names: Letter[] = [];
	let now = 0;
	const fabric = new Fabric(
		{
			tap: (slot, e) => taps.push({ on: names[slot], at: now, e }),
			storm: (slot, reading, over) => storms.push({ on: names[slot], over, reading }),
			tree: (slot, reading) => trees.push({ on: names[slot], reading }),
		},
		options,
	);
	const got = new Map<Letter, Uint8Array[]>();
	for (const letter of letters) {
		const slot = fabric.addSwitch();
		slots.set(letter, slot);
		names[slot] = letter;
		got.set(letter, []);
		fabric.attach(slot, 1, { deliver: (f) => got.get(letter)?.push(f) });
	}
	const slot = (letter: Letter) => slots.get(letter) as number;
	const end = (text: string) => ({ slot: slot(text[0] as Letter), port: Number(text[1]) as PortNo });
	for (const cable of cables) {
		const [from, to] = cable.split("-");
		fabric.cable(end(from), end(to));
	}
	const t = {
		fabric,
		taps,
		storms,
		slot,
		end,
		get now() {
			return now;
		},
		/** The machine on the switch puts a frame on the wire. */
		send: (on: Letter, frame: Uint8Array) => fabric.receive(slot(on), 1, frame, now),
		/** What the machine on the switch has been handed. */
		got: (on: Letter) => got.get(on)?.length ?? 0,
		/** The number of each ping that the machine on the switch has been handed, in the order they came. */
		pings: (on: Letter) => (got.get(on) ?? []).map((frame) => (frame[40] << 8) | frame[41]),
		/** Gives a cable its conditions as the lab does: at the port a NIC's is in, and at both ports of one between switches. */
		impair(cable: string, values: ConditionValues) {
			for (const at of cable.split("-")) fabric.setConditions(end(at).slot, end(at).port, conditions(values));
		},
		/** What the cable has carried, by a port that it is in. */
		carried: (at: string) => fabric.carried(end(at).slot, end(at).port),
		/** Carries everything that is due now. */
		drain() {
			while (fabric.drain(now, 64) > 0);
		},
		/** Lets time pass with nothing carried, as when the page is kept busy by something else. */
		stall(ms: number) {
			now += ms;
		},
		/** Lets time pass a millisecond at a time, carrying what is due at each. */
		run(ms: number) {
			for (const until = now + ms; now < until; now += 1) t.drain();
			t.drain();
		},
		table: (on: Letter) =>
			Object.fromEntries(
				fabric.macTable(slot(on), now).map((e) => [e.mac.slice(-2), e.flushed ? `${e.port} flushed` : e.port]),
			),
		cut: (text: string, up = false) => fabric.setLink(end(text).slot, end(text).port, up),
		storming: () => letters.filter((letter) => fabric.storm(slot(letter), now) !== null),
		/** The switches that tapped a frame, in order. */
		path: () => taps.map(({ on }) => on).join(""),
		trees,
		/**
		 * Turns spanning tree on for the switches, or off. Each has an address in the order of the letters, so of the
		 * switches of a tree the first is its root.
		 */
		stp(on: readonly Letter[], run = true) {
			for (const letter of on) {
				fabric.setTree(slot(letter), run ? { address: 0x0200_0000_0001 + letters.indexOf(letter) } : null);
			}
			t.drain();
		},
		/** `c8 alternate discarding`, for each port that a cable to a switch is in and the tree has, lowest first. */
		ports: () =>
			letters.flatMap((letter) =>
				(fabric.tree(slot(letter))?.ports ?? [])
					.filter(({ port }) => port !== 1)
					.map(({ port, role, state }) => `${letter}${port} ${role} ${state}`),
			),
		/** What the machine on the switch has been handed, but for the spanning tree's messages. */
		heard: (on: Letter) => (got.get(on) ?? []).filter((frame) => !isForBridges(frame)),
		/** The spanning tree's messages that the machine on the switch has been handed. */
		hellos: (on: Letter) => (got.get(on) ?? []).filter(isForBridges),
		/** The frames that the switches took in, but for the spanning tree's messages. */
		took: () => taps.filter(({ e }) => !isForBridges(e.frame)),
	};
	return t;
}

const NODE = { 1: "0b", 2: "0c", 3: "0d", 4: "0e" } as const;
const TRIANGLE = ["a7-b8", "b7-c8", "c7-a8"] as const;
const MESH = ["a6-b6", "a7-c7", "a8-d8", "b7-c6", "b8-d7", "c8-d6"] as const;

describe("a cable between two switches", () => {
	test("carries a frame when it is drained, after the first switch has tapped it", () => {
		const t = net(["a", "b"], ["a8-b8"]);
		t.send("a", arpRequest(1, 2));
		expect([t.got("b"), t.path(), t.fabric.waiting]).toEqual([0, "a", 1]);
		t.drain();
		expect([t.got("b"), t.path(), t.fabric.waiting]).toEqual([1, "ab", 0]);
		expect(t.taps.map(({ e }) => [e.from, e.to, e.looped])).toEqual([
			[1, bit(8), false],
			[8, bit(1), false],
		]);
	});

	test("lets each switch learn the far machine on the cable's port, and forward to it there", () => {
		const t = net(["a", "b"], ["a8-b7"]);
		t.send("a", arpRequest(1, 2));
		t.drain();
		t.send("b", arpReply(2, 1));
		t.drain();
		expect(t.table("a")).toEqual({ [NODE[1]]: 1, [NODE[2]]: 8 });
		expect(t.table("b")).toEqual({ [NODE[2]]: 1, [NODE[1]]: 7 });
		t.send("a", ping(1, 2));
		t.drain();
		expect(t.taps.slice(-2).map(({ on, e }) => [on, e.to, e.flood])).toEqual([
			["a", bit(8), null],
			["b", bit(1), null],
		]);
		expect([t.got("a"), t.got("b")]).toEqual([1, 2]);
	});

	test("that is cut flushes what both switches learned over it and loses what waited in it, at whichever end it is cut", () => {
		for (const end of ["a8", "b7"]) {
			const t = net(["a", "b"], ["a8-b7"]);
			t.send("a", arpRequest(1, 2));
			t.drain();
			t.send("b", arpReply(2, 1));
			t.drain();
			t.send("a", ping(1, 2));
			t.cut(end);
			expect(t.fabric.waiting, end).toBe(0);
			expect(t.table("a"), end).toEqual({ [NODE[1]]: 1, [NODE[2]]: "8 flushed" });
			expect(t.table("b"), end).toEqual({ [NODE[2]]: 1, [NODE[1]]: "7 flushed" });
			t.send("a", ping(1, 2));
			t.drain();
			expect(t.got("b"), end).toBe(1);

			t.cut(end, true);
			t.send("a", ping(1, 2));
			t.drain();
			expect(t.got("b"), end).toBe(2);
			t.send("b", ping(2, 1, 1, 0));
			t.drain();
			expect(t.table("a"), end).toEqual({ [NODE[1]]: 1, [NODE[2]]: 8 });
		}
	});

	test("that is taken out frees both its ports, and each switch forgets what it learned over it", () => {
		const t = net(["a", "b"], ["a8-b7"]);
		t.send("a", arpRequest(1, 2));
		t.drain();
		t.send("b", arpReply(2, 1));
		t.send("a", ping(1, 2));
		t.fabric.detach(t.slot("b"), 7);
		expect([t.fabric.waiting, t.fabric.farEnd(t.slot("a"), 8), t.fabric.counters(t.slot("a"), 8)]).toEqual([
			0,
			null,
			undefined,
		]);
		expect([t.table("a"), t.table("b")]).toEqual([{ [NODE[1]]: 1 }, { [NODE[2]]: 1 }]);
		t.drain();
		expect(t.got("a")).toBe(0);
		t.fabric.cable(t.end("a8"), t.end("b7"));
		t.send("a", arpRequest(1, 2));
		t.drain();
		expect(t.got("b")).toBe(2);
	});

	test("that is full drops what does not fit and counts it, and keeps no other cable waiting", () => {
		const t = net(["a", "b", "c"], ["a8-b8", "c8-b7"]);
		for (let i = 0; i < QUEUE_LIMIT + 5; i++) t.send("a", arpRequest(1, 2));
		expect(t.fabric.waiting).toBe(QUEUE_LIMIT);
		expect(t.fabric.totals(t.slot("a"))).toMatchObject({ in: QUEUE_LIMIT + 5, delivered: QUEUE_LIMIT, dropped: 5 });
		expect(t.fabric.counters(t.slot("a"), 8)).toMatchObject({ txFrames: QUEUE_LIMIT, dropped: 5 });

		t.send("c", arpRequest(3, 2));
		// Two turns: one frame from each cable, however many wait in the first.
		expect(t.fabric.drain(t.now, 2)).toBe(2);
		expect(t.taps.slice(-2).map(({ on, e }) => [on, e.from])).toEqual([
			["b", 8],
			["b", 7],
		]);
	});

	test("can be one of several between the same two switches, and can have both its ends in one", () => {
		const two = net(["a", "b"], ["a7-b7", "a8-b8"]);
		expect([two.fabric.farEnd(two.slot("a"), 7), two.fabric.farEnd(two.slot("a"), 8)]).toEqual([
			{ slot: two.slot("b"), port: 7 },
			{ slot: two.slot("b"), port: 8 },
		]);
		const one = net(["a"], ["a7-a8"]);
		expect(one.fabric.farEnd(one.slot("a"), 7)).toEqual({ slot: one.slot("a"), port: 8 });
		expect(() => one.fabric.cable(one.end("a2"), one.end("a2"))).toThrow();
	});
});

describe("a loop of cables", () => {
	test("does not recurse: one broadcast goes round for as long as the loop is whole, at no more than its pace", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		t.send("a", arpRequest(1, 9));
		t.run(1000);
		// One copy goes each way round, a hop a millisecond.
		const looped = () => t.taps.filter(({ e }) => e.looped).length;
		expect(looped()).toBeGreaterThan(1900);
		expect(looped()).toBeLessThanOrEqual((2 * 1000) / PACE_MS + 6);
		expect(t.got("b")).toBeGreaterThan(600);
		expect(new Set(t.taps.map(({ e }) => Buffer.from(e.frame).toString("hex"))).size).toBe(1);

		const second = looped();
		t.run(1000);
		expect(looped() - second).toBeGreaterThan(1900);

		// However many broadcasts go round, each of the six directions lets one through a millisecond.
		for (let i = 0; i < 200; i++) t.send("a", arpRequest(1, 9));
		t.run(100);
		const full = looped();
		t.run(1000);
		expect(looped() - full).toBeGreaterThan(5700);
		expect(looped() - full).toBeLessThanOrEqual((6 * 1000) / PACE_MS + 6);
	});

	test("marks a frame as looped from where it comes back to a switch that it had left, which a copy that came into a switch after another does in its turn", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		t.send("a", arpRequest(1, 9));
		t.drain();
		const rows = () => t.taps.map(({ on, e }) => `${on}${e.from}${e.looped ? " looped" : ""}`);
		// Out of a to b and c, and on from each to the other, which a copy from a had come into.
		expect(rows()).toEqual(["a1", "b8", "c7", "c8", "b7"]);
		expect(t.fabric.waiting).toBe(2);
		// What those two send back to a waits a millisecond.
		t.run(1);
		expect(rows().slice(5, 7).sort()).toEqual(["a7 looped", "a8 looped"]);
		t.run(5);
		expect(t.taps.slice(7).every(({ e }) => e.looped)).toBe(true);
	});

	test("makes every switch that looped frames come into storm, with their rate: those on the loop, and one beyond it", () => {
		const t = net(["a", "b", "c", "d"], [...TRIANGLE, "c2-d8"]);
		expect(t.storming()).toEqual([]);
		for (let i = 0; i < 200; i++) t.send("a", arpRequest(1, 9));
		t.run(1500);
		expect(t.storming()).toEqual(["a", "b", "c", "d"]);
		expect(t.storms.map(({ on, over }) => [on, over]).sort()).toEqual([
			["a", false],
			["b", false],
			["c", false],
			["d", false],
		]);
		const came = (on: Letter, since: number) =>
			t.taps.filter((tap) => tap.on === on && tap.e.looped && tap.at > since).length;
		for (const on of ["a", "b", "c"] as const) {
			const reading = t.fabric.storm(t.slot(on), t.now);
			// Its rate is the looped frames of the last second.
			expect(Math.abs((reading?.rate ?? 0) - came(on, t.now - 1000)), on).toBeLessThan(20);
			// Two cables bring them, a thousand a second each.
			expect(reading?.rate, on).toBeGreaterThan(1700);
			expect(reading?.rate, on).toBeLessThanOrEqual(2000);
			expect(reading?.looped, on).toBe(came(on, -1));
			expect(reading?.since, on).toBeLessThan(5);
		}
		// The switch beyond the loop is handed the same frames, at the pace of its one cable.
		const beyond = t.fabric.storm(t.slot("d"), t.now);
		expect(beyond?.rate).toBeGreaterThan(900);
		expect(beyond?.rate).toBeLessThanOrEqual(1000);
		expect(beyond?.looped).toBe(came("d", -1));
	});

	test("reads a rate no higher than its cables' pace, whenever it is read", () => {
		/** Carries what is due after each gap, as a page does that gets to it when it can, and reads every rate. */
		const highest = (t: ReturnType<typeof net>, letters: readonly Letter[], ms: number, gaps = [1]) => {
			const most = Object.fromEntries(letters.map((on) => [on, 0]));
			for (let i = 0; t.now < ms; i++) {
				t.stall(gaps[i % gaps.length]);
				t.drain();
				for (const on of letters) most[on] = Math.max(most[on], t.fabric.storm(t.slot(on), t.now)?.rate ?? 0);
			}
			return most;
		};
		// The first copies of the broadcast are not paced, and a second later they are out of the rate.
		const mesh = net(["a", "b", "c", "d"], MESH);
		mesh.send("a", arpRequest(1, 9));
		mesh.run(1500);
		// Three cables bring each switch a thousand looped frames a second each, and the mesh keeps all three full.
		expect(highest(mesh, ["a", "b", "c", "d"], 2500)).toEqual({ a: 3000, b: 3000, c: 3000, d: 3000 });

		const late = net(["a", "b", "c", "d"], MESH);
		late.send("a", arpRequest(1, 9));
		late.run(1500);
		expect(highest(late, ["a", "b", "c", "d"], 3500, [0.3, 1.7, 0.6, 1.4, 1.3])).toEqual({
			a: 3000,
			b: 3000,
			c: 3000,
			d: 3000,
		});

		// Both ways round one cable, from the first frame that comes back: a storm younger than a second too.
		const one = net(["a"], ["a7-a8"]);
		one.send("a", arpRequest(1, 9));
		expect(highest(one, ["a"], 1500)).toEqual({ a: 2000 });
	});

	test("drops and counts what does not fit behind the pace, and never has more waiting than its bound", () => {
		const t = net(["a", "b", "c", "d"], MESH);
		t.send("a", arpRequest(1, 9));
		let most = 0;
		for (let i = 0; i < 100; i++) {
			t.run(10);
			most = Math.max(most, t.fabric.waiting);
		}
		expect(most).toBeLessThanOrEqual(12 * PACED_LIMIT);
		for (const on of ["a", "b", "c", "d"] as const) {
			const { dropped } = t.fabric.totals(t.slot(on));
			// Three cables bring a thousand a second each, and each is to go out of the other two.
			expect(dropped, on).toBeGreaterThan(2000);
			expect(t.fabric.storm(t.slot(on), t.now)?.dropped, on).toBe(dropped);
		}
	});

	test("slows nothing else: a frame that has not looped overtakes those that wait for their turn", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		t.send("b", arpRequest(2, 1));
		t.drain();
		for (let i = 0; i < 200; i++) t.send("a", arpRequest(1, 9));
		t.run(50);
		expect(t.fabric.waiting).toBeGreaterThan(100);
		// No time passes, so nothing that waits for its turn can move, and this frame still crosses a cable.
		const sent = ping(1, 2);
		t.send("a", sent);
		t.drain();
		const carried = t.taps.filter(({ e, at }) => at === t.now && !e.looped && e.frame.length === sent.length);
		expect(carried.map(({ on }) => on).filter((on) => on !== "a")).not.toEqual([]);
		expect(t.fabric.waiting).toBeGreaterThan(100);
	});

	test("ends when a cable of it is cut: no frame is left, and after a tenth of a second each switch has forgotten its table", () => {
		const t = net(["a", "b", "c", "d"], [...TRIANGLE, "c2-d8"]);
		t.send("d", arpRequest(4, 9));
		t.run(300);
		// The loop has taught d that its own machine is behind its cable.
		expect(t.table("d")).toEqual({ [NODE[4]]: 8 });
		expect(t.storming()).toEqual(["a", "b", "c", "d"]);

		t.cut("b7");
		const cutAt = t.now;
		t.run(20);
		const last = t.taps.length;
		expect(t.fabric.waiting).toBe(0);
		expect(t.storming()).toEqual(["a", "b", "c", "d"]);
		t.run(STORM_QUIET_MS);
		expect(t.taps.length).toBe(last);
		expect(t.storming()).toEqual([]);
		const over = t.storms.filter(({ over }) => over);
		expect(over.map(({ on }) => on).sort()).toEqual(["a", "b", "c", "d"]);
		for (const { reading } of over) expect(reading.looped).toBeGreaterThan(150);
		expect([t.table("a"), t.table("b"), t.table("c"), t.table("d")]).toEqual([{}, {}, {}, {}]);
		expect(t.now - cutAt).toBeLessThan(200);

		// What is left is a line of switches, and frames cross it once.
		t.send("a", arpRequest(1, 2));
		t.drain();
		expect(t.taps.slice(last).map(({ on, e }) => `${on}${e.looped ? " looped" : ""}`)).toEqual(["a", "b", "c", "d"]);
	});

	test("is still a storm after the page was kept from it for longer than a storm takes to end", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		t.send("a", arpRequest(1, 9));
		t.send("b", arpReply(2, 1));
		t.run(200);
		t.stall(5 * STORM_QUIET_MS);
		// The frames that waited are what comes next, not the end of a quiet that there was not.
		expect(t.fabric.next()).toBeLessThanOrEqual(t.now);
		t.drain();
		expect(t.fabric.next()).toBeGreaterThan(t.now);
		t.run(50);
		expect(t.storms.filter(({ over }) => over)).toEqual([]);
		expect(t.storming()).toEqual(["a", "b", "c"]);
		expect(t.storms).toHaveLength(3);
	});

	test("of a mesh storms on while any loop is whole", () => {
		const t = net(["a", "b", "c", "d"], MESH);
		t.send("a", arpRequest(1, 9));
		t.run(200);
		t.cut("a6");
		t.run(300);
		expect(t.storming()).toEqual(["a", "b", "c", "d"]);
		// The loop of b, c and d is still whole, and a hangs off it by one cable, which brings it the storm.
		t.cut("a8");
		t.run(300);
		expect(t.storming()).toEqual(["a", "b", "c", "d"]);
		// What is left is a line: a to c, c to d, d to b.
		t.cut("b7");
		t.run(300);
		expect(t.storming()).toEqual([]);
	});

	test("of one switch and one cable storms too", () => {
		const t = net(["a"], ["a7-a8"]);
		t.send("a", arpRequest(1, 9));
		t.run(500);
		expect(t.storming()).toEqual(["a"]);
		expect(t.fabric.storm(t.slot("a"), t.now)?.rate).toBeGreaterThan(900);
		t.cut("a7");
		t.run(150);
		expect(t.storming()).toEqual([]);
	});

	test("says when it next has something to do: now, when the next frame is due, or when a storm has been quiet", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		expect([t.fabric.next(), t.fabric.busy]).toEqual([-1, false]);
		t.send("a", arpRequest(1, 9));
		expect([t.fabric.next(), t.fabric.busy]).toEqual([0, true]);
		t.drain();
		// The frames that came back wait for their turn, a millisecond from now.
		expect(t.fabric.next()).toBe(t.now + PACE_MS);
		t.run(20);
		t.cut("a7");
		t.cut("b7");
		t.cut("c7");
		t.run(1);
		const quiet = t.fabric.next();
		expect(quiet).toBeGreaterThan(t.now);
		expect(quiet).toBeLessThanOrEqual(t.now + STORM_QUIET_MS);
		t.run(STORM_QUIET_MS);
		expect([t.fabric.next(), t.fabric.busy]).toEqual([-1, false]);
	});

	test("goes with a switch that is removed, and a switch in its place starts with nothing", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		t.send("a", arpRequest(1, 9));
		t.run(100);
		const looped = t.taps.filter(({ on, e }) => on === "b" && e.looped).length;
		t.fabric.removeSwitch(t.slot("b"), t.now);
		// Its storm is over as it goes, with what it came to, and the others' when they have been quiet.
		expect(t.storms.filter(({ over }) => over)).toMatchObject([{ on: "b", reading: { looped } }]);
		t.run(200);
		expect(t.storming()).toEqual([]);
		expect(t.storms.filter(({ over }) => over).map(({ on }) => on)).toEqual(["b", "a", "c"]);
		expect([t.fabric.farEnd(t.slot("a"), 7), t.fabric.farEnd(t.slot("c"), 8)]).toEqual([null, null]);
		expect(t.fabric.addSwitch()).toBe(t.slot("b"));
		expect(t.fabric.totals(t.slot("b"))).toEqual({ in: 0, delivered: 0, flooded: 0, dropped: 0 });
		expect(t.fabric.macTable(t.slot("b"), t.now)).toEqual([]);
	});
});

const access = (vlan: number): PortVlan => ({ mode: "access", vlan: vlan as VlanId });
const trunk = (allowed: readonly number[] | "all", native = 1): PortVlan => ({
	mode: "trunk",
	allowed: allowed === "all" ? "all" : (allowed as VlanId[]),
	native: native as VlanId,
});

/**
 * Machines written `a1:10`: machine 1 on port 1 of switch a, in VLAN 10. A
 * port written with no VLAN is in VLAN 1, as a new one is. Cables as `net`
 * writes them, with each end's setting after it: `a8-b8 trunk`.
 */
function vlanNet(machines: readonly string[], cables: readonly (readonly [string, PortVlan?, PortVlan?])[] = []) {
	const letters = [...new Set([...machines, ...cables.flatMap(([c]) => c.split("-"))].map((text) => text[0]))].sort();
	const taps: { on: string; e: TapEvent }[] = [];
	const names: string[] = [];
	const fabric = new Fabric({ tap: (slot, e) => taps.push({ on: names[slot], e }) });
	const slots = new Map<string, number>();
	for (const letter of letters) {
		const slot = fabric.addSwitch();
		slots.set(letter, slot);
		names[slot] = letter;
	}
	const at = (text: string) => ({ slot: slots.get(text[0]) as number, port: Number(text[1]) as PortNo });
	const got = new Map<number, Uint8Array[]>();
	const where = new Map<number, string>();
	for (const text of machines) {
		const [place, vlan] = text.split(":");
		const n = Number(place[1]) + (place.charCodeAt(0) - 97) * 8;
		got.set(n, []);
		where.set(n, place);
		fabric.attach(at(place).slot, at(place).port, { deliver: (f) => got.get(n)?.push(f) });
		if (vlan) fabric.setVlan(at(place).slot, at(place).port, access(Number(vlan)));
	}
	for (const [cable, near, far] of cables) {
		const [a, b] = cable.split("-");
		fabric.cable(at(a), at(b));
		if (near) fabric.setVlan(at(a).slot, at(a).port, near);
		if (far ?? near) fabric.setVlan(at(b).slot, at(b).port, (far ?? near) as PortVlan);
	}
	let now = 0;
	const t = {
		fabric,
		taps,
		at,
		/** Machine n, which is on port n of a, or port n - 8 of b, puts a frame on the wire. */
		send(n: number, frame: Uint8Array) {
			const { slot, port } = at(where.get(n) as string);
			fabric.receive(slot, port, frame, now);
			t.run(5);
		},
		run(ms: number) {
			for (const until = now + ms; now < until; now += 1) while (fabric.drain(now, 64) > 0);
		},
		/** Which machines have been handed a frame, and how many. */
		reached: () =>
			Object.fromEntries([...got].filter(([, frames]) => frames.length > 0).map(([n, f]) => [n, f.length])),
		last: (n: number) => got.get(n)?.at(-1),
		clear() {
			for (const frames of got.values()) frames.length = 0;
			taps.length = 0;
		},
		storming: (letter: string) => fabric.storm(slots.get(letter) as number, now) !== null,
		cut: (text: string) => fabric.setLink(at(text).slot, at(text).port, false),
		table: (letter: string) =>
			fabric
				.macTable(slots.get(letter) as number, now)
				.map((e) => `${e.mac.slice(-2)} vlan ${e.vlan} at ${e.port}`)
				.sort(),
	};
	return t;
}

/** Machine n of b, which is on its port n. */
const B = 8;

describe("VLANs", () => {
	test("a new port is in VLAN 1, and a broadcast on an access port reaches only the ports of its VLAN", () => {
		const t = vlanNet(["a1:10", "a2:10", "a3:20", "a4", "a5"]);
		t.send(1, arpRequest(1, 9));
		expect(t.reached()).toEqual({ 2: 1 });
		expect(t.taps.at(-1)?.e).toMatchObject({ from: 1, to: bit(2), flood: "group", vlan: 10, tagged: 0 });
		t.clear();
		t.send(3, arpRequest(3, 9));
		expect(t.reached()).toEqual({});
		t.send(4, arpRequest(4, 9));
		expect(t.reached()).toEqual({ 5: 1 });
		expect(t.taps.at(-1)?.e).toMatchObject({ vlan: 1 });
	});

	test("learns addresses per VLAN, so a frame for a machine of another VLAN is flooded in its own, and never reaches it", () => {
		const t = vlanNet(["a1:10", "a2:10", "a3:20", "a4:20"]);
		t.send(1, arpRequest(1, 3));
		t.send(3, ping(3, 1));
		expect(t.table("a")).toEqual(["0b vlan 10 at 1", "0d vlan 20 at 3"]);
		expect(t.taps.at(-1)?.e).toMatchObject({ from: 3, to: bit(4), flood: "unknown", vlan: 20 });
		expect(t.reached()).toEqual({ 2: 1, 4: 1 });
	});

	test("a port put in another VLAN forgets what the switch learned on it", () => {
		const t = vlanNet(["a1", "a2"]);
		t.send(1, arpRequest(1, 2));
		t.fabric.setVlan(t.at("a1").slot, 1, access(10));
		expect(t.table("a")).toEqual([]);
	});

	test("a trunk carries each VLAN tagged and its native one untagged, and the far switch puts each back in its VLAN, untagged to its machines", () => {
		const t = vlanNet(["a1:10", "a2:20", "a3", "b1:10", "b2:20", "b3"], [["a8-b8", trunk("all")]]);
		const sent = arpRequest(1, 9);
		t.send(1, sent);
		expect(t.reached()).toEqual({ [B + 1]: 1 });
		expect(t.last(B + 1)).toEqual(sent);
		expect(t.taps.map(({ on, e }) => [on, e.from, e.to, e.vlan, e.tagged])).toEqual([
			["a", 1, bit(8), 10, bit(8)],
			["b", 8, bit(1), 10, bit(8)],
		]);
		expect(t.taps.every(({ e }) => vlanTag(e.frame) === null && e.frame.length === sent.length)).toBe(true);
		t.clear();
		t.send(2, arpRequest(2, 9));
		expect(t.reached()).toEqual({ [B + 2]: 1 });
		t.clear();
		t.send(3, arpRequest(3, 9));
		expect(t.reached()).toEqual({ [B + 3]: 1 });
		expect(t.taps.map(({ e }) => [e.vlan, e.tagged])).toEqual([
			[1, 0],
			[1, 0],
		]);
	});

	test("puts the tag on the wire: 0x8100, then the VLAN, and the frame's own type after it", () => {
		const frames: Uint8Array[] = [];
		const t = vlanNet(["a1:10"]);
		t.fabric.attach(t.at("a8").slot, 8, { deliver: (f) => frames.push(f) });
		t.fabric.setVlan(t.at("a8").slot, 8, trunk([10, 20]));
		const sent = arpRequest(1, 9);
		t.send(1, sent);
		expect(Array.from(frames[0].subarray(12, 18))).toEqual([0x81, 0x00, 0x00, 10, 0x08, 0x06]);
		expect(frames[0].length).toBe(sent.length + 4);
		expect(withoutTag(frames[0])).toEqual(sent);
	});

	test("a VLAN that a trunk does not allow does not cross it, whichever end leaves it out", () => {
		const near = vlanNet(["a1:10", "a2:20", "b1:10", "b2:20"], [["a8-b8", trunk([10]), trunk("all")]]);
		near.send(2, arpRequest(2, 9));
		expect([near.reached(), near.fabric.waiting]).toEqual([{}, 0]);
		near.send(1, arpRequest(1, 9));
		expect(near.reached()).toEqual({ [B + 1]: 1 });

		const far = vlanNet(["a1:10", "a2:20", "b1:10", "b2:20"], [["a8-b8", trunk("all"), trunk([10])]]);
		far.send(2, arpRequest(2, 9));
		expect(far.reached()).toEqual({});
		expect(far.fabric.counters(far.at("b8").slot, 8)).toMatchObject({ rxFrames: 1, dropped: 1 });
	});

	test("a trunk takes a tag of VLAN 0, which gives only a priority, as no tag, and drops one of VLAN 4095, which is reserved", () => {
		const t = vlanNet(["a1:20", "a2"]);
		const { slot } = t.at("a8");
		t.fabric.attach(slot, 8, { deliver: () => {} });
		t.fabric.setVlan(slot, 8, trunk("all", 20));
		const sent = arpRequest(9, 1);
		t.fabric.receive(slot, 8, withTag(sent, 0), 0);
		expect(t.reached()).toEqual({ 1: 1 });
		expect(t.last(1)).toEqual(sent);
		expect(t.taps.map(({ e }) => [e.vlan, e.tagged])).toEqual([[20, 0]]);
		t.clear();
		t.fabric.receive(slot, 8, withTag(sent, 4095), 0);
		expect([t.reached(), t.taps]).toEqual([{}, []]);
		expect(t.fabric.counters(slot, 8)).toMatchObject({ rxFrames: 2, dropped: 1 });
	});

	test("an access port takes a frame tagged with its own VLAN, or with VLAN 0, without the tag, and drops one tagged with another, as real switches do", () => {
		const t = vlanNet(["a1:10", "a2:10", "a3:20"]);
		const sent = arpRequest(1, 9);
		t.send(1, withTag(sent, 10));
		expect(t.reached()).toEqual({ 2: 1 });
		expect(t.last(2)).toEqual(sent);
		expect(t.taps.map(({ e }) => [e.vlan, e.tagged, e.frame.length])).toEqual([[10, bit(1), sent.length]]);
		t.send(1, withTag(sent, 0));
		expect(t.reached()).toEqual({ 2: 2 });
		expect(t.last(2)).toEqual(sent);
		t.clear();
		t.send(1, withTag(sent, 20));
		expect([t.reached(), t.taps]).toEqual([{}, []]);
		expect(t.fabric.counters(t.at("a1").slot, 1)).toMatchObject({ rxFrames: 3, dropped: 1 });
	});

	test.each([
		["of one switch", ["a1:10", "a2:10", "a3:20"], [["a7-a8", trunk("all"), access(10)]]],
		[
			"of another switch, beside a cable in that VLAN",
			["a1:10", "a2:10", "a3:20"],
			[
				["a7-b7", trunk("all"), access(10)],
				["a8-b8", access(10)],
			],
		],
	] as const)(
		"a cable from a trunk to an access port %s loops the port's VLAN with every frame as long as it was sent, and drops the others at the access port",
		(_, machines, cables) => {
			const t = vlanNet(machines, cables);
			const far = t.at(cables[0][0].slice(3));
			t.send(3, arpRequest(3, 9));
			expect(t.taps.map(({ on, e }) => `${on}${e.from} vlan ${e.vlan}`)).toEqual(["a3 vlan 20"]);
			expect(t.fabric.counters(far.slot, far.port)).toMatchObject({ rxFrames: 1, dropped: 1 });

			const sent = arpRequest(1, 9);
			t.send(1, sent);
			t.run(1000);
			expect(t.taps.filter(({ e }) => e.looped).length).toBeGreaterThan(900);
			expect(Math.max(...t.taps.map(({ e }) => e.frame.length))).toBe(sent.length);
			expect(t.last(2)).toEqual(sent);
			expect(t.storming("a")).toBe(true);
			t.cut("a7");
			t.run(STORM_QUIET_MS * 2);
			expect(t.storming("a")).toBe(false);
		},
	);

	test("a port takes a frame of up to 1,514 bytes, or 1,518 with its tag, and drops and counts a longer one", () => {
		const t = vlanNet(["a1:10", "b1:10"], [["a8-b8", trunk("all")]]);
		const { slot } = t.at("a1");
		const ofPayload = (bytes: number) => eth(BROADCAST, mac(1), 0x0800, new Uint8Array(bytes));
		const longest = ofPayload(1500);
		expect(longest.length).toBe(1514);
		t.send(1, longest);
		expect(t.last(B + 1)).toEqual(longest);
		expect(t.taps.map(({ on, e }) => [on, e.tagged])).toEqual([
			["a", bit(8)],
			["b", bit(8)],
		]);
		t.send(1, withTag(longest, 10));
		expect(t.reached()).toEqual({ [B + 1]: 2 });
		expect(t.fabric.counters(slot, 1)).toMatchObject({ rxFrames: 2, dropped: 0 });

		t.clear();
		t.send(1, ofPayload(1501));
		t.send(1, withTag(ofPayload(1501), 10));
		expect([t.reached(), t.taps]).toEqual([{}, []]);
		expect(t.fabric.counters(slot, 1)).toMatchObject({ rxFrames: 4, dropped: 2 });
	});

	test("a native VLAN that the trunk does not allow does not cross it untagged", () => {
		const t = vlanNet(["a1", "b1"], [["a8-b8", trunk([10, 20])]]);
		t.send(1, arpRequest(1, 9));
		expect(t.reached()).toEqual({});
	});

	test("ends with different native VLANs move an untagged frame from one VLAN to the other, as real switches do", () => {
		const t = vlanNet(["a1:10", "a2:20", "b1:10", "b2:20"], [["a8-b8", trunk("all", 10), trunk("all", 20)]]);
		t.send(1, arpRequest(1, 9));
		expect(t.reached()).toEqual({ [B + 2]: 1 });
		expect(t.taps.map(({ on, e }) => [on, e.vlan, e.tagged])).toEqual([
			["a", 10, 0],
			["b", 20, 0],
		]);
	});

	test("an access port on each end of a cable joins one VLAN of each switch, untagged", () => {
		const t = vlanNet(["a1:10", "b1:30"], [["a8-b8", access(10), access(30)]]);
		t.send(1, arpRequest(1, 9));
		expect(t.reached()).toEqual({ [B + 1]: 1 });
		expect(t.taps.map(({ e }) => e.tagged)).toEqual([0, 0]);
	});

	test("a loop in one VLAN storms in that VLAN alone: a broadcast of another crosses once, and is not slowed", () => {
		const t = vlanNet(
			["a1:10", "a2:20", "b1:10", "b2:20"],
			[
				["a7-b7", access(10)],
				["a8-b8", access(10)],
				["a6-b6", access(20)],
			],
		);
		t.send(1, arpRequest(1, 9));
		t.run(50);
		expect(t.fabric.storm(t.at("a1").slot, 50)).not.toBeNull();
		t.clear();
		t.send(2, arpRequest(2, 9));
		t.run(50);
		expect(t.reached()).toMatchObject({ [B + 2]: 1 });
		const crossed = t.taps.filter(({ e }) => e.vlan === 20);
		expect(crossed.map(({ on, e }) => [on, e.from, e.looped])).toEqual([
			["a", 2, false],
			["b", 6, false],
		]);
	});

	test.each([
		["a cable between two ports of one switch", ["a1:10", "a2:20"], [["a7-a8", access(10), access(20)]], { 2: 1 }],
		[
			"a cable beside a trunk",
			["a1:10", "a2:20", "b1:10", "b2:20"],
			[
				["a8-b8", trunk("all")],
				["a7-b7", access(10), access(20)],
			],
			{ 2: 1, [B + 1]: 1, [B + 2]: 1 },
		],
	] as const)(
		"a frame that %s takes into another VLAN crosses once, has not looped, and is not slowed",
		(_, machines, cables, reached) => {
			const t = vlanNet(machines, cables);
			t.send(1, arpRequest(1, 9));
			expect(t.reached()).toEqual(reached);
			expect(t.taps.filter(({ e }) => e.looped).map(({ on, e }) => `${on}${e.from}`)).toEqual([]);
			expect(t.storming("a")).toBe(false);
			const learned = t.table("a");
			t.run(STORM_QUIET_MS * 2);
			expect(t.table("a")).toEqual(learned);
			expect(learned).toContain("0b vlan 10 at 1");
		},
	);

	test("one broadcast into a mesh of six switches with a cable that joins two VLANs is carried at once to each switch in each VLAN, and no further until its turn", () => {
		const letters = ["a", "b", "c", "d", "e", "f"];
		const free = new Map(letters.map((letter) => [letter, 1]));
		const take = (letter: string) => {
			const port = free.get(letter) as number;
			free.set(letter, port + 1);
			return `${letter}${port}`;
		};
		const mesh = letters.flatMap((a, i) =>
			letters.slice(i + 1).map((b) => [`${take(a)}-${take(b)}`, trunk("all")] as const),
		);
		const t = vlanNet(["a6:10", "f6:20"], [...mesh, ["b7-b8", access(10), access(20)]]);
		const from = t.at("a6");
		t.fabric.receive(from.slot, from.port, arpRequest(6, 9), 0);
		while (t.fabric.drain(0, 64) > 0);
		const places = new Set(t.taps.map(({ on, e }) => `${on} in VLAN ${e.vlan}`));
		expect(places.size).toBe(12);
		expect(t.reached()[5 * 8 + 6]).toBeGreaterThan(0);
		// The first copy to come into a switch in a VLAN goes on at once, to its seven cables at most.
		expect(t.taps.length).toBeLessThanOrEqual(1 + places.size * 7);
		t.run(20);
		expect(letters.filter((letter) => t.storming(letter))).toEqual(letters);
	});

	test.each([
		["frames that go by the table", () => ping(1, B + 2)],
		["broadcasts", () => arpRequest(1, 9)],
	] as const)(
		"%s cross a cable from one VLAN to another, and the next cable, at once, however many there are",
		(_, frame) => {
			const t = vlanNet(
				["a1:10", "b2:20"],
				[
					["a7-a8", access(10), access(20)],
					["a6-b6", access(20)],
				],
			);
			t.send(1, arpRequest(1, B + 2));
			t.send(B + 2, arpReply(B + 2, 1));
			t.clear();
			const from = t.at("a1");
			for (let i = 0; i < 1000; i++) {
				t.fabric.receive(from.slot, from.port, frame(), 100);
				while (t.fabric.drain(100, 64) > 0);
			}
			expect(t.reached()).toEqual({ [B + 2]: 1000 });
			expect(t.taps.filter(({ e }) => e.looped)).toEqual([]);
			expect([t.storming("a"), t.storming("b")]).toEqual([false, false]);
		},
	);

	test("a loop that changes VLAN on the way round storms: one cable takes 10 to 20, and another takes 20 back to 10", () => {
		const t = vlanNet(
			["a1:10", "a2:20"],
			[
				["a7-a8", access(10), access(20)],
				["a5-a6", access(20), access(10)],
			],
		);
		t.send(1, arpRequest(1, 9));
		// Out of 7 and 6 in VLAN 10, into 8 and 5 in 20, out of 5 and 8, and back into 6 and 7 in VLAN 10.
		const round = t.taps.slice(0, 5).map(({ e }) => `${e.from} vlan ${e.vlan}${e.looped ? " looped" : ""}`);
		expect(round.sort()).toEqual(["1 vlan 10", "5 vlan 20", "6 vlan 10 looped", "7 vlan 10 looped", "8 vlan 20"]);
		expect(t.storming("a")).toBe(true);
	});

	test("a storm that ends forgets the tables of the VLANs it looped in, and keeps the others", () => {
		const t = vlanNet(
			["a1:10", "a2:20", "b1:10", "b2:20"],
			[
				["a7-b7", access(10)],
				["a8-b8", access(10)],
				["a6-b6", access(20)],
			],
		);
		t.send(2, arpRequest(2, 9));
		t.send(B + 2, arpReply(B + 2, 2));
		const twenty = ["0c vlan 20 at 2", "14 vlan 20 at 6"];
		expect(t.table("a").filter((e) => e.includes("vlan 20"))).toEqual(twenty);
		t.send(1, arpRequest(1, 9));
		t.run(50);
		expect(t.storming("a")).toBe(true);
		t.cut("a7");
		t.run(STORM_QUIET_MS * 2);
		expect(t.storming("a")).toBe(false);
		expect(t.table("a")).toEqual(twenty);
	});
});

/** A frame from node1 to node2 with as many bytes after its header as given: a packet of that size. */
const packet = (bytes: number, seq = 1): Uint8Array => {
	const frame = new Uint8Array(14 + bytes);
	frame.set(ping(1, 2, seq).subarray(0, Math.min(98, frame.length)));
	return frame;
};

/** Node1 is on switch a and node2 on switch b, so a frame between them crosses node1's cable and the one between the switches, once each. */
const CABLES = [
	["a NIC's cable", "a1"],
	["a cable between switches", "a8-b8"],
] as const;

describe.each(CABLES)("conditions on %s", (_, cable) => {
	const two = (options: FabricOptions = {}) => net(["a", "b"], ["a8-b8"], options);
	/** The port of switch a that says what the cable dropped. */
	const port = cable === "a1" ? 1 : 8;

	test("a delay holds each frame that long in each direction, so a ping and its reply take twice as long", () => {
		const t = two();
		t.impair(cable, { delay: 100 });
		t.send("a", ping(1, 2));
		expect([t.fabric.next(), t.fabric.busy]).toEqual([100, true]);
		t.run(99);
		expect(t.got("b")).toBe(0);
		t.run(1);
		expect([t.got("b"), t.now]).toEqual([1, 100]);
		t.send("b", ping(2, 1, 1, 0));
		t.run(99);
		expect(t.got("a")).toBe(0);
		t.run(1);
		expect([t.got("a"), t.now]).toEqual([1, 200]);
	});

	test("with 20% loss, the share of 1,000 frames lost in one direction is within three points of it, each is in the tap with the reason, and the cable counts both", () => {
		const t = two({ random: seededStreams() });
		t.impair(cable, { loss: 20 });
		for (let seq = 1; seq <= 1000; seq++) t.send("a", ping(1, 2, seq));
		t.drain();
		const lost = 1000 - t.got("b");
		expect(Math.abs(lost / 1000 - 0.2)).toBeLessThanOrEqual(0.03);
		const dropped = t.taps.filter(({ e }) => e.dropped.length > 0);
		expect(dropped).toHaveLength(lost);
		expect(
			dropped.every(({ on, e }) => on === "a" && e.dropped[0].port === port && e.dropped[0].reason === "loss"),
		).toBe(true);
		expect(t.carried(cable.slice(0, 2))).toEqual({ delivered: 1000 - lost, dropped: { loss: lost, rate: 0, mtu: 0 } });
	});

	test("loses every frame at 100%, in both directions, and none once its loss is set to nothing", () => {
		const t = two();
		t.impair(cable, { loss: 100 });
		for (let i = 0; i < 20; i++) t.send("a", ping(1, 2));
		for (let i = 0; i < 20; i++) t.send("b", ping(2, 1));
		t.drain();
		expect([t.got("a"), t.got("b")]).toEqual([0, 0]);
		t.impair(cable, {});
		for (let i = 0; i < 20; i++) t.send("a", ping(1, 2));
		for (let i = 0; i < 20; i++) t.send("b", ping(2, 1));
		t.drain();
		expect([t.got("a"), t.got("b")]).toEqual([20, 20]);
	});

	test("with reordering, a share of the frames skips the delay, so they come in another order, and none is lost", () => {
		const t = two({ random: seededStreams() });
		t.impair(cable, { delay: 20, reorder: 25 });
		const sent = Array.from({ length: 200 }, (_, i) => i + 1);
		for (const seq of sent) {
			t.send("a", ping(1, 2, seq));
			t.run(1);
		}
		t.run(20);
		const came = t.pings("b");
		expect(came.toSorted((x, y) => x - y)).toEqual(sent);
		expect(came).not.toEqual(sent);
		// The frames of switch b's tap are in the order that they came, each as late as it was held: not at all, or 20 ms.
		const held = t.taps
			.filter(({ on }) => on === "b")
			.map(({ at, e }) => at - (((e.frame[40] << 8) | e.frame[41]) - 1));
		expect(new Set(held)).toEqual(new Set([0, 20]));
		const skipped = held.filter((ms) => ms === 0).length;
		expect(Math.abs(skipped / 200 - 0.25)).toBeLessThanOrEqual(0.1);
	});

	test("a rate lets one frame go at a time, each as long on its way as its bytes take, and drops what its queue has no room for", () => {
		const t = two();
		t.impair(cable, { rate: 1_000_000 });
		// 1,514 bytes take 12.112 ms at 1 Mbit/s, and 43 of them are the 64 KiB that may wait.
		const fits = Math.floor(RATE_QUEUE_BYTES / 1514);
		for (let seq = 1; seq <= fits + 7; seq++) t.send("a", packet(1500, seq));
		t.drain();
		expect(t.carried(cable.slice(0, 2))?.dropped).toEqual({ loss: 0, rate: 7, mtu: 0 });
		expect(t.taps.filter(({ e }) => e.dropped.some(({ reason }) => reason === "rate"))).toHaveLength(7);
		t.run(12);
		expect(t.got("b")).toBe(0);
		t.run(1);
		expect(t.got("b")).toBe(1);
		t.run(1000 - 13);
		// A second carries a megabit: 82 frames of 12,112 bits, which is more than had waited.
		expect(t.got("b")).toBe(fits);
		expect(t.pings("b")).toEqual(Array.from({ length: fits }, (_, i) => i + 1));

		for (let ms = 0; ms < 2000; ms += 10) {
			t.send("a", packet(1500));
			t.run(10);
		}
		const bits = (t.got("b") - fits) * 1514 * 8;
		expect(Math.abs(bits / 2 / 1_000_000 - 1)).toBeLessThan(0.02);
	});

	test("an MTU drops a frame that holds a longer packet, and lets one of that size and shorter ones pass", () => {
		const t = two();
		t.impair(cable, { mtu: 1400 });
		t.send("a", packet(1401));
		t.drain();
		expect(t.got("b")).toBe(0);
		expect(t.taps.at(-1)?.e.dropped).toEqual([{ port, reason: "mtu" }]);
		expect(t.carried(cable.slice(0, 2))).toEqual({ delivered: 0, dropped: { loss: 0, rate: 0, mtu: 1 } });
		t.send("a", packet(1400));
		t.send("a", packet(28));
		t.drain();
		expect(t.got("b")).toBe(2);
	});

	test("that change let what was on its way arrive at once, in order, ahead of what is sent after", () => {
		const t = two();
		t.impair(cable, { delay: 100 });
		t.send("a", ping(1, 2, 1));
		t.run(10);
		t.send("a", ping(1, 2, 2));
		t.run(10);
		t.impair(cable, { delay: 5 });
		t.send("a", ping(1, 2, 3));
		t.drain();
		expect(t.pings("b")).toEqual([1, 2]);
		t.run(5);
		expect(t.pings("b")).toEqual([1, 2, 3]);
	});

	test("a cut loses what waits on it, and it has its conditions when it is reconnected", () => {
		const t = two();
		t.impair(cable, { delay: 100 });
		t.send("a", ping(1, 2));
		t.run(50);
		t.cut(cable.slice(0, 2));
		expect([t.fabric.waiting, t.fabric.busy]).toEqual([0, false]);
		t.cut(cable.slice(0, 2), true);
		t.run(100);
		expect(t.got("b")).toBe(0);
		t.send("a", ping(1, 2));
		t.run(99);
		expect(t.got("b")).toBe(0);
		t.run(1);
		expect(t.got("b")).toBe(1);
	});

	test("holds no more frames than its bound, and the port counts those it had no room for", () => {
		const t = two();
		t.impair(cable, { delay: 1000 });
		for (let i = 0; i < HELD_LIMIT + 5; i++) t.send("a", ping(1, 2));
		expect(t.fabric.waiting).toBe(HELD_LIMIT);
		expect(t.fabric.counters(t.slot("a"), port)?.dropped).toBe(5);
		expect(t.taps.some(({ e }) => e.dropped.length > 0)).toBe(false);
		t.run(1000);
		expect(t.got("b")).toBe(HELD_LIMIT);
	});
});

describe("a NIC's cable", () => {
	/** One switch with a machine on each of ports 1 to 3, and what each was handed. */
	function three() {
		const taps: TapEvent[] = [];
		const fabric = new Fabric({ tap: (_, e) => taps.push(e) });
		const slot = fabric.addSwitch();
		const got = [0, 0, 0, 0];
		for (const p of [1, 2, 3] as const) fabric.attach(slot, p, { deliver: () => got[p]++ });
		const impair = (p: PortNo, values: ConditionValues) => fabric.setConditions(slot, p, conditions(values));
		return { fabric, slot, got, taps, impair };
	}

	test("with no conditions hands a frame on inside the call, and nothing waits", () => {
		const { fabric, slot, got } = three();
		fabric.receive(slot, 1, ping(1, 2), 0);
		expect([got[2], got[3], fabric.waiting, fabric.busy, fabric.next()]).toEqual([1, 1, 0, false, -1]);
	});

	test("with conditions slows no other: frames between two other machines go inside the call, while its own wait", () => {
		const { fabric, slot, got, impair } = three();
		fabric.receive(slot, 3, arpRequest(3, 2), 0);
		impair(1, { delay: 100 });
		fabric.receive(slot, 1, arpRequest(1, 2), 0);
		expect([got[2], fabric.waiting]).toEqual([1, 1]);
		fabric.receive(slot, 2, arpReply(2, 3), 0);
		expect([got[3], fabric.waiting]).toEqual([1, 1]);
		// The broadcast from node1 reaches the others when it has crossed node1's cable.
		fabric.drain(100, 64);
		expect([got[2], got[3], fabric.waiting]).toEqual([2, 2, 0]);
	});

	test("is a call again once its conditions are cleared and what waited has gone", () => {
		const { fabric, slot, got, impair } = three();
		impair(1, { delay: 100 });
		fabric.receive(slot, 1, arpRequest(1, 2), 0);
		impair(1, {});
		fabric.receive(slot, 1, arpRequest(1, 2), 1);
		expect([got[2], fabric.waiting]).toEqual([0, 2]);
		fabric.drain(1, 64);
		expect([got[2], fabric.waiting, fabric.busy]).toEqual([2, 0, false]);
		fabric.receive(slot, 1, arpRequest(1, 2), 2);
		fabric.receive(slot, 2, arpReply(2, 1), 2);
		expect([got[2], got[1], fabric.waiting]).toEqual([3, 1, 0]);
	});

	test("says in the tap that it dropped a frame from its machine: the port, no port that it went to, and the reason", () => {
		const { fabric, slot, got, taps, impair } = three();
		impair(1, { loss: 100 });
		fabric.receive(slot, 1, arpRequest(1, 2), 0);
		expect([got[2], got[3]]).toEqual([0, 0]);
		expect(taps).toMatchObject([{ from: 1, to: 0, flood: null, vlan: 1, dropped: [{ port: 1, reason: "loss" }] }]);
		expect(fabric.totals(slot)).toMatchObject({ in: 0, delivered: 0 });
		// One to its machine was sent by the switch, and then dropped.
		fabric.receive(slot, 2, arpRequest(2, 1), 0);
		expect(taps[1]).toMatchObject({ from: 2, to: bit(1) | bit(3), dropped: [{ port: 1, reason: "loss" }] });
		expect(fabric.carried(slot, 1)).toEqual({ delivered: 0, dropped: { loss: 2, rate: 0, mtu: 0 } });
		expect(fabric.carried(slot, 2)).toEqual({ delivered: 1, dropped: { loss: 0, rate: 0, mtu: 0 } });
	});

	test("keeps its port's conditions for whatever is plugged into the port next, until the port is told otherwise", () => {
		const { fabric, slot, got, impair } = three();
		impair(1, { delay: 100 });
		fabric.detach(slot, 1);
		fabric.attach(slot, 1, { deliver: () => got[1]++ });
		fabric.receive(slot, 2, arpRequest(2, 1), 0);
		expect(got[1]).toBe(0);
		fabric.drain(100, 64);
		expect(got[1]).toBe(1);
		fabric.detach(slot, 1);
		impair(1, {});
		fabric.attach(slot, 1, { deliver: () => got[1]++ });
		fabric.receive(slot, 2, arpRequest(2, 1), 100);
		expect(got[1]).toBe(2);
	});

	test("is not taken for one between switches", () => {
		const { fabric, slot, impair } = three();
		impair(1, { delay: 100 });
		expect(fabric.farEnd(slot, 1)).toBeNull();
		fabric.setLink(slot, 1, false);
		expect([fabric.isUp(slot, 1), fabric.isUp(slot, 2)]).toEqual([false, true]);
	});
});

describe("conditions and the rest of the fabric", () => {
	test("a tag is not counted in a cable's MTU: a trunk carries a packet of that size with its tag", () => {
		const t = vlanNet(["a1:10", "b1:10"], [["a8-b8", trunk("all"), trunk("all")]]);
		for (const end of ["a8", "b8"]) t.fabric.setConditions(t.at(end).slot, t.at(end).port, conditions({ mtu: 1400 }));
		t.send(1, packet(1400));
		expect([t.reached(), t.taps.at(-1)?.e.tagged]).toEqual([{ 9: 1 }, bit(8)]);
		t.send(1, packet(1401));
		expect(t.reached()).toEqual({ 9: 1 });
	});

	test("a loop with a cable that loses every frame does not storm, and one that loses some ends its storm by itself", () => {
		const t = net(["a", "b", "c"], TRIANGLE, { random: seededStreams() });
		t.impair("a7-b8", { loss: 100 });
		t.send("a", arpRequest(1, 9));
		t.run(50);
		expect(t.storming()).toEqual([]);
		t.impair("a7-b8", { loss: 50 });
		t.send("a", arpRequest(1, 9));
		t.run(20);
		expect(t.storming()).not.toEqual([]);
		t.run(2000);
		expect([t.storming(), t.fabric.busy]).toEqual([[], false]);
	});

	test("a looped frame on a cable with a delay waits both its turn and the delay", () => {
		const t = net(["a"], ["a7-a8"]);
		t.impair("a7-a8", { delay: 50 });
		t.send("a", arpRequest(1, 9));
		t.run(49);
		expect(t.taps).toHaveLength(1);
		t.run(1000);
		const looped = t.taps.filter(({ e }) => e.looped);
		// Two copies go round, one each way, and each takes 50 ms a lap.
		expect(looped.length).toBeGreaterThan(30);
		expect(looped.length).toBeLessThanOrEqual(2 * (1000 / 50) + 2);
	});
});

describe("spanning tree", () => {
	const ALL = ["a", "b", "c"] as const;
	const BLOCKED = [
		"a7 designated forwarding",
		"a8 designated forwarding",
		"b7 designated forwarding",
		"b8 root forwarding",
		"c7 root forwarding",
		"c8 alternate discarding",
	];
	/** Long enough after the switches have agreed: for three seconds a port that began to carry says that the topology changed. */
	const QUIET_MS = 10_000;
	const message = (from: number) => {
		const id = bridgeIdOf(0x8000, 0x5254_0088_0000 + 10 + from);
		const said = { rapid: true, root: id, cost: 0, bridge: id, port: 0x8001, role: "designated" } as const;
		const flags = { proposal: true, agreement: false, learning: false, forwarding: false, topologyChange: false };
		return encodeBpdu(
			{ ...said, ...flags, age: 0, maxAge: 20, hello: 2, forwardDelay: 15 },
			0x5254_0088_0000 + 10 + from,
		);
	};

	test("is off on a new switch, so a loop storms, and a frame for the bridges' address is dropped where it comes in", () => {
		const t = net(ALL, TRIANGLE);
		expect(ALL.map((on) => t.fabric.tree(t.slot(on)))).toEqual([null, null, null]);
		expect([t.fabric.busy, t.fabric.timer()]).toEqual([false, -1]);
		t.send("a", message(1));
		t.run(50);
		expect([t.taps.length, t.got("b"), t.got("c")]).toEqual([0, 0, 0]);
		expect(t.fabric.counters(t.slot("a"), 1)?.dropped).toBe(1);
		t.send("a", arpRequest(1, 9));
		t.run(500);
		expect(t.storming()).toEqual(["a", "b", "c"]);
	});

	test("blocks one port of a triangle of switches, so a broadcast reaches each machine once, and a ping goes round by the root", () => {
		const t = net(ALL, TRIANGLE);
		t.stp(ALL);
		expect(t.ports()).toEqual(BLOCKED);
		expect(t.now).toBe(0);

		t.send("a", arpRequest(1, 9));
		t.run(50);
		expect(ALL.map((on) => t.heard(on).length)).toEqual([0, 1, 1]);
		expect(t.took().map(({ on, e }) => `${on}${e.from}${e.looped ? " looped" : ""}`)).toEqual(["a1", "b8", "c7"]);
		expect([t.storming(), t.storms]).toEqual([[], []]);
		// What b floods towards c comes in by the blocked port, which drops it and counts it.
		expect(t.fabric.counters(t.slot("c"), 8)?.dropped).toBe(1);

		t.send("c", arpRequest(3, 2));
		t.run(5);
		t.send("b", arpReply(2, 3));
		t.run(5);
		const from = t.took().length;
		t.send("b", ping(2, 3));
		t.run(5);
		expect(
			t
				.took()
				.slice(from)
				.map(({ on, e }) => [on, e.from, e.to, e.flood]),
		).toEqual([
			["b", 1, bit(8), null],
			["a", 7, bit(8), null],
			["c", 7, bit(1), null],
		]);
		expect(t.heard("c").at(-1)).toEqual(ping(2, 3));
	});

	test("keeps a switch's priority and its ports' costs while it takes no part, gives them to its tree when it does, and changes the tree with them at once", () => {
		const t = net(ALL, TRIANGLE);
		t.fabric.setPriority(t.slot("c"), 4096 as BridgePriority);
		t.stp(ALL);
		expect(t.fabric.tree(t.slot("a"))?.root).toEqual({ priority: 4096, address: "02:00:00:00:00:03" });
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"a8 root forwarding",
			"b7 root forwarding",
			"b8 alternate discarding",
			"c7 designated forwarding",
			"c8 designated forwarding",
		]);

		// b's own cable to c is dearer than the way round by a.
		t.fabric.setCost(t.slot("b"), 7, 100_000 as PathCost);
		t.drain();
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"a8 root forwarding",
			"b7 alternate discarding",
			"b8 root forwarding",
			"c7 designated forwarding",
			"c8 designated forwarding",
		]);
		expect(t.fabric.tree(t.slot("b"))?.cost).toBe(40_000);

		// b's costs are changed while it takes no part, and its new tree has them. With c's old priority, a is the root.
		t.stp(["b"], false);
		t.fabric.setCost(t.slot("b"), 7, DEFAULT_COST);
		t.fabric.setCost(t.slot("b"), 8, 100_000 as PathCost);
		t.fabric.setPriority(t.slot("c"), DEFAULT_PRIORITY);
		t.stp(["b"]);
		t.run(10);
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"a8 designated forwarding",
			"b7 root forwarding",
			"b8 alternate discarding",
			"c7 root forwarding",
			"c8 designated forwarding",
		]);
		expect([t.storming(), t.storms]).toEqual([[], []]);
	});

	test("has work from when a switch is told to take part, and after it a timer for the next hello", () => {
		const t = net(["a"], []);
		t.fabric.setTree(t.slot("a"), { address: 0x0200_0000_0001 });
		expect([t.fabric.busy, t.fabric.next()]).toEqual([true, 0]);
		// Until its tree has run, not even its machine's port carries a frame.
		t.send("a", arpRequest(1, 9));
		expect(t.taps).toEqual([]);
		t.drain();
		expect([t.fabric.busy, t.fabric.next(), t.fabric.timer()]).toEqual([false, -1, HELLO_MS]);
		t.send("a", arpRequest(1, 9));
		expect(t.taps).toHaveLength(1);
		t.run(HELLO_MS);
		expect(t.fabric.timer()).toBe(2 * HELLO_MS);
	});

	test("sends its messages as frames: every two seconds from each designated port, along a cable and to a machine", () => {
		const t = net(["a", "b"], ["a8-b8"]);
		t.stp(["a", "b"]);
		t.run(QUIET_MS);
		const [taps, toA, toB] = [t.taps.length, t.hellos("a").length, t.hellos("b").length];
		t.run(5 * HELLO_MS);
		// b's port on the cable is its way to the root, and says nothing. What a says there, b takes in and sends nowhere.
		const crossed = t.taps.slice(taps);
		expect(crossed.map(({ on, at, e }) => [on, at, e.from, e.to, e.frame.length])).toEqual(
			[1, 2, 3, 4, 5].map((n) => ["b", QUIET_MS + n * HELLO_MS, 8, 0, 60]),
		);
		expect(decodeBpdu(crossed[0].e.frame)).toMatchObject({
			rapid: true,
			root: bridgeIdOf(0x8000, 0x0200_0000_0001),
			cost: 0,
			bridge: bridgeIdOf(0x8000, 0x0200_0000_0001),
			port: 0x8008,
			role: "designated",
			forwarding: true,
			hello: 2,
		});
		expect([t.hellos("a").length - toA, t.hellos("b").length - toB]).toEqual([5, 5]);
		expect(decodeBpdu(t.hellos("b").at(-1) as Uint8Array)).toMatchObject({
			root: bridgeIdOf(0x8000, 0x0200_0000_0001),
			cost: 20_000,
			bridge: bridgeIdOf(0x8000, 0x0200_0000_0002),
			port: 0x8001,
		});
		expect(t.fabric.carried(t.slot("a"), 8)?.delivered).toBeGreaterThanOrEqual(5);
	});

	test("brings the blocked port into use when a cable in use is cut, and the switch that had learned the old way forgets it", () => {
		const t = net(ALL, TRIANGLE);
		t.stp(ALL);
		t.send("c", arpRequest(3, 2));
		t.run(5);
		t.send("b", arpReply(2, 3));
		t.run(5);
		// b has node3 by way of a, because c's port to b is blocked.
		expect(t.table("b")).toEqual({ [NODE[2]]: 1, [NODE[3]]: 8 });
		const cutAt = t.now;

		t.cut("c7");
		t.drain();
		expect(t.ports()).toEqual([
			"a7 designated forwarding",
			"b7 designated forwarding",
			"b8 root forwarding",
			"c8 root forwarding",
		]);
		expect(t.table("b")).toEqual({ [NODE[2]]: 1 });
		const before = t.heard("c").length;
		t.send("b", ping(2, 3));
		t.drain();
		expect(t.heard("c").slice(before)).toEqual([ping(2, 3)]);
		// No timer of the protocol had to run out.
		expect(t.now).toBe(cutAt);

		// Reconnected, the cable is in use again, and the far port is blocked as before.
		t.cut("c7", true);
		t.drain();
		expect(t.ports()).toEqual(BLOCKED);
		expect([t.storms, t.now]).toEqual([[], cutAt]);
	});

	test("forgets what it had learned when it begins, so no address is left on a port that the tree then blocks", () => {
		const t = net(ALL, TRIANGLE);
		// A line of three while one cable is cut, where c learns node2 on its port to b.
		t.cut("c7");
		t.send("b", arpRequest(2, 3));
		t.run(5);
		t.send("c", arpReply(3, 2));
		t.run(5);
		expect(t.table("c")).toMatchObject({ [NODE[2]]: 8 });
		// The loop is closed, and before a frame has gone round it the tree blocks that port.
		t.cut("c7", true);
		t.stp(ALL);
		expect(t.ports()).toEqual(BLOCKED);
		expect(t.table("c")).toEqual({});
		const before = t.heard("b").length;
		t.send("c", ping(3, 2));
		t.run(5);
		expect(t.heard("b").slice(before)).toEqual([ping(3, 2)]);
		expect(t.storming()).toEqual([]);
	});

	test("ends a storm when it is turned on for the switches of the loop", () => {
		const t = net(ALL, TRIANGLE);
		t.send("a", arpRequest(1, 9));
		t.run(500);
		expect(t.storming()).toEqual(["a", "b", "c"]);
		const onAt = t.now;
		t.stp(ALL);
		expect(t.ports()).toEqual(BLOCKED);
		t.run(1000);
		expect(t.storming()).toEqual([]);
		const over = t.taps.filter(({ e }) => e.looped).at(-1)?.at ?? 0;
		// What had looped is gone as soon as it comes to a port that the tree has stopped: the frames of one hop's queue.
		expect(over - onAt).toBeLessThan(100);
		expect(
			t.storms
				.filter((storm) => storm.over)
				.map(({ on }) => on)
				.sort(),
		).toEqual(["a", "b", "c"]);

		const [b, c] = [t.heard("b").length, t.heard("c").length];
		t.send("a", arpRequest(1, 9));
		t.run(200);
		expect([t.heard("b").length - b, t.heard("c").length - c]).toEqual([1, 1]);
		expect(t.storming()).toEqual([]);
	});

	test("sees no loop through a switch that has it off, which sends no message on: the loop storms once the ports towards that switch carry", () => {
		const t = net(ALL, TRIANGLE);
		t.stp(["a", "b"]);
		const waiting = [
			"a7 designated forwarding",
			"a8 designated discarding",
			"b7 designated discarding",
			"b8 root forwarding",
		];
		expect(t.ports()).toEqual(waiting);
		// Each proposes to c for three seconds, and until then the loop is open.
		t.send("a", arpRequest(1, 9));
		t.run(EDGE_DELAY_MS - 1);
		expect(t.ports()).toEqual(waiting);
		expect([t.heard("b").length, t.heard("c").length, t.storming()]).toEqual([1, 0, []]);
		expect(t.taps.filter(({ on }) => on === "c")).toEqual([]);
		expect(t.fabric.counters(t.slot("c"), 7)?.dropped).toBeGreaterThan(0);

		t.run(1);
		expect(t.ports()).toEqual(waiting.map((port) => port.replace("discarding", "forwarding")));
		t.send("a", arpRequest(1, 9));
		t.run(500);
		expect(t.storming()).toEqual(["a", "b", "c"]);

		// With it on for c too, the three find the loop and the storm ends.
		t.stp(["c"]);
		t.run(1000);
		expect(t.ports()).toEqual(BLOCKED);
		expect(t.storming()).toEqual([]);
	});

	test("turned off, lets every port carry again, so a loop that it had blocked storms", () => {
		const t = net(ALL, TRIANGLE);
		t.stp(ALL);
		t.stp(ALL, false);
		expect([t.ports(), t.fabric.timer(), t.fabric.busy]).toEqual([[], -1, false]);
		t.send("a", arpRequest(1, 9));
		t.run(500);
		expect(t.storming()).toEqual(["a", "b", "c"]);
	});

	test("tells its owner each time a switch's part in the tree changes, and not at a hello that changes nothing", () => {
		const t = net(ALL, TRIANGLE);
		t.stp(ALL);
		const last = (on: Letter) => t.trees.findLast((told) => told.on === on)?.reading;
		for (const on of ALL) expect(last(on)).toEqual(t.fabric.tree(t.slot(on)));
		expect(last("c")).toEqual({
			bridge: { priority: 32768, address: "02:00:00:00:00:03" },
			root: { priority: 32768, address: "02:00:00:00:00:01" },
			cost: 20_000,
			ports: [
				{ port: 1, role: "designated", state: "forwarding" },
				{ port: 7, role: "root", state: "forwarding" },
				{ port: 8, role: "alternate", state: "discarding" },
			],
		});
		const told = t.trees.length;
		t.run(3 * HELLO_MS);
		expect(t.trees.length).toBe(told);
		t.cut("c7");
		t.drain();
		expect(last("c")?.ports).toEqual([
			{ port: 1, role: "designated", state: "forwarding" },
			{ port: 8, role: "root", state: "forwarding" },
		]);
		expect(last("c")?.cost).toBe(40_000);
	});

	test("is one tree for every VLAN: its messages cross a trunk, tagged or not, and a cable from one VLAN to another", () => {
		const t = net(ALL, TRIANGLE);
		const set = (at: string, vlan: PortVlan) => t.fabric.setVlan(t.end(at).slot, t.end(at).port, vlan);
		// A trunk that carries only VLAN 10, with a native VLAN that it does not allow, so nothing crosses it untagged.
		for (const at of ["a7", "b8", "b7", "c8"]) set(at, trunk([10], 99));
		set("c7", access(20));
		set("a8", access(30));
		t.stp(ALL);
		expect(t.ports()).toEqual(BLOCKED);
	});

	test("a machine that sends a message of its own is heard: its port is taken for a bridge's, and goes on carrying", () => {
		const t = net(["a", "b"], ["a8-b8"]);
		t.stp(["a", "b"]);
		const taps = t.taps.length;
		t.send("b", message(2));
		t.drain();
		expect(t.taps.slice(taps).map(({ on, e }) => [on, e.from, e.to])).toEqual([["b", 1, 0]]);
		expect(t.got("a")).toBe(t.hellos("a").length);
		t.send("b", arpRequest(2, 9));
		t.drain();
		expect(t.heard("a")).toHaveLength(1);
	});
});
