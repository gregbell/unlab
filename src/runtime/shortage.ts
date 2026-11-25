// What a machine says when the browser has no more to give it.

import type { Device } from "../model/index.ts";

export function memoryShortage(machine: string, mib: number): string {
	return `The browser could not give ${machine} ${mib} MiB of memory. Remove a machine or close other tabs, then boot it again.`;
}

/** A disk could not be opened or saved. `error` is what the browser threw, or unkernel's words for it. */
export function storageFailure(machine: string, device: Device, error: unknown): string {
	const said = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return said.includes("QuotaExceededError")
		? `Browser storage is full, so ${machine}'s disk ${device} could not be saved. Remove a machine or free some space, then boot it again.`
		: `Browser storage failed for ${machine}'s disk ${device}: ${said}`;
}
