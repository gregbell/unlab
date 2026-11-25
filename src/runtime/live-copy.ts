// A checkpoint of a running guest's disks as they are at one moment. The disks
// and the kernel that writes them are in this thread, so nothing is written
// while the moment is taken: every disk then holds exactly the writes it had
// been given. The guest runs on while the blocks are copied. A save waits until
// what it is about to replace has been.

import type { CowDisk, OverlayStore } from "unkernel";
import { type Block, PACK } from "./checkpoint-store.ts";
import { type BlockReader, bytesIn, counter, type Opened, openCopy, type Progress, type SetCopy } from "./disk-copy.ts";
import { deleteDisks } from "./disk-stores.ts";

const isFull = (error: unknown): boolean => error instanceof DOMException && error.name === "QuotaExceededError";

/** Told of every block that a disk's store is about to replace or delete. */
interface Watcher {
	/** Resolves once they may be replaced. Never rejects. */
	replacing(blocks: readonly number[]): Promise<void>;
	/** The browser is out of storage, and what has been copied takes some of it. */
	giveUp(error: unknown): Promise<void>;
}

/** A disk's store, which a copy can watch. */
export class WatchedStore implements OverlayStore {
	watcher: Watcher | null = null;
	constructor(private readonly store: OverlayStore) {}

	get name(): string | undefined {
		return this.store.name;
	}

	open(...args: Parameters<OverlayStore["open"]>): ReturnType<OverlayStore["open"]> {
		return this.store.open(...args);
	}

	getBlocks(blocks: number[]): Promise<Map<number, Uint8Array>> {
		return this.store.getBlocks(blocks);
	}

	async save(puts: Block[], dels: number[], meta?: { gen: number }): Promise<void> {
		await this.watcher?.replacing([...puts.map(([block]) => block), ...dels]);
		try {
			await this.store.save(puts, dels, meta);
		} catch (error) {
			if (!this.watcher || !isFull(error)) throw error;
			await this.watcher.giveUp(error);
			await this.store.save(puts, dels, meta);
		}
	}

	clear(): Promise<void> {
		return this.store.clear();
	}

	async close(): Promise<void> {
		await this.store.close?.();
	}
}

/** From here on the disk's saves can be watched. */
export function watchable(disk: CowDisk): WatchedStore {
	if (!disk.store) throw new Error("a disk that is not kept cannot be copied");
	const store = new WatchedStore(disk.store);
	disk.store = store;
	return store;
}

export interface LiveDisk {
	readonly disk: CowDisk;
	readonly store: WatchedStore;
}

/** One disk as it is when this is made. */
class Frozen implements Watcher {
	/** Written by the guest and not yet in the store. */
	readonly #written: Block[] = [];
	/** Blocks that are copied, or on their way, out of turn. */
	readonly #early = new Set<number>();
	/** Writes of those that a save waits for. */
	readonly #waited = new Set<Promise<void>>();
	/** Every block up to here is copied, or on its way. */
	#upTo = -1;

	constructor(
		{ mem }: CowDisk,
		private readonly reader: BlockReader,
		private readonly write: (blocks: readonly Block[]) => Promise<void>,
		readonly giveUp: Watcher["giveUp"],
	) {
		// What a save that is under way holds is here too, so no block that it replaces is read from the store.
		for (const [block, data] of mem) {
			this.#early.add(block);
			// One that reads as zeros has no record on a disk whose base does.
			if (data.length > 0) this.#written.push([block, data.slice()]);
		}
	}

	async replacing(blocks: readonly number[]): Promise<void> {
		try {
			for (let i = 0; i < blocks.length; i += PACK) {
				const now = blocks.slice(i, i + PACK).filter((block) => block > this.#upTo && !this.#early.has(block));
				if (now.length > 0) await this.#copyEarly(now);
			}
		} catch (error) {
			await this.giveUp(error);
		}
	}

	async #copyEarly(blocks: readonly number[]): Promise<void> {
		for (const block of blocks) this.#early.add(block);
		const copied = this.reader.get(blocks).then(this.write);
		this.#waited.add(copied);
		await copied;
		this.#waited.delete(copied);
	}

	/** Resolves once the disk is copied, as it was when this was made. */
	async finish(): Promise<void> {
		while (this.#written.length > 0) await this.write(this.#written.splice(0, PACK));
		for (let next = await this.reader.after(-1); next.length > 0; next = await this.reader.after(this.#upTo)) {
			// One that a save replaced while it was read is marked as early, so it is not taken for what it was.
			const blocks = next.filter(([block]) => !this.#early.has(block));
			this.#upTo = next[next.length - 1][0];
			await this.write(blocks);
		}
		this.#upTo = Number.POSITIVE_INFINITY;
		await Promise.all(this.#waited);
	}
}

export interface LiveCopy {
	/** The bytes of the blocks it keeps. Rejects with what went wrong, and then nothing of it is left. */
	readonly done: Promise<number>;
	giveUp(error: unknown): Promise<void>;
}

/**
 * Copies the disks as they are once `settle` has resolved. Give it the guest's
 * own sync, so that its files are on them.
 */
export function copyLive(
	copy: SetCopy,
	disks: readonly LiveDisk[],
	settle: () => Promise<void>,
	progress: Progress,
): LiveCopy {
	let opened: Opened | null = null;
	let failed: { readonly error: unknown } | null = null;

	const check = () => {
		if (failed) throw failed.error;
	};
	const close = () => {
		for (const { store } of disks) store.watcher = null;
		opened?.close();
	};
	const giveUp = (error: unknown): Promise<void> => {
		failed ??= { error };
		// A write that is under way is let finish before the connection it is on closes, and the deletion waits for that.
		close();
		return deleteDisks(copy.n, [copy.to], copy.extras);
	};

	const open = async (): Promise<Opened> => {
		const made = await openCopy(copy);
		opened = made;
		check();
		return made;
	};
	const run = async (): Promise<number> => {
		try {
			const { readers, store, total } = await open();
			const wrote = counter(total, progress);
			let bytes = 0;
			const writeTo = (disk: number) => async (blocks: readonly Block[]) => {
				check();
				if (blocks.length === 0) return;
				await store.append(disk, blocks);
				bytes += bytesIn(blocks);
				wrote(blocks.length);
			};
			await settle();
			// So that little is left to hold in memory.
			await Promise.all(disks.map(({ disk }) => disk.flush()));
			check();
			const frozen = disks.map(({ disk }, i) => new Frozen(disk, readers[i], writeTo(i), giveUp));
			for (const [i, { store }] of disks.entries()) store.watcher = frozen[i];
			for (const disk of frozen) await disk.finish();
			check();
			close();
			return bytes;
		} catch (error) {
			await giveUp(error);
			throw failed?.error ?? error;
		}
	};
	return { done: run(), giveUp };
}
