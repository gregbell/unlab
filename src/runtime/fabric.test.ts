import { describe, expect, test } from "vitest";
import { arpReply, arpRequest, ping } from "../../test/support/frames.ts";
import type { PortNo } from "../model/index.ts";
import {
	Fabric,
	LOOPED_LIMIT,
	PACE_MS,
	QUEUE_LIMIT,
	STORM_QUIET_MS,
	type StormReading,
	type TapEvent,
} from "./fabric.ts";

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
				{ mac: "52:54:00:88:00:0e", port: 5, seen: 1000, flushed: false },
				{ mac: "52:54:00:88:00:0b", port: 2, seen: 1250, flushed: false },
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
function net(letters: readonly Letter[], cables: readonly string[]) {
	const taps: { on: Letter; at: number; e: TapEvent }[] = [];
	const storms: { on: Letter; over: boolean; reading: StormReading }[] = [];
	const slots = new Map<Letter, number>();
	const names: Letter[] = [];
	let now = 0;
	const fabric = new Fabric({
		tap: (slot, e) => taps.push({ on: names[slot], at: now, e }),
		storm: (slot, reading, over) => storms.push({ on: names[slot], over, reading }),
	});
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

	test("marks a frame as looped from where it comes back to a switch that it had left", () => {
		const t = net(["a", "b", "c"], TRIANGLE);
		t.send("a", arpRequest(1, 9));
		t.drain();
		// Out of a to b and c, on from each to the other, and from there back to a.
		expect(t.taps.slice(0, 7).map(({ on, e }) => `${on}${e.from}${e.looped ? " looped" : ""}`)).toEqual([
			"a1",
			"b8",
			"c7",
			"c8",
			"b7",
			"a8 looped",
			"a7 looped",
		]);
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
		expect(most).toBeLessThanOrEqual(12 * LOOPED_LIMIT);
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
		expect(t.storms.filter(({ over }) => over)).toMatchObject([{ on: "b", reading: { since: 0, looped } }]);
		t.run(200);
		expect(t.storming()).toEqual([]);
		expect(t.storms.filter(({ over }) => over).map(({ on }) => on)).toEqual(["b", "a", "c"]);
		expect([t.fabric.farEnd(t.slot("a"), 7), t.fabric.farEnd(t.slot("c"), 8)]).toEqual([null, null]);
		expect(t.fabric.addSwitch()).toBe(t.slot("b"));
		expect(t.fabric.totals(t.slot("b"))).toEqual({ in: 0, delivered: 0, flooded: 0, dropped: 0 });
		expect(t.fabric.macTable(t.slot("b"), t.now)).toEqual([]);
	});
});
