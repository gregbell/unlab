// Real kernels on a triangle of switches that take part in a spanning tree,
// with the fabric and the protocol's timers on Node's own clock. The tests
// share one lab, so three machines boot once, and each begins by putting the
// lab as it needs it, so any of them runs alone.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { arpAddrs, decodeBpdu, ETH_HDR, ip4, ipAddrs, isForBridges } from "../../src/net/index.ts";
import { EDGE_DELAY_MS, HELLO_MS } from "../../src/runtime/rstp.ts";
import { bootLab, type SwitchedTap, type TestLab } from "./lab.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Adds a line to what the run measured, which the job keeps. */
function measured(line: string): void {
	mkdirSync("test-results", { recursive: true });
	appendFileSync("test-results/spanning-tree-kernels.txt", `${line}\n`);
	console.log(line);
}

/** node1, node2 and node3 on port 1 of switches 0, 1 and 2, which three cables join in a triangle. */
let lab: TestLab;

// The cable from switch 2 to switch 0 is cut while the machines boot, so that nothing they send then goes round.
beforeAll(async () => {
	lab = await bootLab(
		[
			{ n: 1, ports: [1], on: 0, distro: "lab" },
			{ n: 2, ports: [1], on: 1, distro: "lab" },
			{ n: 3, ports: [1], on: 2, distro: "lab" },
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
});
afterAll(() => lab?.stop());

const pings = async (from: number, to: string, count = 2): Promise<boolean> =>
	(await lab.machines[from].exec(`ping -c ${count} -W 1 ${to}`)).exitCode === 0;

/** One ARP request from node1 for an address that nobody has: a single broadcast. Each test asks for one of its own. */
const ask = (address: string) => lab.machines[0].exec(`arping -c 1 -w 1 -I eth0 ${address}`);

/** The ARP requests for an address, as the switches carried them. */
const asked = (address: string): SwitchedTap[] => lab.frames.filter((e) => arpAddrs(e.frame)?.tpa === ip4(address));

/** `2:8 alternate discarding`, for each port that a cable to a switch is in and the tree has. */
const ports = (): string[] =>
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

/** The triangle with every switch taking part: switch 2's port to switch 1 carries nothing. */
const BLOCKED = [
	"0:7 designated forwarding",
	"0:8 designated forwarding",
	"1:7 designated forwarding",
	"1:8 root forwarding",
	"2:7 root forwarding",
	"2:8 alternate discarding",
];
const blocked = (what: string) => until(() => ports().join() === BLOCKED.join(), 2000, what);

/** Every switch takes part and every cable is in, whatever the test before left. */
async function agreed(): Promise<void> {
	for (const sw of lab.switches) if (!sw.tree()) sw.setTree(true);
	lab.switches[2].setLink(7, true);
	await blocked("the three agree");
}

/** The storms that are on now. */
const storming = (): number => lab.switches.filter((sw) => sw.storm() !== null).length;

/** An echo reply that a switch handed to the machine on its port 1. */
const repliedTo = (e: SwitchedTap, on: number): boolean => {
	const ip = ipAddrs(e.frame);
	return e.switch === on && (e.to & 1) === 1 && ip?.proto === 1 && e.frame[ETH_HDR + ip.ihl] === 0;
};

test("in a triangle of switches with spanning tree on, one port blocks, a broadcast reaches each machine once, pings work, and a guest's tcpdump sees the tree's messages", async () => {
	const [, node2, node3] = lab.machines;
	for (const sw of lab.switches) sw.setTree(true);
	// The cable that makes the line a triangle goes in.
	const closedAt = lab.now();
	lab.switches[2].setLink(7, true);
	await blocked("the three agree");
	const agreedAt = lab.trees.at(-1)?.at ?? 0;
	measured(`three switches agreed on a triangle ${(agreedAt - closedAt).toFixed(1)} ms after its last cable went in`);
	assert.deepEqual(ports(), BLOCKED, "one of the six ports carries nothing");

	for (const machine of [node2, node3]) {
		await machine.run("tcpdump -lnnei eth0 arp > /tmp/heard 2> /tmp/said < /dev/null &");
		await machine.run("for i in $(seq 100); do grep -q listening /tmp/said && exit 0; sleep 0.1; done; exit 1");
	}
	await ask("10.88.0.99");
	await wait(500);
	assert.deepEqual(
		asked("10.88.0.99").map((e) => [e.switch, e.from, e.looped]),
		[
			[0, 1, false],
			[1, 8, false],
			[2, 7, false],
		],
		"each switch carried the one request once, and none of it came round",
	);
	for (const machine of [node2, node3]) {
		const heard = (await machine.run("cat /tmp/heard")).split("\n").filter((line) => line.includes("10.88.0.99"));
		assert.equal(heard.length, 1, `${machine.name} heard the request once: ${heard.join(" | ")}`);
		await machine.exec("pkill tcpdump");
	}
	assert.equal(lab.storms.length, 0, "and nothing stormed");

	assert.ok(await pings(0, "node2"), "node1 reaches node2");
	assert.ok(await pings(1, "node3"), "node2 reaches node3, round by the root");
	assert.ok(await pings(2, "node1"), "node3 reaches node1");
	// node2's pings to node3 go by the root: the port between their switches is blocked at node3's end.
	const crossed = lab.frames.filter((e) => e.at > agreedAt && e.switch === 2 && e.from === 8 && !isForBridges(e.frame));
	assert.equal(crossed.length, 0, "no frame but the tree's own came in by the blocked port");

	const dumped = await node3.run("timeout 10 tcpdump -lnnei eth0 -c 2 ether dst 01:80:c2:00:00:00 2>/dev/null");
	assert.match(dumped, /802\.1w|STP|Rapid/, `tcpdump reads the switch's messages: ${dumped}`);
	const said = lab.frames.find((e) => e.switch === 2 && e.from === 7 && isForBridges(e.frame));
	assert.ok(said, "the root's message reached switch 2 as a frame");
	assert.equal(decodeBpdu(said.frame)?.root, "8000020000000001");
});

test("cutting a cable in use brings the blocked port into use, and pings resume well within three hellos", async () => {
	const [, , node3] = lab.machines;
	await agreed();
	assert.ok(await pings(2, "node1"), "node3 reaches node1 by the cable between their switches");
	assert.ok(await pings(1, "node3"), "and node2 reaches node3 by the root");

	// With node3 silent, the cable is cut. Switch 1 has node3 by way of the root, and node2 has its address, so node2's
	// ping is one frame for node3 and no question to everyone: it arrives only if switch 1 was told to forget.
	const quietAt = lab.now();
	lab.switches[2].setLink(7, false);
	assert.ok(await pings(1, "node3", 1), "node2 reaches node3, which has said nothing since the cut");
	const told = lab.frames.find((e) => e.at >= quietAt && e.switch === 1 && e.from === 7 && isForBridges(e.frame));
	assert.equal(told && decodeBpdu(told.frame)?.topologyChange, true, "switch 2 said that the topology had changed");
	assert.equal(asked("10.88.0.13").filter((e) => e.at >= quietAt).length, 0, "and node2 asked nobody for node3");
	lab.switches[2].setLink(7, true);
	await blocked("the cable is back in use");

	// node3 pings node1 fifty times a second, and the cable that carries them is cut.
	const gaps: number[] = [];
	const trees: number[] = [];
	for (let round = 0; round < 5; round++) {
		const stream = node3.exec("ping -i 0.02 -c 100 -W 1 node1");
		await wait(700);
		const before = lab.frames.findLast((e) => repliedTo(e, 2))?.at ?? 0;
		const cutAt = lab.now();
		lab.switches[2].setLink(7, false);
		const done = await stream;
		const tree = lab.trees.find((said) => said.at >= cutAt && said.switch === 2)?.at ?? Number.NaN;
		const after = lab.frames.find((e) => e.at > cutAt && repliedTo(e, 2))?.at ?? Number.NaN;
		const lost = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(done.stdout);
		assert.ok(lost, done.stdout);
		assert.deepEqual(
			ports(),
			["0:7 designated forwarding", "1:7 designated forwarding", "1:8 root forwarding", "2:8 root forwarding"],
			"the port that was blocked is switch 2's way to the root",
		);
		assert.ok(after - cutAt < 3 * HELLO_MS, `a ping was answered ${(after - cutAt).toFixed(1)} ms after the cut`);
		gaps.push(after - cutAt);
		trees.push(tree - cutAt);
		measured(
			`round ${round + 1}: the blocked port carried ${(tree - cutAt).toFixed(1)} ms after the cut, a ping was answered ${(after - cutAt).toFixed(1)} ms after it and ${(after - before).toFixed(1)} ms after the one before, and ${Number(lost[1]) - Number(lost[2])} of ${lost[1]} pings were lost`,
		);
		assert.ok(await pings(1, "node3", 1), "node2 reaches node3, now by the cable that was blocked");

		lab.switches[2].setLink(7, true);
		await blocked("the cable is back in use");
		assert.equal(lab.storms.length, 0, "with no storm");
		assert.ok(await pings(2, "node1", 1), "and it carries node3's pings again");
	}
	const sorted = [...gaps].sort((a, b) => a - b);
	measured(
		`cut to the first answered ping over ${gaps.length} cuts: median ${sorted[2].toFixed(1)} ms, from ${sorted[0].toFixed(1)} to ${sorted[4].toFixed(1)} ms. Cut to the blocked port carrying: ${Math.min(...trees).toFixed(1)} to ${Math.max(...trees).toFixed(1)} ms`,
	);
});

test("turning spanning tree on during a storm ends the storm, and pings work", async () => {
	// No switch takes part, so the triangle is a loop that the next broadcast goes round.
	for (const sw of lab.switches) sw.setTree(false);
	lab.switches[2].setLink(7, true);
	await ask("10.88.0.98");
	await until(() => storming() === 3, 2000, "every switch storms");
	await wait(1000);
	assert.ok(asked("10.88.0.98").filter((e) => e.looped).length > 500, "one broadcast goes round and round");
	const over = lab.storms.filter((s) => s.over).length;

	const onAt = lab.now();
	for (const sw of lab.switches) sw.setTree(true);
	const took = await until(() => lab.storms.filter((s) => s.over).length === over + 3, 2000, "the storms end");
	const lastLooped = Math.max(...lab.frames.filter((e) => e.looped).map((e) => e.at));
	measured(
		`turned on in a storm: the last looped frame came ${(lastLooped - onAt).toFixed(1)} ms after, and every storm was over in ${took.toFixed(0)} ms`,
	);
	assert.ok(lastLooped - onAt < 200, `the last looped frame came ${(lastLooped - onAt).toFixed(1)} ms after`);
	assert.deepEqual(ports(), BLOCKED);
	assert.equal(storming(), 0);

	await ask("10.88.0.97");
	await wait(300);
	assert.equal(asked("10.88.0.97").length, 3, "a broadcast is now carried once by each switch");
	assert.ok(await pings(1, "node1", 1), "node2 reaches node1");
	assert.ok(await pings(0, "node3", 1), "and node1 reaches node3");
	assert.ok(await pings(2, "node2", 1), "and node3 reaches node2");
});

test("a cable to a switch with spanning tree off still makes a loop, and that loop storms", async () => {
	await agreed();
	// Switch 2 stops taking part, and its cable to switch 0 is cut and put back: a cable to a switch with it off.
	lab.switches[2].setLink(7, false);
	lab.switches[2].setTree(false);
	const line = ["0:7 designated forwarding", "1:7 designated forwarding", "1:8 root forwarding"];
	await until(() => ports().join() === line.join(), 2000, "the two that take part are a line");
	const offAt = lab.now();

	const closedAt = lab.now();
	lab.switches[2].setLink(7, true);
	// Switch 0 proposes to switch 2 for three seconds, and is answered nothing. A broadcast in that time goes round no loop.
	await ask("10.88.0.96");
	const all = ["0:7", "0:8", "1:7", "1:8"];
	await until(
		() => ports().filter((port) => port.endsWith(" forwarding")).length === all.length,
		EDGE_DELAY_MS + 1000,
		"the port towards the switch that takes no part carries",
	);
	const whole = (lab.trees.findLast((said) => said.switch === 0)?.at ?? Number.NaN) - closedAt;
	measured(`a loop through a switch with spanning tree off was whole ${whole.toFixed(0)} ms after its cable went in`);
	// No sooner than the three seconds that a port proposes for, and as soon after as its timer is run.
	assert.ok(whole >= EDGE_DELAY_MS - 5 && whole < EDGE_DELAY_MS + 1000, `the loop was whole after ${whole} ms`);
	assert.ok(asked("10.88.0.96").length > 0, "the broadcast of those three seconds was carried");
	assert.ok(
		asked("10.88.0.96").every((e) => !e.looped),
		"and none of it came round",
	);
	assert.equal(
		lab.storms.filter((s) => !s.over && s.at >= closedAt && s.at < closedAt + whole).length,
		0,
		"so nothing stormed before the three seconds were up",
	);

	// Switches 0 and 1 hear nothing through switch 2, so neither sees the loop, and the next broadcast goes round.
	await ask("10.88.0.95");
	await until(() => storming() === 3, 2000, "the loop storms");
	assert.ok(asked("10.88.0.95").filter((e) => e.looped).length > 100, "one broadcast goes round and round");
	assert.equal(
		lab.frames.filter((e) => e.at >= offAt && e.switch === 2 && isForBridges(e.frame)).length,
		0,
		"switch 2 takes in none of the tree's messages",
	);

	// With it on for the third, the three see the loop, and the storm ends.
	lab.switches[2].setTree(true);
	await until(() => storming() === 0, 2000, "the storm ends");
	assert.deepEqual(ports(), BLOCKED);
	assert.ok(await pings(1, "node1", 1), "and pings work");
});
