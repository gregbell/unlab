import { describe, expect, test } from "vitest";
import { addressStr, defaultAddress, LAB_SUBNET, MAX_NODE, NICS, nicOfMac, subnetStr } from "../net/index.ts";
import { identity, nicMac, parseMachineName, parseSessionId, sessionLabel } from "./identity.ts";

function macBytes(mac: string): Uint8Array {
	return Uint8Array.from(mac.split(":").map((part) => Number.parseInt(part, 16)));
}

describe("identity", () => {
	test("node n has the lab MAC for host 10+n", () => {
		expect(identity(1)).toEqual({ n: 1, name: "node1", mac: "52:54:00:88:00:0b" });
		expect(identity(2)).toEqual({ n: 2, name: "node2", mac: "52:54:00:88:00:0c" });
		expect(identity(3)).toEqual({ n: 3, name: "node3", mac: "52:54:00:88:00:0d" });
	});

	test("the last node is the last host of the /24", () => {
		expect(subnetStr(LAB_SUBNET)).toBe("10.88.0.0/24");
		expect(MAX_NODE).toBe(244);
		expect(addressStr(defaultAddress(MAX_NODE))).toBe("10.88.0.254/24");
		expect(identity(MAX_NODE).mac).toBe("52:54:00:88:00:fe");
	});

	test.each([0, -1, 1.5, MAX_NODE + 1, Number.NaN])("there is no node %s", (n) => {
		expect(() => identity(n)).toThrow(RangeError);
	});
});

/** Which machine's MAC is at `off`. */
const machineAt = (f: Uint8Array, off: number): number | null => nicOfMac(f, off)?.n ?? null;

describe("a frame's machine", () => {
	test("every machine's MAC gives its number again", () => {
		for (let n = 1; n <= MAX_NODE; n++) {
			expect(machineAt(macBytes(identity(n).mac), 0)).toBe(n);
		}
	});

	test("reads the MAC at an offset, as in an Ethernet source field", () => {
		const frame = new Uint8Array(14);
		frame.set(macBytes("ff:ff:ff:ff:ff:ff"), 0);
		frame.set(macBytes("52:54:00:88:00:0c"), 6);
		expect(machineAt(frame, 6)).toBe(2);
		expect(machineAt(frame, 0)).toBeNull();
	});

	test.each([
		["another vendor", "52:54:00:12:00:0c"],
		["the host below node1", "52:54:00:88:00:0a"],
		["the broadcast host", "52:54:00:88:00:ff"],
		["a NIC no machine has", "52:54:00:88:04:0c"],
	])("a MAC from %s is no machine's", (_why, mac) => {
		expect(machineAt(macBytes(mac), 0)).toBeNull();
	});

	test("a buffer too short to hold a MAC is no machine's", () => {
		expect(machineAt(macBytes("52:54:00:88:00:0c"), 1)).toBeNull();
		expect(machineAt(new Uint8Array(0), 0)).toBeNull();
		expect(machineAt(macBytes("52:54:00:88:00:0c"), -1)).toBeNull();
	});
});

describe("parseMachineName", () => {
	test.each(["node1", "node12", "node244", "web", "web-1", "node-1", "a", "w".repeat(63)])(
		"%s is a machine name",
		(text) => {
			expect(parseMachineName(text)).toBe(text);
		},
	);

	test.each([
		"node0",
		"node01",
		"Node1",
		"node1 ",
		" node1",
		"node1:console",
		"node1.5",
		"1web",
		"-web",
		"web-",
		"web_1",
		"",
		"w".repeat(64),
	])("%j is not a machine name", (text) => {
		expect(parseMachineName(text)).toBeNull();
	});

	test.each(["node245", "node999", "node99999999999999999999"])(
		"%s has no MAC, so it is not a machine name",
		(text) => {
			expect(parseMachineName(text)).toBeNull();
		},
	);
});

describe("parseSessionId", () => {
	test("a session is addressed as machine:tab", () => {
		for (const [machine, label, shell] of [
			["node2", "console", null],
			["node2", "sh1", 1],
			["node12", "sh30", 30],
			["web-1", "console", null],
			["web-1", "sh2", 2],
		] as const) {
			const session = `${machine}:${label}`;
			expect(parseSessionId(session)).toEqual({ session, machine, label, shell });
		}
	});

	test.each([
		"node2",
		"node2:",
		"node2:sh",
		"node2:sh0",
		"node2:sh01",
		"node2:shell",
		"node02:sh1",
		"web_1:sh1",
		"Web:console",
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

describe("NICs", () => {
	test("NIC k of node n has MAC 52:54:00:88:0k:(10+n), and the MAC gives both again", () => {
		expect(NICS.map((nic) => nicMac(2, nic))).toEqual([
			"52:54:00:88:00:0c",
			"52:54:00:88:01:0c",
			"52:54:00:88:02:0c",
			"52:54:00:88:03:0c",
		]);
		for (let n = 1; n <= MAX_NODE; n++) {
			for (const nic of NICS) expect(nicOfMac(macBytes(nicMac(n, nic)), 0)).toEqual({ n, nic });
		}
	});

	test("every NIC's MAC is its machine's", () => {
		expect(machineAt(macBytes("52:54:00:88:03:0c"), 0)).toBe(2);
	});
});
