// The addresses a scenario chooses, on real kernels: what each NIC holds, what
// crosses the switch in any subnet, and eth0 with and without the gateway.
import { afterEach, describe, expect, test } from "vitest";
import {
	arpAddrs,
	BROADCAST_MAC,
	dstMac,
	GATEWAY_SUBNETS,
	IP_ICMP,
	ip4,
	ip4str,
	ipAddrs,
	isDhcpRequest,
	subnetStr,
} from "../../src/net/index.ts";
import type { TapEvent } from "../../src/runtime/switch.ts";
import { bootLab, type MachineSetup, type TestLab } from "./lab.ts";

const DISTROS = ["alpine", "debian"] as const;

const running: TestLab[] = [];
async function lab(...setups: MachineSetup[]): Promise<TestLab> {
	const booted = await bootLab(setups);
	running.push(booted);
	return booted;
}
afterEach(async () => {
	await Promise.all(running.splice(0).map((l) => l.stop()));
});

/** Every IPv4 address in the guest but loopback's, as `eth0 10.1.0.1/24`. */
const HELD = `ip -4 -o addr show | awk '$2 != "lo" { print $2, $4 }'`;

describe("each NIC", () => {
	test.each(DISTROS)("of %s holds the address it was given and no other", async (distro) => {
		const l = await lab(
			{ n: 1, ports: [1], distro, gateway: true },
			{ n: 2, ports: [2, 3, 4], addr: ["10.1.0.2/24", null, "172.16.9.2/30"], distro, gateway: true },
			{ n: 3, ports: [5, 6], addr: [null, "10.3.0.3/16"], distro },
			{ n: 4, ports: [null], distro },
		);
		const held = await Promise.all(l.machines.map(async (m) => (await m.run(HELD)).trim().split("\n")));
		expect(held).toEqual([
			["eth0 10.0.2.15/24", "eth0 10.88.0.11/24"],
			["eth0 10.0.2.15/24", "eth0 10.1.0.2/24", "eth2 172.16.9.2/30"],
			["eth1 10.3.0.3/16"],
			["eth0 10.88.0.14/24"],
		]);
		for (const [machine, nics] of [
			[l.machines[1], 3],
			[l.machines[2], 2],
		] as const) {
			const links = await machine.run("ip -o link show");
			for (let nic = 0; nic < nics; nic++) expect(links).toMatch(new RegExp(`eth${nic}: <[^>]*\\bUP,LOWER_UP>`));
		}
	});

	test.each(DISTROS)(
		"of %s is reached by the name of a machine that has an address, and sudo is quiet on one that has none",
		async (distro) => {
			const l = await lab(
				{ n: 1, ports: [1], addr: ["10.1.0.1/24"], distro },
				{ n: 2, ports: [2], addr: ["10.1.0.2/24"], distro },
				{ n: 3, ports: [3], addr: [null], distro },
			);
			const [one, , none] = l.machines;
			expect(await one.run("ping -c 1 -W 2 node2")).toContain("10.1.0.2");
			expect(await none.run("su user -c 'sudo -n true' 2>&1")).toBe("");
		},
	);
});

const isEcho = (e: TapEvent): boolean => ipAddrs(e.frame)?.proto === IP_ICMP;

describe("any subnet", () => {
	test("crosses the switch: the ARP exchange, then the echoes", async () => {
		const l = await lab(
			{ n: 1, ports: [1], addr: ["172.20.5.1/16"], gateway: true },
			{ n: 2, ports: [2], addr: ["172.20.200.9/16"] },
		);
		const [a, b] = [ip4("172.20.5.1"), ip4("172.20.200.9")];
		l.frames.length = 0;
		expect(await l.machines[0].run("ping -c 2 -W 2 172.20.200.9")).toMatch(/2 (packets )?received/);
		const arp = l.frames.flatMap((e) => arpAddrs(e.frame) ?? []);
		expect(arp.slice(0, 2)).toEqual([
			{ op: 1, spa: a, tpa: b },
			{ op: 2, spa: b, tpa: a },
		]);
		const echoes = l.frames.filter(isEcho).map((e) => {
			const ip = ipAddrs(e.frame);
			return [e.from, ip4str(ip?.src ?? 0), ip4str(ip?.dst ?? 0)];
		});
		expect(echoes).toEqual([
			[1, "172.20.5.1", "172.20.200.9"],
			[2, "172.20.200.9", "172.20.5.1"],
			[1, "172.20.5.1", "172.20.200.9"],
			[2, "172.20.200.9", "172.20.5.1"],
		]);
	});

	test("carries a broadcast to every other plugged machine", async () => {
		const l = await lab(
			{ n: 1, ports: [1], addr: ["10.50.0.1/24"] },
			{ n: 2, ports: [2], addr: ["10.50.0.2/24"], gateway: true },
			{ n: 3, ports: [3], addr: ["10.60.0.3/24"] },
			{ n: 4, ports: [null, 4], addr: ["10.50.0.4/24", null] },
			{ n: 5, ports: [null], addr: ["10.50.0.5/24"] },
		);
		const [sender, ...others] = l.machines;
		// A neighbour the kernel learns from a broadcast ARP reply it did not ask for.
		for (const m of others) await m.run("for nic in /proc/sys/net/ipv4/conf/*/arp_accept; do echo 1 > $nic; done");
		l.frames.length = 0;
		await sender.run("arping -c 1 -A -I eth0 10.50.0.1; true");
		const sent = l.frames.filter((e) => e.from === 1 && arpAddrs(e.frame)?.op === 2);
		expect(sent.map((e) => [dstMac(e.frame), e.to])).toEqual([[BROADCAST_MAC, 0b1110]]);
		const learned = async (i: number) => (await others[i].run("ip neigh show 10.50.0.1")).trim();
		expect(await learned(0)).toMatch(/dev eth0 lladdr 52:54:00:88:00:0b/);
		expect(await learned(1)).toMatch(/dev eth0 lladdr 52:54:00:88:00:0b/);
		expect(await learned(2)).toMatch(/dev eth1 lladdr 52:54:00:88:00:0b/);
		expect(await learned(3)).toBe("");
	});
});

/** A DHCP server for one lease, in the only language the image has sockets in. */
const DHCP_SERVER = String.raw`
use strict; use warnings; use Socket;
socket(my $s, PF_INET, SOCK_DGRAM, 17) or die;
setsockopt($s, SOL_SOCKET, SO_REUSEADDR, 1); setsockopt($s, SOL_SOCKET, SO_BROADCAST, 1);
setsockopt($s, SOL_SOCKET, 25, "eth0\0") or die;
bind($s, sockaddr_in(67, INADDR_ANY)) or die;
open(my $up, ">", "/tmp/dhcpd.up"); close $up;
while (defined recv($s, my $m, 1500, 0)) {
  my ($type) = substr($m, 240) =~ /^\x35\x01(.)/s or next;
  my $reply = ord($type) == 1 ? 2 : ord($type) == 3 ? 5 : next;
  my $lease = inet_aton("10.9.0.50"); my $me = inet_aton("10.9.0.1");
  my $out = "\2" . substr($m, 1, 15) . $lease . $me . substr($m, 24, 216)
    . "\x35\1" . chr($reply) . "\x36\4" . $me . "\x33\4" . pack("N", 3600) . "\1\4" . inet_aton("255.255.255.0") . "\xff";
  send($s, $out, 0, sockaddr_in(68, INADDR_BROADCAST)) or warn $!;
}
`;

describe("a machine plugged in without the package gateway", () => {
	test("leases an address from a DHCP server on another machine", async () => {
		const l = await lab(
			{ n: 1, ports: [1], addr: ["10.9.0.1/24"], distro: "debian" },
			{ n: 2, ports: [2], addr: [null] },
			{ n: 3, ports: [3], gateway: true },
		);
		const [server, client, other] = l.machines;
		await server.run(`cat > /tmp/dhcpd.pl <<'PERL'\n${DHCP_SERVER}\nPERL`);
		await server.run(
			"setsid perl /tmp/dhcpd.pl > /tmp/dhcpd.log 2>&1 < /dev/null & for i in $(seq 50); do [ -e /tmp/dhcpd.up ] && exit 0; sleep 0.1; done; cat /tmp/dhcpd.log; exit 1",
		);
		expect(await client.run(HELD)).toBe("");
		l.frames.length = 0;
		await client.run("udhcpc -i eth0 -n -q -t 5 2>&1");
		expect(await client.run(HELD)).toBe("eth0 10.9.0.50/24\n");
		expect(await client.run("ping -c 1 -W 2 10.9.0.1")).toContain("1 packets received");
		const requests = l.frames.filter((e) => isDhcpRequest(e.frame));
		expect(new Set(requests.map((e) => e.from))).toEqual(new Set([2]));
		expect(requests.length).toBeGreaterThanOrEqual(2);

		// With the gateway, eth0's DHCP is the gateway's and does not reach the switch.
		l.frames.length = 0;
		await other.run("udhcpc -i eth0 -n -q -t 5 2>&1");
		expect(await other.run(HELD)).toContain("eth0 10.0.2.15/24");
		expect(l.frames.filter((e) => isDhcpRequest(e.frame))).toEqual([]);
	});

	test.each(DISTROS)("boots %s as fast as one with it, and its boot puts nothing on the switch", async (distro) => {
		const l = await lab(
			{ n: 1, ports: [1], distro, gateway: true },
			{ n: 2, ports: [2], addr: [null], distro },
			{ n: 3, ports: [null], distro },
		);
		const [withGateway, without, unplugged] = l.machines;
		// The image's DHCP client gives up after three seconds when no one answers.
		for (const m of [without, unplugged]) expect(m.bootMs).toBeLessThan(withGateway.bootMs + 2000);
		expect(l.frames.filter((e) => ipAddrs(e.frame))).toEqual([]);
		for (const m of [without, unplugged]) {
			expect(await m.run("pidof udhcpc || true")).toBe("");
			expect(await m.run("ip -4 route show default")).toBe("");
		}
		expect(await without.run(HELD)).toBe("");
	});
});

describe("a machine with the package gateway and a chosen address", () => {
	const PACKAGES = {
		alpine: "apk add --quiet tree && tree --version",
		// debian: "apt-get -qq update && apt-get -qq install -y tree > /dev/null && tree --version",
	};

	// Debian is out until it has a package mirror: mirror.unkernel.dev answers the lab with 403, "Origin not allowed".
	// test.each(DISTROS)("installs packages on %s, and is reached on its address", async (distro) => {
	test.each(["alpine"] as const)("installs packages on %s, and is reached on its address", async (distro) => {
		const l = await lab(
			{ n: 1, ports: [1], addr: ["10.20.0.1/24"], distro, gateway: "packages" },
			{ n: 2, ports: [2], addr: ["10.20.0.2/24"] },
		);
		const [machine, peer] = l.machines;
		expect(await machine.run(`${PACKAGES[distro]} 2>&1`)).toMatch(/tree v\d/);
		expect(await peer.run("ping -c 1 -W 2 10.20.0.1")).toContain("1 packets received");
	});

	test("reaches the gateway only on the subnets the lab refuses", async () => {
		const l = await lab({ n: 1, ports: [1], distro: "debian", gateway: "packages" });
		const [machine] = l.machines;
		const lease = /inet (10\.0\.2\.\d+\/24)/.exec(await machine.run("ip -4 addr show eth0"))?.[1];
		const names = await machine.run("getent ahostsv4 dl-cdn.alpinelinux.org; getent ahostsv4 deb.debian.org");
		const answered = [...names.matchAll(/^(\d+\.\d+\.\d+)\.\d+ /gm)].map((m) => `${m[1]}.0/24`);
		expect(lease).toBe("10.0.2.15/24");
		expect(new Set(["10.0.2.0/24", ...answered])).toEqual(new Set(GATEWAY_SUBNETS.map(subnetStr)));
	});
});
