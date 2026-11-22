import { describe, expect, test } from "vitest";
import { arpReply, arpRequest, ping } from "../../test/support/frames.ts";
import type { PortNo } from "../model/types.ts";
import { LabSwitch, type TapEvent } from "./switch.ts";

const bit = (p: number) => 1 << (p - 1);

function lab(ports: readonly PortNo[]) {
	let clock = 1000;
	const sw = new LabSwitch({ now: () => clock });
	const inbox = new Map<PortNo, Uint8Array[]>();
	for (const p of ports) {
		inbox.set(p, []);
		sw.attach(p, { deliver: (f) => inbox.get(p)?.push(f) });
	}
	const taps: TapEvent[] = [];
	sw.onTap((e) => taps.push(e));
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
		expect(last()).toMatchObject({ from: 1, to: bit(3) | bit(7), flood: "group" });
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
		const sw = new LabSwitch();
		sw.attach(1, { deliver: () => {} });
		sw.attach(2, { deliver: (f) => f.fill(0) });
		const taps: TapEvent[] = [];
		sw.onTap((e) => taps.push(e));
		const frame = arpRequest(1, 2);
		const original = frame.slice();
		sw.receive(1, frame);
		expect(taps[0].frame).toEqual(original);
	});

	test("an attached port number cannot be attached twice", () => {
		const { sw } = lab([1]);
		expect(() => sw.attach(1, { deliver: () => {} })).toThrow();
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
