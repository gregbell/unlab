// Where a machine's disks are kept: an IndexedDB database for each, named for
// the machine's number, because a name can be another machine's later.

import { MAX_EXTRA_DISKS } from "../model/index.ts";

const PREFIX = "kwdisk:";
/** unkernel adds the version to the root disk's store itself. */
const VERSION = "-v1";
const DATABASE = /^kwdisk:unlab-node(\d+)[-.]/;

export const rootStore = (n: number): string => `unlab-node${n}`;

/** Extra disk k, counting from 1. After `unlab-node<n>-` unkernel expects another version of the root disk. */
export const extraStore = (n: number, k: number): string => `unlab-node${n}.extra${k}${VERSION}`;

function drop(database: string): void {
	const request = indexedDB.deleteDatabase(database);
	request.onerror = () => console.error(`Could not delete the disk ${database}`, request.error);
}

/** Machine n's, however many it had. */
export function deleteMachineDisks(n: number): void {
	drop(`${PREFIX}${rootStore(n)}${VERSION}`);
	for (let k = 1; k <= MAX_EXTRA_DISKS; k++) drop(`${PREFIX}${extraStore(n, k)}`);
}

/**
 * Deletes the disks of removed machines whose deletion a crash or a reload cut
 * short. Only numbers the lab has given out count: a lab whose record was lost
 * has given out none, and its disks are not garbage. Waits only to see which
 * there are: a disk opened after that waits for its own deletion.
 */
export async function sweepDisks(removed: (n: number) => boolean): Promise<void> {
	try {
		for (const { name = "" } of await indexedDB.databases()) {
			const n = DATABASE.exec(name)?.[1];
			if (n !== undefined && removed(Number(n))) drop(name);
		}
	} catch (error) {
		console.error("Could not look for disks that no machine has", error);
	}
}
