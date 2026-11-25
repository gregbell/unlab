// What a machine says when the browser has no more to give it.

import type { Device, DiskCopy } from "../model/index.ts";
import type { CopyJob } from "./protocol.ts";

export function memoryShortage(machine: string, mib: number): string {
	return `The browser could not give ${machine} ${mib} MiB of memory, so remove a machine or close other tabs, then boot it again.`;
}

function saidBy(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
}

const isFull = (said: string): boolean => said.includes("QuotaExceededError");

/** A disk could not be opened or saved. `error` is what the browser threw, or unkernel's words for it. */
export function storageFailure(machine: string, device: Device, error: unknown): string {
	const said = saidBy(error);
	return isFull(said)
		? `Browser storage is full, so ${machine}'s disk ${device} could not be saved: remove a machine or free some space, then boot it again.`
		: `Browser storage failed for ${machine}'s disk ${device}: ${said}`;
}

const MAKE_ROOM = "delete a checkpoint, remove a machine or free some space, then try again.";

/** A checkpoint could not be saved, or a machine could not go back to one. Neither has changed the machine's disks. */
export function copyFailure(
	{ machine, checkpoint }: Pick<DiskCopy, "machine" | "checkpoint">,
	why: CopyJob["why"],
	error: unknown,
): string {
	const said = saidBy(error).replace(/\.?$/, ".");
	const full = isFull(said);
	if (why === "save") {
		return full
			? `Browser storage is full, so checkpoint ${checkpoint} of ${machine} could not be saved: ${MAKE_ROOM}`
			: `Checkpoint ${checkpoint} of ${machine} could not be saved: ${said}`;
	}
	const untouched = `could not go back to checkpoint ${checkpoint}, and its disks are as they were`;
	return full
		? `Browser storage is full, so ${machine} ${untouched}: ${MAKE_ROOM}`
		: `${machine} ${untouched}: ${said}`;
}
