import { expect, test } from "vitest";
import { parseCheckpointName, parseMachineName } from "../model/index.ts";
import { copyFailure, memoryShortage, storageFailure } from "./shortage.ts";

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

const machine = parseMachineName("web");
const checkpoint = parseCheckpointName("before");
if (!machine || !checkpoint) throw new Error("no names");
const copy = { machine, checkpoint };
const full = new DOMException("no room", "QuotaExceededError");

test("a checkpoint that could not be saved or gone back to says so, naming storage, and that the disks are unharmed", () => {
	const room = "Delete a checkpoint, remove a machine or free some space, then try again.";
	expect(copyFailure(copy, "save", full)).toBe(
		`Browser storage is full, so checkpoint before of web could not be saved. ${room}`,
	);
	expect(copyFailure(copy, "restore", full)).toBe(
		`Browser storage is full, so web could not go back to checkpoint before. Its disks are as they were. ${room}`,
	);
	expect(copyFailure(copy, "save", new Error("It stopped."))).toBe(
		"Checkpoint before of web could not be saved: It stopped.",
	);
	expect(copyFailure(copy, "restore", new DOMException("gone", "AbortError"))).toBe(
		"web could not go back to checkpoint before: AbortError: gone. Its disks are as they were.",
	);
});
