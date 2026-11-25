import { expect, test } from "vitest";
import { memoryShortage, storageFailure } from "./shortage.ts";

test("a machine the browser has no memory for says so, with the size it asked for", () => {
	expect(memoryShortage("web", 512)).toBe(
		"The browser could not give web 512 MiB of memory. Remove a machine or close other tabs, then boot it again.",
	);
});

const FULL =
	"Browser storage is full, so web's disk /dev/wdc could not be saved. Remove a machine or free some space, then boot it again.";

test.each<[string, unknown, string]>([
	["the browser is out of quota", new DOMException("no room", "QuotaExceededError"), FULL],
	[
		"unkernel fell back to memory for want of quota",
		"IndexedDB failed (QuotaExceededError: no room); this tab's /data is a fresh disk in memory (changes are not saved)",
		FULL,
	],
	[
		"anything else",
		new DOMException("gone", "InvalidStateError"),
		"Browser storage failed for web's disk /dev/wdc: InvalidStateError: gone",
	],
])("a disk that could not be kept says so, naming storage: %s", (_why, error, sentence) => {
	expect(storageFailure("web", "/dev/wdc", error)).toBe(sentence);
});
