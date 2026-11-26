// Real kernels on cables with conditions: a NIC's cable and one between two
// switches, with the fabric on Node's own clock. What a cable loses and
// reorders is seeded, so each run takes the same frames.
import assert from "node:assert/strict";
import { test } from "vitest";
import { bootLab, type TestLab, type TestMachine } from "./lab.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** What each test measured, for whoever reads the run. */
const measured = (what: string, values: object) => console.log(`measured | ${what} | ${JSON.stringify(values)}`);

/** node1 on the first switch and node2 on the second, which a cable from port 8 to port 7 joins, and node3 beside node1. */
const joined = () =>
	bootLab(
		[
			{ n: 1, ports: [1], on: 0 },
			{ n: 2, ports: [1], on: 1 },
			{ n: 3, ports: [3], on: 0 },
		],
		{ switches: 2, cables: [[0, 8, 1, 7]] },
	);

/** A ping's average round trip in ms, by the guest's own clock. */
async function roundTrip(from: TestMachine, to: string, count = 5): Promise<number> {
	const out = await from.run(`ping -c ${count} -W 2 ${to}`);
	const avg = /min\/avg\/max = [\d.]+\/([\d.]+)\//.exec(out);
	assert.ok(avg, out);
	return Number(avg[1]);
}

const pings = async (from: TestMachine, to: string, options = ""): Promise<boolean> =>
	(await from.exec(`ping -c 2 -W 1 ${options} ${to}`)).exitCode === 0;

/** The number of each echo request or reply that a switch took in by the port, in the order they came. */
const echoes = (lab: TestLab, sw: number, port: number, type: 0 | 8, since = 0): number[] =>
	lab.frames
		.slice(since)
		.filter((e) => e.switch === sw && e.from === port && e.dropped.length === 0)
		.filter(({ frame }) => frame[12] === 8 && frame[13] === 0 && frame[23] === 1 && frame[34] === type)
		.map(({ frame }) => (frame[40] << 8) | frame[41]);

const sorted = (list: readonly number[]): boolean => list.every((n, i) => i === 0 || list[i - 1] <= n);

test("100 ms of delay on a NIC's cable, or on a cable between switches, adds about 200 ms to a ping's round trip, and slows no other cable", async () => {
	const lab = await joined();
	const [node1, , node3] = lab.machines;
	try {
		const base = await roundTrip(node1, "node2");
		const beside = await roundTrip(node3, "node2");

		lab.switches[0].setConditions(1, { delay: 100 });
		const nic = await roundTrip(node1, "node2");
		const other = await roundTrip(node3, "node2");
		lab.switches[0].setConditions(1, {});
		const cleared = await roundTrip(node1, "node2");

		lab.switches[1].setConditions(7, { delay: 100 });
		const between = await roundTrip(node1, "node2");
		lab.switches[0].setConditions(1, { delay: 100 });
		const both = await roundTrip(node1, "node2");
		measured("ping round trip, ms", { base, beside, nic, other, cleared, between, both });

		for (const [what, ms, delays] of [
			["on node1's cable", nic, 2],
			["on the cable between the switches", between, 2],
			["on both", both, 4],
		] as const) {
			// No less than the delays themselves, and no more than what the ping took without them on top. The other
			// tests' machines boot beside this one, so a ping with no delay can take a few ms.
			const least = delays * 100;
			assert.ok(ms >= least && ms <= least + base + 25, `${what}: ${ms} ms, ${(ms - base).toFixed(1)} ms added`);
		}
		assert.ok(other < 50, `node3 to node2 has none of the delay while node1's cable is slow: ${other} ms`);
		assert.ok(cleared < 50, `and node1 has none of it once the delay is gone: ${cleared} ms`);
	} finally {
		await lab.stop();
	}
});

test("with 20% loss on a cable, the share of 1,000 frames that it loses in one direction is within three points of it, by the receiver's count and by the cable's", async () => {
	const lab = await bootLab([
		{ n: 1, ports: [1] },
		{ n: 2, ports: [2] },
	]);
	const [node1, node2] = lab.machines;
	try {
		assert.ok(await pings(node1, "node2"), "they reach each other before the cable is bad");
		lab.sw.setConditions(1, { loss: 20 });
		const received = async () => Number(await node2.run("cat /sys/class/net/eth0/statistics/rx_packets"));
		const before = { rx: await received(), frames: lab.frames.length, cable: lab.sw.carried(1) };

		const out = (await node1.exec("ping -c 1000 -i 0.01 -W 1 -q node2")).stdout;
		const sent = /(\d+) packets transmitted, (\d+) packets received/.exec(out);
		assert.ok(sent, out);
		assert.equal(Number(sent[1]), 1000, "node1 sent 1,000 pings");

		// Each ping is one frame towards node2. Those that node1's cable lost never came into the switch.
		const arrived = echoes(lab, 0, 1, 8, before.frames).length;
		const lostThere = (1000 - arrived) / 1000;
		const rx = (await received()) - before.rx;
		const cable = lab.sw.carried(1);
		const dropped = cable.dropped.loss - before.cable.dropped.loss;
		const offered = cable.delivered - before.cable.delivered + dropped;
		const tapped = lab.frames.slice(before.frames).filter((e) => e.dropped.some(({ reason }) => reason === "loss"));
		measured("20% loss on node1's cable", {
			sent: 1000,
			arrived,
			share: lostThere,
			node2Received: rx,
			pingsAnswered: Number(sent[2]),
			cableOffered: offered,
			cableDropped: dropped,
			cableShare: dropped / offered,
		});
		assert.ok(Math.abs(lostThere - 0.2) <= 0.03, `${lostThere * 100}% of the pings were lost on the way there`);
		assert.ok(Math.abs(rx - arrived) <= 3, `node2's own count of what it received agrees: ${rx} and ${arrived}`);
		// The cable counts both directions: the pings, and the replies to those that arrived.
		assert.ok(offered >= 1000 + arrived, `the cable was offered ${offered} frames`);
		assert.ok(Math.abs(dropped / offered - 0.2) <= 0.03, `and lost ${dropped} of them`);
		assert.equal(tapped.length, dropped, "each is in the tap, with loss as its reason");

		lab.sw.setConditions(1, { loss: 100 });
		assert.equal(await pings(node1, "node2"), false, "at 100% nothing is answered");
		lab.sw.setConditions(1, {});
		assert.ok(await pings(node1, "node2"), "and with the loss gone, every ping is");
	} finally {
		await lab.stop();
	}
});

test("with reordering, pings arrive in another order than they were sent in, which the guest and the switch's tap both show", async () => {
	const lab = await bootLab([
		{ n: 1, ports: [1] },
		{ n: 2, ports: [2] },
	]);
	const [node1] = lab.machines;
	try {
		assert.ok(await pings(node1, "node2"));
		const plain = lab.frames.length;
		await node1.run("ping -c 40 -i 0.01 -W 1 -q node2");
		assert.ok(sorted(echoes(lab, 0, 1, 8, plain)), "with no conditions they arrive as they were sent");

		lab.sw.setConditions(1, { delay: 50, reorder: 25 });
		const from = lab.frames.length;
		const out = await node1.run("ping -c 40 -i 0.01 -W 2 node2");
		const answered = [...out.matchAll(/seq=(\d+)/g)].map((m) => Number(m[1]));
		const requests = echoes(lab, 0, 1, 8, from);
		const replies = echoes(lab, 0, 2, 0, from);
		measured("delay 50 ms, reorder 25%", { requests, answered });
		assert.equal(requests.length, 40, "none is lost");
		assert.equal(sorted(requests), false, "the switch took the requests in another order than node1 sent them in");
		assert.deepEqual(replies, requests, "node2 answered them in the order that they came");
		assert.equal(answered.length, 40);
		assert.equal(sorted(answered), false, "and node1 got its answers out of order");
	} finally {
		await lab.stop();
	}
});

test("with a rate of 1 Mbit/s on a cable, a TCP transfer across it runs within 20% of that, and what its queue has no room for is dropped", async () => {
	const lab = await joined();
	const [node1, node2] = lab.machines;
	try {
		assert.ok(await pings(node1, "node2"));
		for (const [what, impair, counters] of [
			[
				"the cable between the switches",
				() => lab.switches[0].setConditions(8, { rate: 1_000_000 }),
				() => lab.switches[0].carried(8),
			],
			["node1's cable", () => lab.switches[0].setConditions(1, { rate: 1_000_000 }), () => lab.switches[0].carried(1)],
		] as const) {
			lab.switches[0].setConditions(8, {});
			lab.switches[0].setConditions(1, {});
			impair();
			const before = counters().dropped.rate;
			const receiving = node2.exec("nc -l -p 5001 | wc -c");
			await wait(500);
			const started = performance.now();
			const sending = node1.exec("dd if=/dev/zero bs=1024 count=1024 2>/dev/null | nc node2 5001");
			const got = await receiving;
			const seconds = (performance.now() - started) / 1000;
			await sending;
			const bytes = Number(got.stdout.trim());
			const mbit = (bytes * 8) / seconds / 1e6;
			const dropped = counters().dropped.rate - before;
			measured(`TCP at 1 Mbit/s on ${what}`, { bytes, seconds, mbit, droppedByRate: dropped });
			assert.equal(bytes, 1024 * 1024, "every byte arrived");
			assert.ok(mbit >= 0.8 && mbit <= 1.2, `${what}: ${mbit.toFixed(3)} Mbit/s`);
			assert.ok(dropped > 0, `${what} dropped ${dropped} frames that its queue had no room for`);
		}
	} finally {
		await lab.stop();
	}
});

test("a frame that holds a packet longer than a cable's MTU is dropped, one of that size passes, and the tap says why", async () => {
	const lab = await joined();
	const [node1] = lab.machines;
	try {
		assert.ok(await pings(node1, "node2", "-s 1472"), "a full 1,500-byte packet crosses before any MTU is set");
		for (const [what, sw, port] of [
			["node1's cable", 0, 1],
			["the cable between the switches", 1, 7],
		] as const) {
			lab.switches[0].setConditions(1, {});
			lab.switches[1].setConditions(7, {});
			lab.switches[sw].setConditions(port, { mtu: 1400 });
			const from = lab.frames.length;
			const before = lab.switches[sw].carried(port).dropped.mtu;
			// A ping of 1,372 bytes is a packet of 1,400 with its headers, and one byte more is too long.
			assert.ok(await pings(node1, "node2", "-s 1372"), `${what}: a packet of 1,400 bytes passes`);
			assert.ok(await pings(node1, "node2"), `${what}: and so does a short one`);
			assert.equal(await pings(node1, "node2", "-s 1373"), false, `${what}: a packet of 1,401 bytes does not`);
			const dropped = lab.frames.slice(from).filter((e) => e.dropped.some(({ reason }) => reason === "mtu"));
			const counted = lab.switches[sw].carried(port).dropped.mtu - before;
			measured(`MTU 1400 on ${what}`, { dropped: dropped.length, counted, bytes: dropped.map((e) => e.frame.length) });
			assert.ok(
				dropped.length >= 2 && dropped.every((e) => e.frame.length === 1415),
				"each dropped frame is 1,415 bytes",
			);
			assert.equal(counted, dropped.length, "and the cable counted each");
		}
	} finally {
		await lab.stop();
	}
});
