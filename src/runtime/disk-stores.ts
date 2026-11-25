// Where a machine's disks are kept: an IndexedDB database for each, named for
// the machine's number, because a name can be another machine's later, and for
// the set of disks it is in. Set 0 is the one a machine is spawned with.

const PREFIX = "kwdisk:";
/** unkernel adds the version to the root disk's store itself. */
const VERSION = "-v1";
const DATABASE = /^kwdisk:unlab-node(\d+)(?:\.set(\d+))?[-.]/;

/** After `<root>-` unkernel expects another version of that root disk, so no other name may start with it. */
export const rootStore = (n: number, set: number): string => `unlab-node${n}${set === 0 ? "" : `.set${set}`}`;

/** Extra disk k, counting from 1. */
export const extraStore = (n: number, set: number, k: number): string => `${rootStore(n, set)}.extra${k}${VERSION}`;

/** What every disk of the set is kept in, the root's first. */
export function storesOf(n: number, set: number, extras: number): string[] {
	const extra = Array.from({ length: extras }, (_, i) => extraStore(n, set, i + 1));
	return [`${rootStore(n, set)}${VERSION}`, ...extra];
}

/** A checkpoint has all of its machine's disks in one. Its set's number is no live set's. */
export const checkpointDatabase = (n: number, set: number): string => `${PREFIX}unlab-node${n}.set${set}.checkpoint`;

/** An IdbStore's name is its database's without the prefix. */
export const databaseOf = (store: string): string => `${PREFIX}${store}`;

function drop(database: string): Promise<void> {
	const request = indexedDB.deleteDatabase(database);
	return new Promise((resolve) => {
		request.onsuccess = () => resolve();
		request.onerror = () => {
			console.error(`Could not delete the disk ${database}`, request.error);
			resolve();
		};
	});
}

/** Live sets and checkpoints alike. Waits until none of them is there. */
export async function deleteDisks(n: number, sets: readonly number[], extras: number): Promise<void> {
	const databases = (set: number) => [...storesOf(n, set, extras).map(databaseOf), checkpointDatabase(n, set)];
	await Promise.all(sets.flatMap((set) => databases(set).map(drop)));
}

/**
 * Deletes the disks that a crash or a reload left no use for: those of machines
 * that were removed, and sets that were not finished or are no longer live.
 * Only numbers the lab has given out count: a lab whose record was lost has
 * given out none, and its disks are not garbage. Waits only to see which there
 * are: a disk opened after that waits for its own deletion.
 */
export async function sweepDisks(unused: (n: number, set: number) => boolean): Promise<void> {
	try {
		for (const { name = "" } of await indexedDB.databases()) {
			const [, n, set = "0"] = DATABASE.exec(name) ?? [];
			if (n !== undefined && unused(Number(n), Number(set))) void drop(name);
		}
	} catch (error) {
		console.error("Could not look for disks that nothing has", error);
	}
}
