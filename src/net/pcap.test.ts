import { expect, test } from "vitest";
import { toPcap } from "./pcap.ts";

const hex = (s: string) => Uint8Array.from(s.trim().split(/\s+/), (b) => Number.parseInt(b, 16));

test("writes a little-endian libpcap file with Ethernet link type and microsecond stamps", () => {
	const file = toPcap(
		[
			{ t: 0, bytes: Uint8Array.of(1, 2, 3) },
			{ t: 1500.25, bytes: Uint8Array.of(0xaa, 0xbb) },
		],
		1_700_000_000_000,
	);
	expect(Array.from(file)).toEqual(
		Array.from(
			hex(`
				d4 c3 b2 a1  02 00 04 00  00 00 00 00  00 00 00 00  00 00 04 00  01 00 00 00
				00 f1 53 65  00 00 00 00  03 00 00 00  03 00 00 00  01 02 03
				01 f1 53 65  1a a2 07 00  02 00 00 00  02 00 00 00  aa bb
			`),
		),
	);
});

test("an empty capture is a header alone", () => {
	expect(toPcap([]).length).toBe(24);
});
