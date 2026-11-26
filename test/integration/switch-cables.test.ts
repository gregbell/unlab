// Real kernels on switches that are cabled to each other: a segment that spans
// two switches, and loops of cables, with the fabric on Node's own clock.
import assert from "node:assert/strict";
import { test } from "vitest";
import { arpAddrs, ip4 } from "../../src/net/index.ts";
import { bootLab, type SwitchedTap, type TestLab } from "./lab.ts";

const NOBODY = "10.88.0.99";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `0c at 8`, or with `flushed` after it, for each address the switch has. */
const learned = (lab: TestLab, sw: number): string[] =>
	lab.switches[sw]
		.macTable()
		.map((e) => `${e.mac.slice(-2)} at ${e.port}${e.flushed ? " flushed" : ""}`)
		.sort();

const pings = async (lab: TestLab, from: number, to: string, count = 2): Promise<boolean> =>
	(await lab.machines[from].exec(`ping -c ${count} -W 1 ${to}`)).exitCode === 0;

/** The ARP requests for the address that nobody has, as the switches carried them. */
const asked = (lab: TestLab): SwitchedTap[] => lab.frames.filter((e) => arpAddrs(e.frame)?.tpa === ip4(NOBODY));

/** Waits until `done`, and says how long that took, or throws after `ms`. */
async function until(done: () => boolean, ms: number, what: string): Promise<number> {
	const started = performance.now();
	while (!done()) {
		if (performance.now() - started > ms) throw new Error(`${what}: not within ${ms} ms`);
		await wait(5);
	}
	return performance.now() - started;
}

test("machines on two switches that a cable joins ping each other, each switch learns the far one on the cable's port, and a cut flushes both", async () => {
	const lab = await bootLab(
		[
			{ n: 1, ports: [1], on: 0 },
			{ n: 2, ports: [1], on: 1 },
		],
		{ switches: 2, cables: [[0, 8, 1, 7]] },
	);
	try {
		assert.ok(await pings(lab, 0, "node2"), "node1 reaches node2 across the cable");
		assert.ok(await pings(lab, 1, "node1"), "and node2 reaches node1");
		assert.deepEqual(learned(lab, 0), ["0b at 1", "0c at 8"], "the first switch has node2 on its cable's port");
		assert.deepEqual(learned(lab, 1), ["0b at 7", "0c at 1"], "the second has node1 on its end of it");
		// Each hop is tapped by the switch that made it, in the order it was made.
		const echo = lab.frames.filter((e) => e.frame.length === 98).slice(0, 2);
		assert.deepEqual(
			echo.map((e) => [e.switch, e.from, e.to]),
			[
				[0, 1, 1 << 7],
				[1, 7, 1 << 0],
			],
		);

		lab.switches[1].setLink(7, false);
		assert.deepEqual(learned(lab, 0), ["0b at 1", "0c at 8 flushed"], "a cut at one end flushes the other end too");
		assert.deepEqual(learned(lab, 1), ["0b at 7 flushed", "0c at 1"]);
		assert.equal(await pings(lab, 0, "node2", 1), false, "nothing crosses a cut cable");

		lab.switches[0].setLink(8, true);
		assert.ok(await pings(lab, 0, "node2"), "reconnected, it carries again");
		assert.deepEqual(learned(lab, 0), ["0b at 1", "0c at 8"], "and each switch learns the far machine again");
		assert.deepEqual(learned(lab, 1), ["0b at 7", "0c at 1"]);
	} finally {
		await lab.stop();
	}
});

test("one broadcast goes round a loop of three switches until a cable is cut, the machines answer meanwhile, and pings work a second after", async () => {
	// The loop is open while the machines boot, so that the broadcast that storms is the one the test sends.
	const lab = await bootLab(
		[
			{ n: 1, ports: [1], on: 0 },
			{ n: 2, ports: [1], on: 1 },
			{ n: 3, ports: [1], on: 2 },
		],
		{
			switches: 3,
			cables: [
				[0, 7, 1, 8],
				[1, 7, 2, 8],
				[2, 7, 0, 8, "cut"],
			],
		},
	);
	const [node1, node2] = lab.machines;
	try {
		assert.ok(await pings(lab, 0, "node2"), "the line of three carries a ping");
		assert.ok(await pings(lab, 0, "node3"));
		await wait(300);
		assert.equal(lab.storms.length, 0, "no storm while the loop is open");

		lab.switches[2].setLink(7, true);
		await node1.exec(`arping -c 1 -w 1 -I eth0 ${NOBODY}`);
		const sent = asked(lab).filter((e) => e.switch === 0 && e.from === 1);
		assert.equal(sent.length, 1, "node1 asked once");
		await wait(1000);
		const round = asked(lab).filter((e) => e.looped).length;
		assert.ok(round > 1000, `the one request went round ${round} times in a second`);
		await wait(500);
		assert.ok(asked(lab).filter((e) => e.looped).length > round + 500, "and goes on going round");

		for (const [i, sw] of lab.switches.entries()) {
			const storm = sw.storm();
			assert.ok(storm && storm.rate > 300, `switch ${i} storms, at ${storm?.rate} looped frames a second`);
		}
		const started = performance.now();
		assert.equal((await node2.run("echo answered")).trim(), "answered");
		assert.ok(performance.now() - started < 1000, "a machine on the loop answers within a second");

		const cutAt = lab.now();
		lab.switches[1].setLink(7, false);
		const over = await until(() => lab.storms.filter((s) => s.over).length === 3, 1000, "the storms end");
		assert.ok(over < 1000, `every storm was over ${over.toFixed(0)} ms after the cut`);
		const lastLooped = Math.max(...lab.frames.filter((e) => e.looped).map((e) => e.at));
		assert.ok(
			lastLooped - cutAt < 100,
			`the last looped frame came ${(lastLooped - cutAt).toFixed(1)} ms after the cut`,
		);
		for (const sw of lab.switches) assert.equal(sw.storm(), null);

		// node2 has node1's address, so it asks nobody first: its ping arrives only if no switch still has node1 where the storm left it.
		assert.ok(await pings(lab, 1, "node1", 1), "node2 reaches node1, whose address the storm had moved, at once");
		assert.ok(await pings(lab, 0, "node3", 1), "and node1 reaches node3, which is now at the far end of the line");
		assert.ok(lab.now() - cutAt < 2500, "both within the second after the storm, and the time the pings take");
	} finally {
		await lab.stop();
	}
});

test("a mesh of four switches drops what does not fit and counts it, storms on while any loop is whole, and ends when the last is cut", async () => {
	const lab = await bootLab(
		[
			{ n: 1, ports: [1], on: 0 },
			{ n: 2, ports: [1], on: 1 },
			{ n: 3, ports: [1], on: 2 },
			{ n: 4, ports: [1], on: 3 },
		],
		{
			switches: 4,
			cables: [
				[0, 6, 1, 6, "cut"],
				[0, 7, 2, 7, "cut"],
				[0, 8, 3, 8],
				[1, 7, 2, 6, "cut"],
				[1, 8, 3, 7],
				[2, 8, 3, 6],
			],
		},
	);
	const [node1, , , node4] = lab.machines;
	try {
		assert.ok(await pings(lab, 0, "node2"), "the star of three cables carries a ping");
		assert.equal(lab.storms.length, 0);
		for (const [sw, port] of [
			[0, 6],
			[0, 7],
			[1, 7],
		] as const) {
			lab.switches[sw].setLink(port, true);
		}
		await node1.exec(`arping -c 1 -w 1 -I eth0 ${NOBODY}`);
		await wait(1500);
		for (const [i, sw] of lab.switches.entries()) {
			const storm = sw.storm();
			// Three cables bring each switch looped frames, at up to a thousand a second each.
			assert.ok(storm && storm.rate > 1500 && storm.rate <= 3000, `switch ${i} storms at ${storm?.rate} a second`);
			assert.ok(sw.dropped > 500, `switch ${i} has dropped ${sw.dropped}`);
			assert.equal(storm?.dropped, sw.dropped, "all of them since its storm began");
		}
		const started = performance.now();
		assert.equal((await node4.run("echo answered")).trim(), "answered");
		assert.ok(performance.now() - started < 1000, "a machine answers within a second");

		// One cut leaves other loops whole.
		lab.switches[0].setLink(6, false);
		await wait(700);
		assert.equal(lab.storms.filter((s) => s.over).length, 0, "no storm is over after one cut");
		for (const sw of lab.switches) assert.ok(sw.storm(), "each still storms");

		// Two more leave a star, which has no loop.
		lab.switches[0].setLink(7, false);
		const cutAt = lab.now();
		lab.switches[1].setLink(7, false);
		const over = await until(() => lab.storms.filter((s) => s.over).length === 4, 1000, "the storms end");
		assert.ok(over < 1000, `every storm was over ${over.toFixed(0)} ms after the last cut`);
		const lastLooped = Math.max(...lab.frames.filter((e) => e.looped).map((e) => e.at));
		// What waited in the cables that are left goes on at their pace: up to 64 frames a hop, one a millisecond.
		assert.ok(lastLooped - cutAt < 400, `the last looped frame came ${(lastLooped - cutAt).toFixed(1)} ms after it`);
		assert.ok(await pings(lab, 0, "node2", 1), "node1 reaches node2 again");
		assert.ok(await pings(lab, 2, "node4", 1), "and node3 reaches node4");
	} finally {
		await lab.stop();
	}
});
