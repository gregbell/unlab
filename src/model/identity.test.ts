import { describe, expect, test } from "vitest";
import { MAX_NODE } from "../net/index.ts";
import {
	identity,
	LAB_CIDR,
	nameForIp,
	nameForMac,
	parseMachineName,
	parseSessionId,
	sessionLabel,
} from "./identity.ts";

function macBytes(mac: string): Uint8Array {
	return Uint8Array.from(mac.split(":").map((part) => Number.parseInt(part, 16)));
}

function ipNumber(ip: string): number {
	return ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

describe("identity", () => {
	test("node n is 10.88.0.(10+n) with the lab MAC for host 10+n", () => {
		expect(identity(1)).toEqual({ n: 1, name: "node1", ip: "10.88.0.11", mac: "52:54:00:88:00:0b" });
		expect(identity(2)).toEqual({ n: 2, name: "node2", ip: "10.88.0.12", mac: "52:54:00:88:00:0c" });
		expect(identity(3)).toEqual({ n: 3, name: "node3", ip: "10.88.0.13", mac: "52:54:00:88:00:0d" });
	});

	test("the last node is the last host of the /24", () => {
		expect(LAB_CIDR).toBe("10.88.0.0/24");
		expect(MAX_NODE).toBe(244);
		expect(identity(MAX_NODE).ip).toBe("10.88.0.254");
		expect(identity(MAX_NODE).mac).toBe("52:54:00:88:00:fe");
	});

	test.each([0, -1, 1.5, MAX_NODE + 1, Number.NaN])("there is no node %s", (n) => {
		expect(() => identity(n)).toThrow(RangeError);
	});
});

describe("naming a frame's machine", () => {
	test("every node's MAC and address name it again", () => {
		for (let n = 1; n <= MAX_NODE; n++) {
			const id = identity(n);
			expect(nameForMac(macBytes(id.mac), 0)).toBe(id.name);
			expect(nameForIp(ipNumber(id.ip))).toBe(id.name);
		}
	});

	test("reads the MAC at an offset, as in an Ethernet source field", () => {
		const frame = new Uint8Array(14);
		frame.set(macBytes("ff:ff:ff:ff:ff:ff"), 0);
		frame.set(macBytes("52:54:00:88:00:0c"), 6);
		expect(nameForMac(frame, 6)).toBe("node2");
		expect(nameForMac(frame, 0)).toBeNull();
	});

	test.each([
		["another vendor", "52:54:00:12:00:0c"],
		["the host below node1", "52:54:00:88:00:0a"],
		["the broadcast host", "52:54:00:88:00:ff"],
		["a high byte no node has", "52:54:00:88:01:0c"],
	])("a MAC from %s names nothing", (_why, mac) => {
		expect(nameForMac(macBytes(mac), 0)).toBeNull();
	});

	test("a buffer too short to hold a MAC names nothing", () => {
		expect(nameForMac(macBytes("52:54:00:88:00:0c"), 1)).toBeNull();
		expect(nameForMac(new Uint8Array(0), 0)).toBeNull();
		expect(nameForMac(macBytes("52:54:00:88:00:0c"), -1)).toBeNull();
	});

	test.each([
		["the address below node1", "10.88.0.10"],
		["the network address", "10.88.0.0"],
		["the broadcast address", "10.88.0.255"],
		["another subnet", "10.88.1.12"],
		["the uplink", "10.0.2.15"],
	])("%s names nothing", (_why, ip) => {
		expect(nameForIp(ipNumber(ip))).toBeNull();
	});
});

describe("parseMachineName", () => {
	test.each(["node1", "node12", "node244"])("%s is a machine name", (text) => {
		expect(parseMachineName(text)).toBe(text);
	});

	test.each(["node0", "node01", "Node1", "node", "node1 ", " node1", "node1:console", "all", "node-1", "node1.5", ""])(
		"%j is not a machine name",
		(text) => {
			expect(parseMachineName(text)).toBeNull();
		},
	);

	test.each(["node245", "node999", "node99999999999999999999"])(
		"%s has no address, so it is not a machine name",
		(text) => {
			expect(parseMachineName(text)).toBeNull();
		},
	);
});

describe("parseSessionId", () => {
	test("a session is addressed as machine:tab", () => {
		expect(parseSessionId("node2:console")).toEqual({ session: "node2:console", machine: "node2", label: "console" });
		expect(parseSessionId("node2:sh1")).toEqual({ session: "node2:sh1", machine: "node2", label: "sh1" });
		expect(parseSessionId("node12:sh30")).toEqual({ session: "node12:sh30", machine: "node12", label: "sh30" });
	});

	test.each([
		"node2",
		"node2:",
		"node2:sh",
		"node2:sh0",
		"node2:sh01",
		"node2:shell",
		"node02:sh1",
		":sh1",
		"node2:sh1:x",
		"",
	])("%j is not a session", (text) => {
		expect(parseSessionId(text)).toBeNull();
	});

	test("the tab label is the part after the machine", () => {
		expect(sessionLabel("node2:console")).toBe("console");
		expect(sessionLabel("node10:sh3")).toBe("sh3");
	});
});
