import { describe, expect, test } from "vitest";
import { addressStr, isAddressFault, parseAddress, subnetStr, subnetsOverlap } from "./address.ts";
import { ip4str } from "./frames.ts";

function read(text: string) {
	const address = parseAddress(text);
	if (isAddressFault(address)) throw new Error(`${text}: ${address.kind}`);
	return address;
}

function fault(text: string): string | null {
	const address = parseAddress(text);
	return isAddressFault(address) ? address.kind : null;
}

describe("parseAddress", () => {
	test.each([
		["10.1.0.1/24", "10.1.0.0/24"],
		["10.1.0.254/24", "10.1.0.0/24"],
		["172.16.9.2/30", "172.16.9.0/30"],
		["192.168.1.129/25", "192.168.1.128/25"],
		["10.1.2.0/16", "10.1.0.0/16"],
		["10.0.0.1/8", "10.0.0.0/8"],
		["223.255.255.254/24", "223.255.255.0/24"],
		["10.1.0.0/31", "10.1.0.0/31"],
		["10.1.0.1/31", "10.1.0.0/31"],
		["10.1.0.7/32", "10.1.0.7/32"],
		["126.0.0.1/1", "0.0.0.0/1"],
	])("%s is in %s, and is written as it was", (text, subnet) => {
		expect(addressStr(read(text))).toBe(text);
		expect(subnetStr(read(text))).toBe(subnet);
	});

	test.each([
		[
			"unreadable",
			["", "none", "10.1.0/24", "10.1.0.1.5/24", "10.1.0.256/24", "10.1.0.1/24/24", " 10.1.0.1/24", "10..0.1/24"],
		],
		["prefix", ["10.1.0.1", "10.1.0.1/", "10.1.0.1/0", "10.1.0.1/33", "10.1.0.1/024", "10.1.0.1/24.0", "10.1.0.1/x"]],
		["reserved", ["0.0.0.0/8", "0.1.2.3/24", "127.0.0.1/8", "224.0.0.1/24", "255.255.255.255/32"]],
		["network", ["10.1.0.0/24", "10.1.0.128/25", "10.0.0.0/8"]],
		["broadcast", ["10.1.0.255/24", "10.1.0.127/25", "10.255.255.255/8"]],
	])("a fault: %s", (kind, texts) => {
		for (const text of texts) expect([text, fault(text)]).toEqual([text, kind]);
	});

	test("a subnet's own addresses are refused with the ones that can be used", () => {
		for (const text of ["10.1.0.4/30", "10.1.0.7/30"]) {
			const read = parseAddress(text);
			if (!("first" in read)) throw new Error(`${text} is a fault with a range`);
			expect([ip4str(read.first), ip4str(read.last)]).toEqual(["10.1.0.5", "10.1.0.6"]);
		}
	});
});

test.each([
	["10.1.0.1/24", "10.1.0.200/24", true],
	["10.1.0.1/24", "10.1.1.1/24", false],
	["10.1.0.1/16", "10.1.200.1/24", true],
	["10.1.0.1/25", "10.1.0.129/25", false],
	["10.1.0.1/32", "10.1.0.1/24", true],
	["10.1.0.2/32", "10.1.0.1/32", false],
])("%s and %s overlap: %s", (a, b, overlap) => {
	expect(subnetsOverlap(read(a), read(b))).toBe(overlap);
	expect(subnetsOverlap(read(b), read(a))).toBe(overlap);
});
