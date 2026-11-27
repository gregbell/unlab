import { describe, expect, test, vi } from "vitest";
import { testClock } from "../../test/support/clock.ts";
import { arpRequest } from "../../test/support/frames.ts";
import type { PortNo } from "../model/index.ts";
import { Fabric, STORM_QUIET_MS, type TapEvent } from "./fabric.ts";
import { createPump } from "./pump.ts";
import { HELLO_MS } from "./rstp.ts";

/** Three switches in a loop, a to b to c to a, each with a machine on port 1, and the loop's last cable cut or not. */
function looped(tick = 0, closed = true) {
	const clock = testClock(tick);
	const taps: { slot: number; at: number; e: TapEvent }[] = [];
	const over: number[] = [];
	const fabric = new Fabric({
		tap: (slot, e) => taps.push({ slot, at: clock.now(), e }),
		storm: (slot, _, ended) => void (ended && over.push(slot)),
	});
	const got = [0, 0, 0];
	for (const slot of [0, 1, 2]) {
		fabric.addSwitch();
		fabric.attach(slot, 1, { deliver: () => void got[slot]++ });
	}
	const cables: [number, PortNo, number, PortNo][] = [
		[0, 7, 1, 8],
		[1, 7, 2, 8],
		[2, 7, 0, 8],
	];
	for (const [a, pa, b, pb] of cables) fabric.cable({ slot: a, port: pa }, { slot: b, port: pb });
	if (!closed) fabric.setLink(2, 7, false);
	return { clock, fabric, pump: createPump(fabric, clock), taps, got, over };
}

describe("the pump", () => {
	test("carries a frame across its cables in the call that brought it, with no timer and no task", () => {
		const t = looped(0, false);
		t.pump.receive(0, 1, arpRequest(1, 2));
		expect(t.got).toEqual([0, 1, 1]);
		expect(t.taps.map(({ slot }) => slot)).toEqual([0, 1, 2]);
		expect([t.clock.waits, t.clock.tasks]).toEqual([[], 0]);
	});

	test("sets one timer for the next looped frame, a whole millisecond away, and none once the loop is cut and quiet", () => {
		const t = looped();
		t.pump.receive(0, 1, arpRequest(1, 9));
		expect(t.clock.waits).toEqual([1]);
		t.clock.pass(50);
		expect(t.taps.filter(({ e }) => e.looped).length).toBeGreaterThan(90);
		expect(t.clock.waits.every((ms) => ms === 1)).toBe(true);

		t.fabric.setLink(0, 7, false);
		t.fabric.setLink(1, 7, false);
		t.fabric.setLink(2, 7, false);
		const set = t.clock.waits.length;
		t.clock.pass(STORM_QUIET_MS + 40);
		// A wait of a tenth of a second is taken in steps of at most thirty milliseconds.
		const quiet = t.clock.waits.slice(set);
		expect(Math.max(...quiet)).toBe(30);
		expect(quiet.every((ms) => Number.isInteger(ms))).toBe(true);
		expect(t.over.sort()).toEqual([0, 1, 2]);
		const rested = t.clock.waits.length;
		t.clock.pass(1000);
		expect(t.clock.waits.length).toBe(rested);
	});

	test("goes on in a task of its own once it has had four milliseconds, so the page's other tasks have their turn", () => {
		// Each look at the clock takes a millisecond here, so a turn is used up after a few batches.
		const t = looped(1, false);
		for (let i = 0; i < 2000; i++) t.fabric.receive(0, 1, arpRequest(1, 9), 0);
		expect(t.fabric.waiting).toBe(256);
		t.pump.receive(0, 1, arpRequest(1, 9));
		const first = t.taps.length;
		expect(t.clock.tasks).toBe(1);
		expect(t.fabric.waiting).toBeGreaterThan(0);
		t.pump.receive(0, 1, arpRequest(1, 9));
		// A frame that comes in meanwhile is forwarded by its own switch, and waits its turn at the cable.
		expect(t.taps.length).toBe(first + 1);
		expect(t.clock.tasks).toBe(1);
		t.clock.pass(1);
		expect(t.clock.tasks).toBeGreaterThan(1);
		t.clock.pass(100);
		expect(t.fabric.waiting).toBe(0);
		expect(t.got[1]).toBeGreaterThan(256);
	});

	test("carries what waits, and what comes after, when the fabric has thrown, and lets what it threw reach whoever called", () => {
		const t = looped(0, false);
		const thrown = new RangeError("Array buffer allocation failed");
		vi.spyOn(t.fabric, "drain").mockImplementationOnce(() => {
			throw thrown;
		});
		expect(() => t.pump.receive(0, 1, arpRequest(1, 2))).toThrow(thrown);
		expect(t.got).toEqual([0, 0, 0]);
		t.clock.pass(1);
		expect(t.got).toEqual([0, 1, 1]);
		t.pump.receive(0, 1, arpRequest(1, 2));
		expect(t.got).toEqual([0, 2, 2]);
		expect(t.fabric.waiting).toBe(0);
	});

	test("runs a spanning tree when it is woken, and then sets one timer for each hello, however far off that is", () => {
		const t = looped(0, false);
		for (const slot of [0, 1, 2]) t.fabric.setTree(slot, { address: 0x0200_0000_0001 + slot });
		expect(t.fabric.tree(1)?.ports).toEqual([]);
		t.pump.wake();
		expect(t.fabric.tree(1)?.ports.map(({ port, state }) => [port, state])).toEqual([
			[1, "forwarding"],
			[7, "forwarding"],
			[8, "forwarding"],
		]);
		// The switches agreed with no timer, and in no task of their own. The one timer is for the hello.
		expect([t.clock.waits, t.clock.tasks]).toEqual([[HELLO_MS], 0]);
		// For three seconds a port that began to forward says so, its way to the root too. Then only designated ports speak.
		t.clock.pass(2 * HELLO_MS);
		const settled = t.taps.length;
		t.clock.pass(10 * HELLO_MS);
		expect(t.clock.waits).toEqual(new Array(13).fill(HELLO_MS));
		// Two cables are whole, and the designated port of each says what it knows at every hello.
		expect(t.taps.length - settled).toBe(20);

		// A frame that waits its turn in a storm is still waited for to the millisecond.
		for (const slot of [0, 1, 2]) t.fabric.setTree(slot, null);
		t.fabric.setLink(2, 7, true);
		t.pump.wake();
		const quiet = t.clock.waits.length;
		t.clock.pass(HELLO_MS);
		expect(t.clock.waits.length).toBe(quiet);
		t.pump.receive(0, 1, arpRequest(1, 9));
		expect(t.clock.waits.at(-1)).toBe(1);
	});

	test("does nothing after it is stopped", () => {
		const t = looped();
		t.pump.receive(0, 1, arpRequest(1, 9));
		const carried = t.taps.length;
		t.pump.stop();
		t.clock.pass(100);
		expect(t.taps.length).toBe(carried);
	});
});
