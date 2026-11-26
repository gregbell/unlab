// Machines with more than one NIC, on real kernels: the interfaces themselves,
// routing between them, and what happens when one of them misbehaves.
import { afterEach, describe, expect, test } from "vitest";
import { arpAddrs, dstMac, IP_ICMP, IP_TCP, ip4, ipAddrs, srcMac } from "../../src/net/index.ts";
import type { TapEvent } from "../../src/runtime/fabric.ts";
import { bootLab, type MachineSetup, type TestLab, type TestMachine } from "./lab.ts";

const ETHERNET_MAX = 1514;
const MEGABYTES = 8;

const running: TestLab[] = [];
async function lab(...setups: MachineSetup[]): Promise<TestLab> {
	const booted = await bootLab(setups);
	running.push(booted);
	return booted;
}
afterEach(async () => {
	await Promise.all(running.splice(0).map((l) => l.stop()));
});

/** node1 and node3 in different subnets, with node2 forwarding from its eth0 to its eth1. */
async function routed(): Promise<{ lab: TestLab; left: TestMachine; router: TestMachine; right: TestMachine }> {
	const l = await lab(
		{ n: 1, ports: [1], gateway: true },
		{ n: 2, ports: [2, 3], gateway: true },
		{ n: 3, ports: [4], gateway: true },
	);
	const [left, router, right] = l.machines;
	await router.run("ip addr add 10.2.0.1/24 dev eth1 && sysctl -w net.ipv4.ip_forward=1");
	await left.run("ip route add 10.2.0.0/24 via 10.88.0.12");
	await right.run(
		"ip addr del 10.88.0.13/24 dev eth0; ip addr add 10.2.0.3/24 dev eth0 && ip route add 10.88.0.0/24 via 10.2.0.1",
	);
	return { lab: l, left, router, right };
}

const received = (out: string): string | undefined => /(\d+) packets received|(\d+) received/.exec(out)?.[0];
const isEcho = (e: TapEvent): boolean => ipAddrs(e.frame)?.proto === IP_ICMP;
const hop = (e: TapEvent) => ({ port: e.from, from: srcMac(e.frame), to: dstMac(e.frame) });

/** Sends random bytes from one machine to another over TCP and returns both ends' digests of them. */
async function transfer(from: TestMachine, to: TestMachine, address: string, port: number): Promise<[string, string]> {
	const file = `/tmp/sent-${port}`;
	const sent = await from.run(`head -c ${MEGABYTES * 1_000_000} /dev/urandom > ${file} && md5sum < ${file}`);
	const serving = from.run(`timeout 60 nc -l -p ${port} < ${file}; true`);
	await from.run(
		`for i in $(seq 50); do grep -qi ":${port.toString(16)} .* 0A " /proc/net/tcp /proc/net/tcp6 2>/dev/null && exit 0; sleep 0.1; done; exit 1`,
	);
	const got = await to.run(`timeout 60 nc ${address} ${port} < /dev/null > ${file}.got; md5sum < ${file}.got`);
	await serving;
	return [sent, got];
}

describe("each NIC", () => {
	test("is an ordinary Ethernet interface with its own MAC, up and without an address", async () => {
		for (const distro of ["alpine", "debian"] as const) {
			const l = await lab({ n: 1, ports: [1] }, { n: 2, ports: [2, 3, 4], distro });
			const [peer, multi] = l.machines;
			const links = await multi.run("ip -o link show");
			for (const [nic, mac] of ["52:54:00:88:00:0c", "52:54:00:88:01:0c", "52:54:00:88:02:0c"].entries()) {
				expect(links, distro).toMatch(new RegExp(`eth${nic}: <BROADCAST,MULTICAST,UP,LOWER_UP>.*link/ether ${mac} `));
			}
			expect(links, distro).not.toContain("eth3");
			expect(await multi.run("ip -4 -o addr show eth0"), distro).toContain("10.88.0.12/24");
			expect(await multi.run("ip -4 -o addr show eth1; ip -4 -o addr show eth2"), distro).toBe("");

			await multi.run("ip addr add 10.88.0.200/24 dev eth1 && ip addr del 10.88.0.12/24 dev eth0");
			l.frames.length = 0;
			expect(received(await peer.run("ping -c 2 -W 2 10.88.0.200")), distro).toMatch(/^2 /);
			const replies = l.frames.filter((e) => isEcho(e) && e.from !== 1);
			expect(replies.map((e) => [e.from, srcMac(e.frame)])).toEqual([
				[3, "52:54:00:88:01:0c"],
				[3, "52:54:00:88:01:0c"],
			]);
			await l.stop();
		}
	});

	test("shows its own traffic to tcpdump, and can be taken down and renumbered with ip", async () => {
		const l = await lab({ n: 1, ports: [1] }, { n: 2, ports: [2, 3], gateway: true });
		const [peer, multi] = l.machines;
		await multi.run("/usr/lib/kw/net wait; apk add --quiet tcpdump && ip addr add 10.2.0.1/24 dev eth1");
		await peer.run("ip addr add 10.2.0.9/24 dev eth0");
		const dumped = multi.run("timeout 20 tcpdump -lnnei eth1 -c 2 icmp 2>/tmp/said");
		await multi.run("for i in $(seq 50); do grep -q listening /tmp/said && exit 0; sleep 0.1; done; exit 1");
		expect(received(await peer.run("ping -c 1 -W 2 10.2.0.1"))).toMatch(/^1 /);
		const lines = (await dumped).trim().split("\n");
		expect(lines[0]).toMatch(/52:54:00:88:00:0b > 52:54:00:88:01:0c, .* 10\.2\.0\.9 > 10\.2\.0\.1: ICMP echo request/);
		expect(lines[1]).toMatch(/52:54:00:88:01:0c > 52:54:00:88:00:0b, .* 10\.2\.0\.1 > 10\.2\.0\.9: ICMP echo reply/);

		await multi.run("ip link set eth1 down");
		expect((await peer.exec("ping -c 2 -W 1 10.2.0.1")).exitCode).not.toBe(0);
		await multi.run("ip link set eth1 up && ip addr flush dev eth1 && ip addr add 10.2.0.5/24 dev eth1");
		expect(received(await peer.run("ping -c 2 -W 2 10.2.0.5"))).toMatch(/^2 /);
		expect(multi.lost).toEqual([]);
	});

	test("speaks ARP for its own address and no other NIC's", async () => {
		const l = await lab({ n: 1, ports: [1] }, { n: 2, ports: [2, 3] });
		const [peer, multi] = l.machines;
		await multi.run("ip addr add 10.2.0.1/24 dev eth1");
		await peer.run("ip addr add 10.2.0.9/24 dev eth0");
		await peer.run("ping -c 1 -W 2 10.88.0.12");
		await multi.run("ping -c 1 -W 2 -I 10.88.0.12 10.2.0.9");
		const claims = l.frames.flatMap((e) => (arpAddrs(e.frame)?.spa === ip4("10.88.0.12") ? [srcMac(e.frame)] : []));
		expect(new Set(claims)).toEqual(new Set(["52:54:00:88:00:0c"]));
	});

	test("that is left unplugged is there, up, and reaches nothing", async () => {
		const l = await lab({ n: 1, ports: [1] }, { n: 2, ports: [2, null] });
		const [peer, multi] = l.machines;
		await multi.run("ip addr add 10.2.0.1/24 dev eth1");
		await peer.run("ip addr add 10.2.0.9/24 dev eth0");
		expect((await peer.exec("ping -c 1 -W 1 10.2.0.1")).exitCode).not.toBe(0);
		expect((await multi.exec("ping -c 1 -W 1 -I eth1 10.2.0.9")).exitCode).not.toBe(0);
		expect(l.frames.filter((e) => srcMac(e.frame) === "52:54:00:88:01:0c")).toEqual([]);
		expect(received(await peer.run("ping -c 1 -W 2 10.88.0.12"))).toMatch(/^1 /);
	});
});

describe("a machine that forwards", () => {
	test("sends a packet that enters eth0 out of eth1, and the capture has both hops", async () => {
		const { lab: l, left } = await routed();
		await left.run("ping -c 1 -W 2 10.2.0.3");
		l.frames.length = 0;
		const ping = await left.run("ping -c 1 -W 2 10.2.0.3");
		expect(received(ping)).toMatch(/^1 /);
		expect(ping).toContain("ttl=63");
		const [NODE1, NODE2_ETH0, NODE2_ETH1, NODE3] = [
			"52:54:00:88:00:0b",
			"52:54:00:88:00:0c",
			"52:54:00:88:01:0c",
			"52:54:00:88:00:0d",
		];
		expect(l.frames.filter(isEcho).map(hop)).toEqual([
			{ port: 1, from: NODE1, to: NODE2_ETH0 },
			{ port: 3, from: NODE2_ETH1, to: NODE3 },
			{ port: 4, from: NODE3, to: NODE2_ETH1 },
			{ port: 2, from: NODE2_ETH0, to: NODE1 },
		]);
	});

	test("carries TCP whole in each direction and in both at once, in frames the wire takes", async () => {
		const { lab: l, left, router, right } = await routed();
		const whole = async (...transfers: Promise<[string, string]>[]) => {
			for (const [sent, got] of await Promise.all(transfers)) expect(got).toBe(sent);
		};
		await whole(transfer(left, right, "10.88.0.11", 9001));
		await whole(transfer(right, left, "10.2.0.3", 9002));
		await whole(transfer(left, right, "10.88.0.11", 9003), transfer(right, left, "10.2.0.3", 9004));
		// To and from the TAP device itself.
		await whole(transfer(router, right, "10.2.0.1", 9005), transfer(right, router, "10.2.0.3", 9006));

		const tcp = l.frames.filter((e) => ipAddrs(e.frame)?.proto === IP_TCP);
		const least = (6 * MEGABYTES * 1_000_000) / ETHERNET_MAX;
		expect(tcp.length).toBeGreaterThan(least);
		expect(Math.max(...l.frames.map((e) => e.frame.length))).toBe(ETHERNET_MAX);
	});
});

describe("a NIC that stops being read", () => {
	test("loses what does not fit and works again when it is read", async () => {
		const l = await lab({ n: 1, ports: [1] }, { n: 2, ports: [2, 3] });
		const [peer, multi] = l.machines;
		await multi.run("ip addr add 10.2.0.1/24 dev eth1");
		await peer.run("ip addr add 10.2.0.9/24 dev eth0");
		expect(received(await peer.run("ping -c 1 -W 2 10.2.0.1"))).toMatch(/^1 /);

		const helper = (await multi.run("pidof unlab-nic")).trim();
		await multi.run(`kill -STOP ${helper}`);
		const frame = new Uint8Array(ETHERNET_MAX).fill(0xff);
		for (let i = 0; i < 20_000; i++) multi.deliver(1, frame);
		expect((await peer.exec("ping -c 1 -W 1 10.2.0.1")).exitCode).not.toBe(0);
		expect(received(await peer.run("ping -c 1 -W 2 10.88.0.12"))).toMatch(/^1 /);

		await multi.run(`kill -CONT ${helper}`);
		await peer.run("for i in $(seq 20); do ping -c 1 -W 1 10.2.0.1 && exit 0; done; exit 1");
		expect(multi.lost).toEqual([]);
	});

	test("says so when the guest deletes it, and the other NIC carries on", async () => {
		const l = await lab({ n: 1, ports: [1] }, { n: 2, ports: [2, 3] });
		const [peer, multi] = l.machines;
		await multi.run("ip link del eth1");
		await expect.poll(() => multi.lost, { timeout: 10_000 }).toHaveLength(1);
		expect(multi.lost[0]).toMatch(/^eth1 stopped: /);
		expect(received(await peer.run("ping -c 1 -W 2 10.88.0.12"))).toMatch(/^1 /);
	});
});
