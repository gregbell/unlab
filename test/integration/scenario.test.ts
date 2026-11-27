// The gate: the recorded command set of test/fixtures/scenarios/three-subnets.md, run line by line through
// the bar's parser, builds its network on real kernels. The tests share one lab, which the last of them
// saves and opens again, as a reload does.
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import type { Topology } from "../../src/commands/index.ts";
import type { PortRef, SwitchName } from "../../src/model/index.ts";
import { dstMac, ETH_HDR, ip4, ip4str, ipAddrs, srcMac } from "../../src/net/index.ts";
import { inGuests, scenarioLines, THREE_SUBNETS_WIRING, waitsForMachines, wiringOf } from "../support/scenario.ts";
import { type CommandedLab, commandLab, macNames, type NamedTap } from "./commanded.ts";

const LINES = scenarioLines("three-subnets");
const ALICE = ip4("10.1.0.10");
const BOB = ip4("10.3.0.10");
/** The cable that loses frames: r2's eth1, in port 3 of edge. */
const LOSSY: PortRef = { switch: "edge" as SwitchName, port: 3 };

let lab: CommandedLab;

async function run(lines: readonly string[]): Promise<void> {
	for (const line of lines) {
		if (waitsForMachines(line)) await lab.ready();
		await lab.run(line);
	}
}

beforeAll(async () => {
	const started = performance.now();
	lab = await commandLab();
	await run(LINES);
	console.log(`the command set built its lab in ${Math.round(performance.now() - started)} ms`);
}, 180_000);
afterAll(() => lab?.stop());

/** How many of its echoes alice's ping sent, and how many came back. */
async function ping(count: number): Promise<{ sent: number; received: number }> {
	const result = await lab.run(`exec alice -- ping -c ${count} -i 0.2 -W 1 ${ip4str(BOB)}`);
	const output = (result.data as { ran: { output: string }[] }).ran[0].output;
	const said = /(\d+) packets transmitted, (\d+) packets received/.exec(output);
	assert.ok(said, output);
	return { sent: Number(said[1]), received: Number(said[2]) };
}

const portsIn = (mask: number): number[] =>
	Array.from({ length: 8 }, (_, i) => i + 1).filter((p) => mask & (1 << (p - 1)));

interface Echo {
	readonly seq: number;
	readonly request: boolean;
	readonly hop: string;
}

/** Each echo between alice and bob that a switch carried since `from`, as a hop: switch, ports, VLAN, tags, the ends by their NICs, and the TTL. */
function echoes(from: number): Echo[] {
	const names = macNames(lab.state);
	return lab.frames.slice(from).flatMap((e: NamedTap): Echo[] => {
		const ip = ipAddrs(e.frame);
		if (ip?.proto !== 1 || ![ALICE, BOB].includes(ip.src) || ![ALICE, BOB].includes(ip.dst)) return [];
		const at = ETH_HDR + ip.ihl;
		const type = e.frame[at];
		if (type !== 0 && type !== 8) return [];
		const seq = (e.frame[at + 6] << 8) | e.frame[at + 7];
		const tags = e.tagged ? ` tagged ${portsIn(e.tagged).join(",")}` : "";
		const lost = e.dropped.map(({ port, reason }) => ` lost at ${port} to ${reason}`).join("");
		const ends = `${names.get(srcMac(e.frame))} > ${names.get(dstMac(e.frame))}`;
		const hop = `${e.switch} ${e.from} → ${portsIn(e.to).join(",")} vlan ${e.vlan}${tags} ${ends} ttl ${e.frame[ETH_HDR + 8]}${lost}`;
		return [{ seq, request: type === 8, hop }];
	});
}

/** One ping there and back: over the trunk in VLAN 10 to r1, out of r1 in VLAN 20 over the trunk again to r2, and out of r2 in VLAN 30 over the lossy cable to bob. Each router takes one from the TTL. */
const ROUND_TRIP = [
	"edge 1 → 8 vlan 10 tagged 8 alice > r1:eth0 ttl 64",
	"core 8 → 1 vlan 10 tagged 8 alice > r1:eth0 ttl 64",
	"core 2 → 8 vlan 20 tagged 8 r1:eth1 > r2:eth0 ttl 63",
	"edge 8 → 2 vlan 20 tagged 8 r1:eth1 > r2:eth0 ttl 63",
	"edge 3 → 4 vlan 30 r2:eth1 > bob ttl 62",
	"edge 4 → 3 vlan 30 bob > r2:eth1 ttl 64",
	"edge 2 → 8 vlan 20 tagged 8 r2:eth0 > r1:eth1 ttl 63",
	"core 8 → 2 vlan 20 tagged 8 r2:eth0 > r1:eth1 ttl 63",
	"core 1 → 8 vlan 10 tagged 8 r1:eth0 > alice ttl 62",
	"edge 8 → 1 vlan 10 tagged 8 r1:eth0 > alice ttl 62",
];

/** The frames that crossed the lossy cable since `from`, either way, and those it lost: what its counters should have grown by. */
function acrossLossy(from: number): { delivered: number; lost: number } {
	let delivered = 0;
	let lost = 0;
	for (const e of lab.frames.slice(from)) {
		if (e.switch !== LOSSY.switch) continue;
		const crossed = e.from === LOSSY.port || (e.to & (1 << (LOSSY.port - 1))) !== 0;
		const dropped = e.dropped.some(({ port }) => port === LOSSY.port);
		if (dropped) lost++;
		else if (crossed) delivered++;
	}
	return { delivered, lost };
}

/** A ping of ten across the whole network: each echo that came back crossed every hop of the round trip in order, and the lossy cable counted what the switch handed it and what it lost. */
async function crossed(): Promise<void> {
	const from = lab.frames.length;
	const before = lab.carried(LOSSY);
	const { received } = await ping(10);
	assert.ok(received > 0, "some echoes are answered");
	const all = echoes(from);
	const answered = [...new Set(all.filter((e) => !e.request && e.hop.endsWith("> alice ttl 62")).map((e) => e.seq))];
	assert.equal(answered.length, received, "alice heard each reply that the capture handed her");
	for (const seq of answered) {
		assert.deepEqual(
			all.filter((e) => e.seq === seq).map((e) => e.hop),
			ROUND_TRIP,
			`echo ${seq} went the whole way and back, and nowhere else`,
		);
	}
	const after = lab.carried(LOSSY);
	const seen = acrossLossy(from);
	assert.equal(after.delivered - before.delivered, seen.delivered, "the lossy cable counts what it delivered");
	assert.equal(after.dropped.loss - before.dropped.loss, seen.lost, "and what it lost");
	assert.ok(seen.delivered >= 2 * received, "each answered echo crossed it both ways");
}

const wiring = async (): Promise<string[]> => wiringOf((await lab.run("topology")).data as Topology);

test("one recorded set of commands builds three subnets, two routers, a VLAN trunk between two switches and one cable that loses frames", async () => {
	assert.deepEqual(await wiring(), THREE_SUBNETS_WIRING);
	const routes = await lab.run("exec all -- ip -4 -o addr show scope global; sysctl -n net.ipv4.ip_forward");
	const ran = (routes.data as { ran: { session: string; output: string }[] }).ran;
	const seen = ran.map(({ session, output }) => {
		const inets = [...output.matchAll(/(eth\d)\s+inet (\S+)/g)].map(([, nic, address]) => `${nic} ${address}`);
		return `${session.split(":")[0]}: ${inets.join(", ")}, forwarding ${output.trim().split("\n").at(-1)}`;
	});
	assert.deepEqual(seen, [
		"alice: eth0 10.1.0.10/24, forwarding 0",
		"r1: eth0 10.1.0.1/24, eth1 10.2.0.1/24, forwarding 1",
		"r2: eth0 10.2.0.2/24, eth1 10.3.0.1/24, forwarding 1",
		"bob: eth0 10.3.0.10/24, forwarding 0",
	]);
});

test("a ping between machines on the first and third subnets crosses both routers, the trunk and the lossy cable", async () => {
	await crossed();
});

test("with the loss set to zero every ping is answered, and with it set to 100% none is", async () => {
	await lab.run("link up r2:eth1 --loss 0");
	let from = lab.frames.length;
	let before = lab.carried(LOSSY);
	assert.deepEqual(await ping(20), { sent: 20, received: 20 });
	assert.equal(lab.carried(LOSSY).dropped.loss, before.dropped.loss, "a cable with no loss loses nothing");
	assert.ok(acrossLossy(from).delivered >= 40, "every echo and its reply crossed it");

	await lab.run("link up r2:eth1 --loss 100%");
	from = lab.frames.length;
	before = lab.carried(LOSSY);
	assert.deepEqual(await ping(20), { sent: 20, received: 0 });
	const after = lab.carried(LOSSY);
	assert.equal(after.delivered, before.delivered, "a cable that loses everything delivers nothing");
	assert.ok(after.dropped.loss > before.dropped.loss, "and counts what it lost");
	assert.deepEqual(
		echoes(from).filter((e) => !e.request),
		[],
		"no echo reply was sent",
	);
	await lab.run("link up r2:eth1 --loss 10%");
});

test("a reload brings the whole topology back, and the ping crosses it again", async () => {
	const before = await wiring();
	const saved = lab.saved();
	await lab.stop();
	lab = await commandLab(saved);
	await lab.ready();
	assert.deepEqual(await wiring(), before, "every switch, cable, VLAN, trunk and condition is back");
	// A boot forgets routes and forwarding, so the lines that set them in the guests run again, and only those.
	await run(LINES.filter(inGuests));
	await crossed();
}, 180_000);
