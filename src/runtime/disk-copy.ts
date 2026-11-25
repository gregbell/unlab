// Copying the disks of a machine that no guest has open: to a checkpoint, and
// from one to a new set of them. And what a copy of disks in use shares with it.

import { IdbStore } from "unkernel";
import { type Block, CheckpointStore, PACK, result } from "./checkpoint-store.ts";
import { databaseOf, deleteDisks, storesOf } from "./disk-stores.ts";

export type Progress = (percent: number) => void;

/** Which disks, by the machine's number, its number of extra ones, and the sets'. */
export interface SetCopy {
	readonly n: number;
	readonly extras: number;
	readonly from: number;
	readonly to: number;
}

/** A disk's records, read beside the IdbStore that writes them. */
export class BlockReader {
	private constructor(
		private readonly db: IDBDatabase,
		private readonly store: string,
	) {
		db.onversionchange = () => db.close();
	}

	/** Rejects when nothing is kept under that name. */
	static async open(store: string): Promise<BlockReader> {
		const request = indexedDB.open(databaseOf(store));
		// It was not there, and is not to be.
		request.onupgradeneeded = () => request.transaction?.abort();
		return new BlockReader(await result(request), store);
	}

	#read(store: "blocks" | "meta"): IDBObjectStore {
		return this.db.transaction(store, "readonly").objectStore(store);
	}

	/** What the disk is apart from its name, such as its size. */
	async what(): Promise<string> {
		const identity = await result<unknown>(this.#read("meta").get("identity"));
		if (typeof identity === "string" && identity.startsWith(this.store)) return identity.slice(this.store.length);
		throw new Error(`The disk ${this.store} is not there.`);
	}

	count(): Promise<number> {
		return result(this.#read("blocks").count());
	}

	/** The next blocks that have a record, in order. */
	async after(block: number): Promise<Block[]> {
		const blocks = this.#read("blocks");
		const range = IDBKeyRange.lowerBound(block, true);
		const [keys, values] = await Promise.all([
			result(blocks.getAllKeys(range, PACK)),
			result<Uint8Array[]>(blocks.getAll(range, PACK)),
		]);
		return values.map((data, i): Block => [Number(keys[i]), data]);
	}

	/** Those of the blocks that have a record. */
	async get(blocks: readonly number[]): Promise<Block[]> {
		const store = this.#read("blocks");
		const values = await Promise.all(blocks.map((block) => result<Uint8Array | undefined>(store.get(block))));
		return values.flatMap((data, i): Block[] => (data ? [[blocks[i], data]] : []));
	}

	close(): void {
		this.db.close();
	}
}

/** Reports whole percent of `total`, each once. */
export function counter(total: number, progress: Progress): (more: number) => void {
	let sum = 0;
	let said = 0;
	return (more) => {
		sum += more;
		const percent = Math.min(100, Math.floor((sum / total) * 100));
		if (percent === said) return;
		said = percent;
		progress(percent);
	};
}

/** The disks of a set and the empty checkpoint they are copied to. */
export interface Opened {
	readonly readers: readonly BlockReader[];
	readonly store: CheckpointStore;
	/** How many records there are to copy. */
	readonly total: number;
	close(): void;
}

export async function openCopy({ n, extras, from, to }: SetCopy): Promise<Opened> {
	const readers: BlockReader[] = [];
	const close = () => {
		for (const reader of readers) reader.close();
	};
	try {
		for (const store of storesOf(n, from, extras)) readers.push(await BlockReader.open(store));
		const what = await Promise.all(readers.map((reader) => reader.what()));
		const counts = await Promise.all(readers.map((reader) => reader.count()));
		const store = await CheckpointStore.create(n, to, what);
		return {
			readers,
			store,
			total: counts.reduce((sum, count) => sum + count, 0),
			close() {
				close();
				store.close();
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}

export const bytesIn = (blocks: readonly Block[]): number => blocks.reduce((sum, [, data]) => sum + data.byteLength, 0);

async function save(copy: SetCopy, progress: Progress): Promise<number> {
	const opened = await openCopy(copy);
	try {
		const wrote = counter(opened.total, progress);
		let bytes = 0;
		for (const [disk, reader] of opened.readers.entries()) {
			for (let next = await reader.after(-1); next.length > 0; ) {
				await opened.store.append(disk, next);
				bytes += bytesIn(next);
				wrote(next.length);
				next = await reader.after(next[next.length - 1][0]);
			}
		}
		return bytes;
	} finally {
		opened.close();
	}
}

async function restore({ n, extras, from, to }: SetCopy, progress: Progress): Promise<number> {
	const store = await CheckpointStore.open(n, from);
	try {
		const what = await store.disks();
		if (what.length !== extras + 1) throw new Error("It is not whole.");
		const wrote = counter(await store.packs(), progress);
		let bytes = 0;
		for (const [disk, name] of storesOf(n, to, extras).entries()) {
			const target = new IdbStore(name);
			try {
				await target.seed([], name + what[disk]);
				for await (const blocks of store.read(disk)) {
					await target.save(blocks);
					bytes += bytesIn(blocks);
					wrote(1);
				}
			} finally {
				await target.close();
			}
		}
		return bytes;
	} finally {
		store.close();
	}
}

const COPIES = { save, restore };

/** Saves a set as a checkpoint, or makes a set from one. Resolves with the bytes of its blocks, and leaves nothing when it fails. */
export async function copyDisks(why: keyof typeof COPIES, copy: SetCopy, progress: Progress): Promise<number> {
	try {
		return await COPIES[why](copy, progress);
	} catch (error) {
		await deleteDisks(copy.n, [copy.to], copy.extras);
		throw error;
	}
}
