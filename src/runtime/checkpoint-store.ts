// A checkpoint of a machine's disks, in one IndexedDB database. A disk that a
// guest has open is kept as a record for each block of 4 KiB, which Chromium
// puts in a log that gives its space back only when it is next rewritten. Here
// blocks are packed into records big enough to be files of their own: they are
// written four times as fast, and what they took is free as soon as they go.

import { checkpointDatabase } from "./disk-stores.ts";

export const BLOCK = 4096;
/** The most blocks in a record, and what is read and written at a time: 1 MiB. */
export const PACK = 256;

/** A block's number and what it holds, as an IdbStore has it. */
export type Block = [number, Uint8Array];

interface Pack {
	readonly blocks: Uint32Array;
	/** Theirs, one after the other. */
	readonly data: Uint8Array;
}

export const result = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const committed = (transaction: IDBTransaction): Promise<void> =>
	new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error ?? new DOMException("It was cut short.", "AbortError"));
	});

export class CheckpointStore {
	private constructor(private readonly db: IDBDatabase) {
		db.onversionchange = () => db.close();
	}

	/** `what` each disk is, the root's first. */
	static async create(n: number, set: number, what: readonly string[]): Promise<CheckpointStore> {
		const request = indexedDB.open(checkpointDatabase(n, set), 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore("packs", { autoIncrement: true }).createIndex("disk", "disk");
			const disks = request.result.createObjectStore("disks");
			for (const [disk, identity] of what.entries()) disks.put(identity, disk);
		};
		return new CheckpointStore(await result(request));
	}

	/** Rejects when it is not there. */
	static async open(n: number, set: number): Promise<CheckpointStore> {
		const request = indexedDB.open(checkpointDatabase(n, set));
		request.onupgradeneeded = () => request.transaction?.abort();
		return new CheckpointStore(await result(request));
	}

	#read(store: "packs" | "disks"): IDBObjectStore {
		return this.db.transaction(store, "readonly").objectStore(store);
	}

	disks(): Promise<string[]> {
		return result<string[]>(this.#read("disks").getAll());
	}

	/** Resolves once it is saved. No more than a PACK of them. */
	async append(disk: number, blocks: readonly Block[]): Promise<void> {
		const pack: Pack = {
			blocks: Uint32Array.from(blocks, ([block]) => block),
			data: new Uint8Array(blocks.length * BLOCK),
		};
		for (const [i, [, data]] of blocks.entries()) pack.data.set(data, i * BLOCK);
		const transaction = this.db.transaction("packs", "readwrite", { durability: "strict" });
		const done = committed(transaction);
		transaction.objectStore("packs").add({ disk, ...pack });
		return done;
	}

	packs(): Promise<number> {
		return result(this.#read("packs").count());
	}

	/** Every block of the disk, a pack at a time. */
	async *read(disk: number): AsyncGenerator<Block[]> {
		const keys = await result(this.#read("packs").index("disk").getAllKeys(disk));
		for (const key of keys) {
			const { blocks, data } = await result<Pack>(this.#read("packs").get(key));
			yield Array.from(blocks, (block, i): Block => [block, data.slice(i * BLOCK, (i + 1) * BLOCK)]);
		}
	}

	close(): void {
		this.db.close();
	}
}
