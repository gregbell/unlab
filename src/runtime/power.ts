// How a guest's kernel stops, and what is saved before its worker goes. The
// browser's worker and the Node tests share this, so what one proves holds for
// the other.

import type { CowDisk, ExitResult, KernelInstance } from "unkernel";
import type { Next } from "../model/index.ts";
import { execAsRoot } from "./guest.ts";

/** How long a guest that did not shut down has to write back its file systems. */
export const SYNC_MS = 3000;

/** `poweroff` ends the kernel with 0, `halt` with 1 and `reboot` with 2. */
const HALTS: readonly Next[] = ["off", "off", "reboot"];

/** What the guest shut down for, or null when it did not shut down. */
export function nextOf({ kind, code }: Pick<ExitResult, "kind" | "code">): Next | null {
	return kind === "halt" ? (HALTS[code] ?? null) : null;
}

const COMMANDS: Readonly<Record<Next, string>> = { off: "poweroff", reboot: "reboot" };

/**
 * Has the guest shut down as its own command does it: programs end, file
 * systems are written back and unmounted. False when it has not within `ms`,
 * and then it has been asked to write back what it can.
 */
export async function shutDown(
	vm: Pick<KernelInstance, "exec" | "exited" | "sync">,
	next: Next,
	ms: number,
): Promise<boolean> {
	// The session is lost as the guest goes down. A command that fails leaves it running, which shows below.
	execAsRoot(vm, COMMANDS[next]).catch(() => {});
	const late = new Promise<null>((resolve) => setTimeout(resolve, ms, null));
	const exit = await Promise.race([vm.exited, late]);
	if (exit === null) await vm.sync({ timeout: SYNC_MS });
	return exit?.kind === "halt";
}

/** How long a guest has to write back its file systems when it is asked to as it runs. */
const SYNC_RUNNING_MS = 30_000;

/** Has the guest write everything its programs have written to its disks. Rejects when it has not. */
export async function syncGuest(vm: Pick<KernelInstance, "exec">): Promise<void> {
	const { promise: late, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => reject(new Error(`Its guest did not write its files to disk in ${SYNC_RUNNING_MS / 1000} s.`)),
		SYNC_RUNNING_MS,
	);
	try {
		const { exitCode, stderr } = await Promise.race([execAsRoot(vm, "sync"), late]);
		if (exitCode !== 0) throw new Error(`Its guest could not write its files to disk: ${String(stderr).trim()}`);
	} finally {
		clearTimeout(timer);
	}
}

/** Saves every write the disks have taken. False when one could not be saved, which the disk has reported. */
export async function saveDisks(disks: readonly Pick<CowDisk, "busy" | "flush">[]): Promise<boolean> {
	const saved = await Promise.allSettled(
		disks.map(async (disk) => {
			// A write of part of a block waits for the rest of it to be read.
			await Promise.allSettled(disk.busy.values());
			await disk.flush();
		}),
	);
	return saved.every(({ status }) => status === "fulfilled");
}
