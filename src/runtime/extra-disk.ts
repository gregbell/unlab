import { CowDisk, IdbStore, ZeroBase } from "unkernel";
import { extraStore } from "./disk-stores.ts";

export interface ExtraDisk {
	/** The machine's number. */
	readonly n: number;
	readonly set: number;
	/** Which of its extra disks, counting from 1. */
	readonly k: number;
	readonly gib: number;
	/** What was written last could not be saved. */
	readonly onError: (error: unknown) => void;
}

/** A disk that reads as zeros where no one has written. Rejects when the browser cannot keep it. */
export function openExtraDisk({ n, set, k, gib, onError }: ExtraDisk): Promise<CowDisk> {
	const name = extraStore(n, set, k);
	const base = new ZeroBase(gib * 2 ** 30);
	base.identity = `${name} size=${base.size}`;
	return new CowDisk(base, { store: new IdbStore(name), onError }).open({ onMismatch: "refuse" });
}

const SAVE_MS = 1000;

/**
 * Save what was written even when the guest asks for no flush, as a drive
 * empties its cache. A file system without a journal never asks until it is
 * unmounted. The root disk's asks every second.
 */
export function keepSaved(disks: readonly CowDisk[]): void {
	setInterval(() => {
		// A failed save has been reported to `onError`.
		for (const disk of disks) Promise.resolve(disk.flush()).catch(() => {});
	}, SAVE_MS);
}
