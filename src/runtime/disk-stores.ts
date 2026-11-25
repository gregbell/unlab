// Where a machine's disks are kept: an IndexedDB database for each, named for
// the machine's number, because a name can be another machine's later.

import { MAX_EXTRA_DISKS } from "../model/index.ts";

const PREFIX = "kwdisk:";
/** unkernel adds the version to the root disk's store itself. */
const VERSION = "-v1";

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
