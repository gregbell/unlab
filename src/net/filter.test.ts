import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
	arpRequest,
	BROADCAST,
	eth,
	ip,
	ipv4Packet,
	ipv6,
	mac,
	ping,
	routedPing,
	tcpSegment,
	udpSegment,
} from "../../test/support/frames.ts";
import { type CaptureFilter, compileFilter, MATCH_ALL } from "./filter.ts";

function compile(source: string): CaptureFilter {
	const r = compileFilter(source);
	if (!r.ok) throw new Error(`expected ${source} to compile: ${r.error.message}`);
	return r.filter;
}

const EXTERNAL_MAC = Uint8Array.of(0x02, 0x00, 0x00, 0x00, 0x00, 0x01);
const GATEWAY = 0x0a000202;
const udp = (from: number, to: number, sport: number, dport: number) =>
	eth(mac(to), mac(from), 0x0800, ipv4Packet(ip(from), ip(to), 17, udpSegment(sport, dport, 4)));
const tcp = (from: number, to: number, sport: number, dport: number) =>
	eth(mac(to), mac(from), 0x0800, ipv4Packet(ip(from), ip(to), 6, tcpSegment(sport, dport)));
const bit = (p: number) => 1 << (p - 1);

describe("filter terms", () => {
	test("an empty filter matches every frame and link row", () => {
		for (const source of ["", "   "]) {
			const f = compile(source);
			expect(f.matchesFrame(ping(1, 2), 1, bit(2))).toBe(true);
			expect(f.matchesLink(3, "node3", 0)).toBe(true);
		}
		expect(MATCH_ALL.matchesFrame(arpRequest(1, 2), 1, 0)).toBe(true);
	});

	test("protocols", () => {
		const frames = {
			arp: arpRequest(1, 2),
			icmp: ping(1, 2),
			tcp: tcp(1, 2, 40000, 80),
			udp: udp(1, 2, 40000, 9),
			dhcp: udp(1, 2, 68, 67),
			dns: udp(1, 2, 40000, 53),
			ipv6: ipv6(mac(1), mac(2)),
		};
		const expected: Record<string, readonly (keyof typeof frames)[]> = {
			arp: ["arp"],
			icmp: ["icmp"],
			tcp: ["tcp"],
			udp: ["udp", "dhcp", "dns"],
			dhcp: ["dhcp"],
			dns: ["dns"],
			ip: ["icmp", "tcp", "udp", "dhcp", "dns"],
			ipv4: ["icmp", "tcp", "udp", "dhcp", "dns"],
			ipv6: ["ipv6"],
		};
		for (const [term, matching] of Object.entries(expected)) {
			const f = compile(term);
			for (const [name, frame] of Object.entries(frames)) {
				expect(f.matchesFrame(frame, 1, bit(2)), `${term} on ${name}`).toBe(matching.includes(name as never));
			}
		}
	});

	test("a machine name matches either end, by MAC or by address", () => {
		const f = compile("node2");
		expect(f.matchesFrame(ping(1, 2), 1, bit(2))).toBe(true);
		expect(f.matchesFrame(ping(2, 1), 2, bit(1))).toBe(true);
		expect(f.matchesFrame(ping(1, 3), 1, bit(3))).toBe(false);
		// A broadcast ARP request names node2 only in its target protocol address.
		expect(f.matchesFrame(arpRequest(1, 2), 1, bit(2) | bit(3))).toBe(true);
		// An outsider's MAC carrying node2's address still names node2.
		const spoofed = eth(BROADCAST, EXTERNAL_MAC, 0x0800, ipv4Packet(ip(2), GATEWAY, 1, []));
		expect(f.matchesFrame(spoofed, 4, 0)).toBe(true);
	});

	test("an IPv4 address matches IP source, IP destination and ARP addresses", () => {
		const f = compile("10.88.0.13");
		expect(f.matchesFrame(ping(3, 1), 3, bit(1))).toBe(true);
		expect(f.matchesFrame(ping(1, 3), 1, bit(3))).toBe(true);
		expect(f.matchesFrame(arpRequest(1, 3), 1, 0)).toBe(true);
		expect(f.matchesFrame(ping(1, 2), 1, bit(2))).toBe(false);
	});

	test("a MAC address matches either Ethernet end", () => {
		const f = compile("52:54:00:88:00:0c");
		expect(f.matchesFrame(ping(2, 1), 2, bit(1))).toBe(true);
		expect(f.matchesFrame(ping(1, 2), 1, bit(2))).toBe(true);
		expect(f.matchesFrame(ping(1, 3), 1, bit(3))).toBe(false);
	});

	test("port:N matches the ingress port or any egress port", () => {
		const f = compile("port:3");
		expect(f.matchesFrame(ping(3, 1), 3, bit(1))).toBe(true);
		expect(f.matchesFrame(arpRequest(1, 2), 1, bit(2) | bit(3))).toBe(true);
		expect(f.matchesFrame(arpRequest(1, 2), 1, bit(2))).toBe(false);
	});

	test("a machine name matches any of its NICs, and a NIC only its own", () => {
		const intoRouter = routedPing(mac(1), mac(2), 1, 3);
		const outOfRouter = routedPing(mac(2, 1), mac(3), 1, 3);
		const matching = (source: string) => [intoRouter, outOfRouter].map((f) => compile(source).matchesFrame(f, 1, 0));
		expect(matching("node2")).toEqual([true, true]);
		expect(matching("node2:eth0")).toEqual([true, false]);
		expect(matching("node2:eth1")).toEqual([false, true]);
		expect(matching("node2:eth2")).toEqual([false, false]);
		expect(matching("NODE2:ETH1")).toEqual([false, true]);
		expect(matching("node3:eth0")).toEqual([false, true]);
	});

	test("a NIC is its MAC, so an address some other NIC carries does not name it", () => {
		const fromEth1WithEth0sAddress = routedPing(mac(2, 1), mac(3), 2, 3);
		expect(compile("node2:eth0").matchesFrame(fromEth1WithEth0sAddress, 2, 0)).toBe(false);
		expect(compile("node2:eth1").matchesFrame(fromEth1WithEth0sAddress, 2, 0)).toBe(true);
	});

	test.each(["node2:", "node2:eth4", "node2:eth01", "node2:sh1", "node0:eth1", ":eth1"])("%s is no NIC", (term) => {
		expect(compileFilter(term)).toMatchObject({ ok: false, error: { message: `Capture cannot read ${term}.` } });
	});

	test("matching ignores case", () => {
		expect(compile("ARP NODE2").matchesFrame(arpRequest(1, 2), 1, 0)).toBe(true);
		expect(compile("52:54:00:88:00:0C").matchesFrame(ping(1, 2), 1, 0)).toBe(true);
		expect(compile("arp OR icmp").matchesFrame(ping(1, 2), 1, 0)).toBe(true);
	});
});

describe("filter combinators", () => {
	test("a space means and", () => {
		const f = compile("icmp node3");
		expect(f.matchesFrame(ping(1, 3), 1, bit(3))).toBe(true);
		expect(f.matchesFrame(ping(1, 2), 1, bit(2))).toBe(false);
		expect(f.matchesFrame(arpRequest(1, 3), 1, 0)).toBe(false);
	});

	test("the word or means or, and binds looser than and", () => {
		const f = compile("arp node2 or icmp node3");
		expect(f.matchesFrame(arpRequest(1, 2), 1, 0)).toBe(true);
		expect(f.matchesFrame(ping(1, 3), 1, 0)).toBe(true);
		expect(f.matchesFrame(arpRequest(1, 3), 1, 0)).toBe(false);
		expect(f.matchesFrame(ping(1, 2), 1, 0)).toBe(false);
	});
});

describe("link rows", () => {
	test("protocol terms do not hide link rows", () => {
		expect(compile("arp").matchesLink(3, "node3", 0)).toBe(true);
	});

	test("port, machine, address and MAC terms keep only link rows about them", () => {
		expect(compile("port:3").matchesLink(3, "node3", 0)).toBe(true);
		expect(compile("port:2").matchesLink(3, "node3", 0)).toBe(false);
		expect(compile("node3").matchesLink(3, "node3", 0)).toBe(true);
		expect(compile("node2").matchesLink(3, "node3", 0)).toBe(false);
		expect(compile("10.88.0.13").matchesLink(3, "node3", 0)).toBe(true);
		expect(compile("10.0.2.2").matchesLink(3, "node3", 0)).toBe(false);
		expect(compile("52:54:00:88:00:0d").matchesLink(3, "node3", 0)).toBe(true);
		expect(compile("arp port:2 or icmp port:3").matchesLink(3, "node3", 0)).toBe(true);
	});

	test("a NIC's link rows are its own, and its machine's name takes them all", () => {
		const links = (source: string) => ([0, 1] as const).map((nic) => compile(source).matchesLink(3, "node3", nic));
		expect(links("node3")).toEqual([true, true]);
		expect(links("node3:eth1")).toEqual([false, true]);
		expect(links("52:54:00:88:01:0d")).toEqual([false, true]);
		expect(links("10.88.0.13")).toEqual([true, false]);
	});
});

describe("filter errors", () => {
	const error = (source: string) => {
		const r = compileFilter(source);
		if (r.ok) throw new Error(`expected ${source} to fail`);
		return r.error;
	};

	test("an unreadable term names its token and where it sits", () => {
		expect(error("arp nod3")).toMatchObject({ token: "nod3", start: 4, end: 8, message: "Capture cannot read nod3." });
		expect(error("  ICMP   Bogus ")).toMatchObject({ token: "Bogus", start: 9, end: 14 });
	});

	test("the first unreadable term is the one reported", () => {
		expect(error("x arp y")).toMatchObject({ token: "x", start: 0, end: 1 });
	});

	test.each([
		["port:0"],
		["port:9"],
		["port:"],
		["node0"],
		["node03"],
		["node245"],
		["10.88.0.256"],
		["10.88.0"],
		["52:54:00:88:00"],
		["52:54:00:88:00:zz"],
	])("%s is not readable", (term) => {
		expect(error(term)).toMatchObject({ token: term, start: 0, end: term.length });
	});

	test("or needs a term on each side", () => {
		expect(error("or arp")).toMatchObject({ token: "or", start: 0, end: 2 });
		expect(error("arp or")).toMatchObject({ token: "or", start: 4, end: 6 });
		expect(error("arp or OR icmp")).toMatchObject({ token: "OR", start: 7, end: 9 });
	});
});

type Kind = "arp-request" | "arp-reply" | "icmp" | "tcp" | "udp" | "dhcp" | "dns" | "ipv6";
interface Described {
	readonly kind: Kind;
	readonly srcMac: Uint8Array;
	readonly dstMac: Uint8Array;
	readonly srcIp: number;
	readonly dstIp: number;
	readonly from: number;
	readonly to: number;
}

function build(d: Described): Uint8Array {
	switch (d.kind) {
		case "arp-request":
		case "arp-reply":
			return eth(d.dstMac, d.srcMac, 0x0806, [
				0,
				1,
				8,
				0,
				6,
				4,
				0,
				d.kind === "arp-request" ? 1 : 2,
				...d.srcMac,
				...u32(d.srcIp),
				...d.dstMac,
				...u32(d.dstIp),
			]);
		case "icmp":
			return eth(d.dstMac, d.srcMac, 0x0800, ipv4Packet(d.srcIp, d.dstIp, 1, [8, 0, 0, 0, 0, 1, 0, 1]));
		case "tcp":
			return eth(d.dstMac, d.srcMac, 0x0800, ipv4Packet(d.srcIp, d.dstIp, 6, tcpSegment(40000, 80)));
		case "udp":
			return eth(d.dstMac, d.srcMac, 0x0800, ipv4Packet(d.srcIp, d.dstIp, 17, udpSegment(40000, 9)));
		case "dhcp":
			return eth(d.dstMac, d.srcMac, 0x0800, ipv4Packet(d.srcIp, d.dstIp, 17, udpSegment(68, 67)));
		case "dns":
			return eth(d.dstMac, d.srcMac, 0x0800, ipv4Packet(d.srcIp, d.dstIp, 17, udpSegment(40000, 53)));
		case "ipv6":
			return ipv6(d.srcMac, d.dstMac);
	}
}
function u32(v: number): number[] {
	return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

const PROTO_KINDS: Record<string, readonly Kind[]> = {
	arp: ["arp-request", "arp-reply"],
	icmp: ["icmp"],
	tcp: ["tcp"],
	udp: ["udp", "dhcp", "dns"],
	dhcp: ["dhcp"],
	dns: ["dns"],
	ip: ["icmp", "tcp", "udp", "dhcp", "dns"],
	ipv4: ["icmp", "tcp", "udp", "dhcp", "dns"],
	ipv6: ["ipv6"],
};
const sameMac = (a: Uint8Array, b: Uint8Array) => a.every((x, i) => x === b[i]);
const hexMac = (m: Uint8Array) => Array.from(m, (b) => b.toString(16).padStart(2, "0")).join(":");
const dotted = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** What the filter means, read off the description instead of the bytes. */
function oracle(term: string, d: Described): boolean {
	const t = term.toLowerCase();
	const hasIp = d.kind !== "ipv6";
	const ipEnd = (x: number) => hasIp && (d.srcIp === x || d.dstIp === x);
	const macEnd = (m: Uint8Array) => sameMac(d.srcMac, m) || sameMac(d.dstMac, m);
	const kinds = PROTO_KINDS[t];
	if (kinds) return kinds.includes(d.kind);
	if (t.startsWith("port:")) {
		const p = Number(t.slice(5));
		return d.from === p || (d.to & (1 << (p - 1))) !== 0;
	}
	if (t.startsWith("node")) {
		const n = Number(t.slice(4));
		return macEnd(mac(n)) || ipEnd(ip(n));
	}
	if (t.includes(":")) return macEnd(Uint8Array.from(t.split(":"), (h) => Number.parseInt(h, 16)));
	return ipEnd(t.split(".").reduce((a, b) => a * 256 + Number(b), 0));
}

const macs = [mac(1), mac(2), mac(3), mac(4), EXTERNAL_MAC];
const ips = [ip(1), ip(2), ip(3), ip(4), GATEWAY, 0];
const termPool = [
	...Object.keys(PROTO_KINDS),
	"node1",
	"node2",
	"node3",
	"node4",
	...ips.slice(0, 5).map(dotted),
	...macs.map(hexMac),
	"port:1",
	"port:2",
	"port:3",
	"port:4",
];

const described = fc.record({
	kind: fc.constantFrom<Kind>("arp-request", "arp-reply", "icmp", "tcp", "udp", "dhcp", "dns", "ipv6"),
	srcMac: fc.constantFrom(...macs),
	dstMac: fc.constantFrom(...macs, BROADCAST),
	srcIp: fc.constantFrom(...ips),
	dstIp: fc.constantFrom(...ips),
	from: fc.integer({ min: 1, max: 4 }),
	to: fc.integer({ min: 0, max: 15 }),
});
const term = fc.tuple(fc.constantFrom(...termPool), fc.boolean()).map(([t, up]) => (up ? t.toUpperCase() : t));
const filterGroups = fc.array(fc.array(term, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 });

test("the compiled predicate agrees with the filter's meaning", () => {
	fc.assert(
		fc.property(filterGroups, fc.array(described, { minLength: 1, maxLength: 20 }), (groups, frames) => {
			const f = compile(groups.map((g) => g.join(" ")).join(" or "));
			for (const d of frames) {
				const want = groups.some((g) => g.every((t) => oracle(t, d)));
				if (f.matchesFrame(build(d), d.from, d.to) !== want) return false;
			}
			return true;
		}),
		{ numRuns: 500 },
	);
});
