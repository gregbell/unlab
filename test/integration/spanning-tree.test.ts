// Real kernels on a triangle of switches that take part in a spanning tree,
// with the fabric and the protocol's timers on Node's own clock.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { test } from "vitest";
import { arpAddrs, decodeBpdu, ETH_HDR, ip4, ipAddrs, isForBridges } from "../../src/net/index.ts";
import { EDGE_DELAY_MS, HELLO_MS } from "../../src/runtime/rstp.ts";
import { bootLab, type SwitchedTap, type TestLab } from "./lab.ts";

const NOBODY = "10.88.0.99";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adds a line to what the run measured, which the job keeps. */
function measured(line: string): void {
	mkdirSync("test-results", { recursive: true });
	appendFileSync("test-results/spanning-tree-kernels.txt", `${line}\n`);
	console.log(line);
}

const pings = async (lab: TestLab, from: number, to: string, count = 2): Promise<boolean> =>
	(await lab.machines[from].exec(`ping -c ${count} -W 1 ${to}`)).exitCode === 0;

/** The ARP requests for an address, as the switches carried them. */
const asked = (lab: TestLab, address = NOBODY): SwitchedTap[] =>
	lab.frames.filter((e) => arpAddrs(e.frame)?.tpa === ip4(address));

/** `2:8 alternate discarding`, for each port that a cable to a switch is in and the tree has. */
const ports = (lab: TestLab): string[] =>
	lab.switches.flatMap((sw, i) =>
		(sw.tree()?.ports ?? [])
			.filter(({ port }) => port !== 1)
			.map(({ port, role, state }) => `${i}:${port} ${role} ${state}`),
	);

/** Waits until `done`, and says how long that took, or throws after `ms`. */
async function until(done: () => boolean, ms: number, what: string): Promise<number> {
	const started = performance.now();
	while (!done()) {
		if (performance.now() - started > ms) throw new Error(`${what}: not within ${ms} ms`);
		await wait(5);
	}
	return performance.now() - started;
}

/** node1, node2 and node3 on port 1 of switches 0, 1 and 2, which three cables join in a triangle. */
const triangle = (last?: "cut") =>
	bootLab(
		[
			{ n: 1, ports: [1], on: 0, distro: "lab" },
			{ n: 2, ports: [1], on: 1, distro: "lab" },
			{ n: 3, ports: [1], on: 2, distro: "lab" },
		],
		{
			switches: 3,
			cables: [[0, 7, 1, 8], [1, 7, 2, 8], last ? [2, 7, 0, 8, last] : [2, 7, 0, 8]],
		},
	);

const BLOCKED = [
	"0:7 designated forwarding",
	"0:8 designated forwarding",
	"1:7 designated forwarding",
	"1:8 root forwarding",
	"2:7 root forwarding",
	"2:8 alternate discarding",
];

/** Has every switch take part, and waits until they have agreed on the triangle. */
async function agreed(lab: TestLab): Promise<void> {
	for (const sw of lab.switches) sw.setTree(true);
	await until(() => ports(lab).join() === BLOCKED.join(), 2000, "the three agree");
}

/** An echo reply that a switch handed to the machine on its port 1. */
const repliedTo = (e: SwitchedTap, on: number): boolean => {
	const ip = ipAddrs(e.frame);
	return e.switch === on && (e.to & 1) === 1 && ip?.proto === 1 && e.frame[ETH_HDR + ip.ihl] === 0;
};

test("in a triangle of switches with spanning tree on, one port blocks, a broadcast reaches each machine once, pings work, and a guest's tcpdump sees the tree's messages", async () => {
	const lab = await triangle();
	const [node1, node2, node3] = lab.machines;
	try {
		const began = lab.now();
		await agreed(lab);
		const took = lab.trees.at(-1)?.at ?? 0;
		measured(`three switches agreed on a triangle ${(took - began).toFixed(1)} ms after spanning tree was turned on`);
		assert.deepEqual(ports(lab), BLOCKED, "one of the six ports carries nothing");

		for (const machine of [node2, node3]) {
			await machine.run("tcpdump -lnnei eth0 arp > /tmp/heard 2> /tmp/said < /dev/null &");
			await machine.run("for i in $(seq 100); do grep -q listening /tmp/said && exit 0; sleep 0.1; done; exit 1");
		}
		await node1.exec(`arping -c 1 -w 1 -I eth0 ${NOBODY}`);
		await wait(500);
		assert.deepEqual(
			asked(lab).map((e) => [e.switch, e.from, e.looped]),
			[
				[0, 1, false],
				[1, 8, false],
				[2, 7, false],
			],
			"each switch carried the one request once, and none of it came round",
		);
		for (const machine of [node2, node3]) {
			const heard = (await machine.run("cat /tmp/heard")).split("\n").filter((line) => line.includes(NOBODY));
			assert.equal(heard.length, 1, `${machine.name} heard the request once: ${heard.join(" | ")}`);
		}
		assert.equal(lab.storms.length, 0, "and nothing stormed");

		assert.ok(await pings(lab, 0, "node2"), "node1 reaches node2");
		assert.ok(await pings(lab, 1, "node3"), "node2 reaches node3, round by the root");
		assert.ok(await pings(lab, 2, "node1"), "node3 reaches node1");
		// node2's pings to node3 go by the root: the port between their switches is blocked at node3's end.
		const crossed = lab.frames.filter((e) => e.switch === 2 && e.from === 8 && !isForBridges(e.frame));
		assert.equal(crossed.length, 0, "no frame but the tree's own came in by the blocked port");

		const dumped = await node3.run("timeout 10 tcpdump -lnnei eth0 -c 2 ether dst 01:80:c2:00:00:00 2>/dev/null");
		assert.match(dumped, /802\.1w|STP|Rapid/, `tcpdump reads the switch's messages: ${dumped}`);
		const said = lab.frames.find((e) => e.switch === 2 && e.from === 7 && isForBridges(e.frame));
		assert.ok(said, "the root's message reached switch 2 as a frame");
		assert.equal(decodeBpdu(said.frame)?.root, "8000020000000001");
	} finally {
		await lab.stop();
	}
});

test("cutting a cable in use brings the blocked port into use, and pings resume well within three hellos", async () => {
	const lab = await triangle();
	const [, , node3] = lab.machines;
	try {
		await agreed(lab);
		assert.ok(await pings(lab, 2, "node1"), "node3 reaches node1 by the cable between their switches");
		assert.ok(await pings(lab, 1, "node3"), "and node2 reaches node3 by the root");
		// Long enough that each port may send at once again: agreeing took most of the six messages a second allows.
		await wait(3 * HELLO_MS);

		// node3 pings node1 fifty times a second, and the cable that carries them is cut.
		const gaps: number[] = [];
		const trees: number[] = [];
		for (let round = 0; round < 5; round++) {
			const stream = node3.exec("ping -i 0.02 -c 150 -W 1 node1");
			await wait(1000);
			const before = lab.frames.findLast((e) => repliedTo(e, 2))?.at ?? 0;
			const cutAt = lab.now();
			lab.switches[2].setLink(7, false);
			const done = await stream;
			const tree = lab.trees.find((told) => told.at >= cutAt && told.switch === 2)?.at ?? Number.NaN;
			const after = lab.frames.find((e) => e.at > cutAt && repliedTo(e, 2))?.at ?? Number.NaN;
			const lost = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(done.stdout);
			assert.ok(lost, done.stdout);
			assert.deepEqual(
				ports(lab),
				["0:7 designated forwarding", "1:7 designated forwarding", "1:8 root forwarding", "2:8 root forwarding"],
				"the port that was blocked is switch 2's way to the root",
			);
			assert.ok(after - cutAt < 3 * HELLO_MS, `a ping was answered ${(after - cutAt).toFixed(1)} ms after the cut`);
			gaps.push(after - cutAt);
			trees.push(tree - cutAt);
			measured(
				`round ${round + 1}: the blocked port carried ${(tree - cutAt).toFixed(1)} ms after the cut, a ping was answered ${(after - cutAt).toFixed(1)} ms after it and ${(after - before).toFixed(1)} ms after the one before, and ${Number(lost[1]) - Number(lost[2])} of ${lost[1]} pings were lost`,
			);
			assert.ok(await pings(lab, 1, "node3", 1), "node2 reaches node3, now by the cable that was blocked");

			lab.switches[2].setLink(7, true);
			await until(() => ports(lab).join() === BLOCKED.join(), 2000, "the cable is back in use");
			assert.equal(lab.storms.length, 0, "with no storm");
			assert.ok(await pings(lab, 2, "node1", 1), "and it carries node3's pings again");
			await wait(3 * HELLO_MS);
		}
		const sorted = [...gaps].sort((a, b) => a - b);
		measured(
			`cut to the first answered ping over ${gaps.length} cuts: median ${sorted[2].toFixed(1)} ms, from ${sorted[0].toFixed(1)} to ${sorted[4].toFixed(1)} ms. Cut to the blocked port carrying: ${Math.min(...trees).toFixed(1)} to ${Math.max(...trees).toFixed(1)} ms`,
		);
	} finally {
		await lab.stop();
	}
});

test("turning spanning tree on during a storm ends the storm, and pings work", async () => {
	// The loop is open while the machines boot, so that the broadcast that storms is the one the test sends.
	const lab = await triangle("cut");
	const [node1] = lab.machines;
	try {
		assert.ok(await pings(lab, 0, "node3"), "the line of three carries a ping");
		lab.switches[2].setLink(7, true);
		await node1.exec(`arping -c 1 -w 1 -I eth0 ${NOBODY}`);
		await wait(1000);
		for (const [i, sw] of lab.switches.entries()) assert.ok(sw.storm(), `switch ${i} storms`);

		const onAt = lab.now();
		for (const sw of lab.switches) sw.setTree(true);
		const over = await until(() => lab.storms.filter((s) => s.over).length === 3, 2000, "the storms end");
		const lastLooped = Math.max(...lab.frames.filter((e) => e.looped).map((e) => e.at));
		measured(
			`turned on in a storm: the last looped frame came ${(lastLooped - onAt).toFixed(1)} ms after, and every storm was over in ${over.toFixed(0)} ms`,
		);
		assert.ok(lastLooped - onAt < 200, `the last looped frame came ${(lastLooped - onAt).toFixed(1)} ms after`);
		assert.deepEqual(ports(lab), BLOCKED);
		for (const sw of lab.switches) assert.equal(sw.storm(), null);

		const before = asked(lab, "10.88.0.98").length;
		await node1.exec("arping -c 1 -w 1 -I eth0 10.88.0.98");
		await wait(300);
		assert.equal(asked(lab, "10.88.0.98").length - before, 3, "a broadcast is now carried once by each switch");
		assert.ok(await pings(lab, 1, "node1", 1), "node2 reaches node1");
		assert.ok(await pings(lab, 0, "node3", 1), "and node1 reaches node3");
		assert.ok(await pings(lab, 2, "node2", 1), "and node3 reaches node2");
	} finally {
		await lab.stop();
	}
});

test("a cable to a switch with spanning tree off still makes a loop, and that loop storms", async () => {
	const lab = await triangle("cut");
	const [node1] = lab.machines;
	try {
		// Switches 0 and 1 take part, and switch 2 takes none.
		lab.switches[0].setTree(true);
		lab.switches[1].setTree(true);
		const waiting = ["0:7 designated forwarding", "1:7 designated discarding", "1:8 root forwarding"];
		await until(() => ports(lab).join() === waiting.join(), 2000, "the two agree");
		// The cable from switch 2 to switch 0 goes in. Each of the two proposes to switch 2, which answers nothing.
		const closedAt = lab.now();
		lab.switches[2].setLink(7, true);
		await wait(EDGE_DELAY_MS - 1000);
		await node1.exec(`arping -c 1 -w 1 -I eth0 ${NOBODY}`);
		assert.equal(
			lab.storms.length,
			0,
			"until three seconds are up the ports towards it carry nothing, and nothing storms",
		);
		assert.equal(
			lab.frames.filter((e) => e.switch === 2 && isForBridges(e.frame)).length,
			0,
			"switch 2 takes in none of the tree's messages",
		);

		const all = ["0:7", "0:8", "1:7", "1:8"];
		await until(
			() => ports(lab).filter((port) => port.endsWith(" forwarding")).length === all.length,
			EDGE_DELAY_MS,
			"both ports towards the switch that takes no part carry",
		);
		const whole = lab.now() - closedAt;
		await node1.exec(`arping -c 1 -w 1 -I eth0 ${NOBODY}`);
		await until(() => lab.switches.every((sw) => sw.storm() !== null), 2000, "the loop storms");
		measured(`a loop through a switch with spanning tree off was whole ${whole.toFixed(0)} ms after its cable went in`);
		assert.ok(asked(lab).filter((e) => e.looped).length > 100, "one broadcast goes round and round");

		// With it on for the third, the three see the loop, and the storm ends.
		lab.switches[2].setTree(true);
		await until(() => lab.switches.every((sw) => sw.storm() === null), 2000, "the storm ends");
		assert.deepEqual(ports(lab), BLOCKED);
		assert.ok(await pings(lab, 1, "node1", 1), "and pings work");
	} finally {
		await lab.stop();
	}
});
