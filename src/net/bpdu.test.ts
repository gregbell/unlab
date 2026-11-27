import { describe, expect, test } from "vitest";
import { type Bpdu, bridgeAddress, bridgeIdOf, bridgePriority, decodeBpdu, encodeBpdu, isForBridges } from "./bpdu.ts";
import { decode } from "./decode.ts";
import { switchAddress } from "./identity.ts";

const bytes = (hex: string): Uint8Array =>
	Uint8Array.from(hex.match(/[0-9a-f]{2}/g) ?? [], (b) => Number.parseInt(b, 16));

/** Written out from 802.1D-2004 figure 9-3: a designated port's proposal, with a topology change, one bridge from the root. */
const RAPID =
	"0180c2000000 020000000002 0027 424203" +
	"0000 02 02 0f" +
	"8000020000000001 00004e20 8000020000000002 8003" +
	"0100 1400 0200 0f00 00" +
	"00000000000000";

const proposal: Bpdu = {
	rapid: true,
	root: bridgeIdOf(0x8000, 0x0200_0000_0001),
	cost: 20_000,
	bridge: bridgeIdOf(0x8000, 0x0200_0000_0002),
	port: 0x8003,
	role: "designated",
	proposal: true,
	agreement: false,
	learning: false,
	forwarding: false,
	topologyChange: true,
	age: 1,
	maxAge: 20,
	hello: 2,
	forwardDelay: 15,
};

describe("a spanning tree message", () => {
	test("is a 60-byte frame for the bridges' address, in an LLC header, with each field where the standard has it", () => {
		const frame = encodeBpdu(proposal, 0x0200_0000_0002);
		expect(frame).toEqual(bytes(RAPID));
		expect(frame.length).toBe(60);
		expect(isForBridges(frame)).toBe(true);
	});

	test("is read back as it was written, and each flag has its own bit", () => {
		expect(decodeBpdu(bytes(RAPID))).toEqual(proposal);
		const agreed: Bpdu = {
			...proposal,
			role: "root",
			proposal: false,
			agreement: true,
			learning: true,
			forwarding: true,
			topologyChange: false,
		};
		const frame = encodeBpdu(agreed, 0x0200_0000_0002);
		expect(frame[21]).toBe(0x78);
		expect(decodeBpdu(frame)).toEqual(agreed);
		expect(decodeBpdu(encodeBpdu({ ...agreed, role: "alternate", agreement: false }, 1))?.role).toBe("alternate");
	});

	test("of classic spanning tree is read as a designated port's, with no handshake in it", () => {
		const config =
			"0180c2000000 525400123456 0026 424203" +
			"0000 00 00 01" +
			"8000525400123456 00000000 8000525400123456 8001" +
			"0000 1400 0200 0f00" +
			"0000000000000000";
		expect(decodeBpdu(bytes(config))).toEqual({
			rapid: false,
			root: "8000525400123456",
			cost: 0,
			bridge: "8000525400123456",
			port: 0x8001,
			role: "designated",
			proposal: false,
			agreement: false,
			learning: false,
			forwarding: false,
			topologyChange: true,
			age: 0,
			maxAge: 20,
			hello: 2,
			forwardDelay: 15,
		});
	});

	test("is not read from a frame that is cut short, has another header, or is a topology change notice", () => {
		const frame = bytes(RAPID);
		expect(decodeBpdu(frame.subarray(0, 40))).toBeNull();
		expect(decodeBpdu(Uint8Array.from(frame, (byte, i) => (i === 14 ? 0xaa : byte)))).toBeNull();
		expect(decodeBpdu(Uint8Array.from(frame, (byte, i) => (i === 20 ? 0x80 : byte)))).toBeNull();
		const elsewhere = Uint8Array.from(frame, (byte, i) => (i === 5 ? 0x0e : byte));
		expect(isForBridges(elsewhere)).toBe(false);
		expect(decodeBpdu(elsewhere)).toBeNull();
	});
});

describe("a spanning tree message in the capture", () => {
	test("says its root, the cost to it, the bridge and port that sent it, and what that port is and does", () => {
		expect(decode(bytes(RAPID))).toEqual({
			proto: "RSTP",
			src: "02:00:00:00:00:02",
			dst: "01:80:c2:00:00:00",
			info: "root 32768.02:00:00:00:00:01 · cost 20000 · from 32768.02:00:00:00:00:02 port 3 · designated, discarding, proposal, topology change",
		});
		const agreed = encodeBpdu(
			{
				...proposal,
				role: "root",
				proposal: false,
				agreement: true,
				learning: true,
				forwarding: true,
				topologyChange: false,
			},
			0x0200_0000_0002,
		);
		expect(decode(agreed).info).toBe(
			"root 32768.02:00:00:00:00:01 · cost 20000 · from 32768.02:00:00:00:00:02 port 3 · root, forwarding, agreement",
		);
	});

	test("of classic spanning tree says so, and a frame for the bridges that holds no message is told by its length", () => {
		const config =
			"0180c2000000 525400123456 0026 424203" +
			"0000 00 00 00" +
			"1000525400123456 00000000 1000525400123456 8001" +
			"0000 1400 0200 0f00" +
			"0000000000000000";
		expect(decode(bytes(config))).toMatchObject({
			proto: "STP",
			info: "root 4096.52:54:00:12:34:56 · cost 0 · from 4096.52:54:00:12:34:56 port 1 · designated",
		});
		const cut = bytes(RAPID).subarray(0, 40);
		expect(decode(cut)).toMatchObject({ proto: "0x0027", info: "40 bytes" });
	});
});

describe("a bridge's ID", () => {
	test("is its priority and then its address, and the lower of two is the lower as text", () => {
		const id = bridgeIdOf(0x8000, 0x0200_a1b2_c3d4);
		expect(id).toBe("80000200a1b2c3d4");
		expect(bridgePriority(id)).toBe(32768);
		expect(bridgeAddress(id)).toBe("02:00:a1:b2:c3:d4");
		expect(bridgeIdOf(0x1000, 0x0200_ffff_ffff) < id).toBe(true);
		expect(bridgeIdOf(0x8000, 0x0200_a1b2_c3d3) < id).toBe(true);
	});

	test("has an address that follows from the switch's name alone, and differs for each of a lab's names", () => {
		expect(switchAddress("switch0")).toBe(switchAddress("switch0"));
		const names = ["switch0", "switch1", "switch2", "lan", "wan", "dmz", "core", "edge"];
		const addresses = names.map(switchAddress);
		expect(new Set(addresses).size).toBe(names.length);
		for (const address of addresses) {
			expect(Math.floor(address / 2 ** 32)).toBe(0x0200);
		}
	});
});
