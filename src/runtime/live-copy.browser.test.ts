// Checkpoints of disks in use, on the browser's own storage: what is written
// while one is made, and what it gives back.
import { CowDisk, IdbStore, ZeroBase } from "unkernel";
import { afterEach, expect, test, vi } from "vitest";
import { BLOCK } from "./checkpoint-store.ts";
import { copyDisks, type SetCopy } from "./disk-copy.ts";
import { checkpointDatabase, deleteDisks, extraStore, storesOf } from "./disk-stores.ts";
import { openExtraDisk } from "./extra-disk.ts";
import { copyLive, type LiveDisk, watchable } from "./live-copy.ts";

const N = 77;
const BLOCKS = 6000;
const SIZE = 2 ** 30;
/** The stamp of a block that reads as zeros. */
const ZERO = 0;

const databases = async () =>
	(await indexedDB.databases()).map(({ name = "" }) => name).filter((name) => name.includes(`node${N}`));

/** As unkernel opens a machine's root disk, and as the app opens an extra one. */
async function openSet(set: number): Promise<CowDisk[]> {
	const [root] = storesOf(N, set, 1);
	const base = new ZeroBase(SIZE);
	base.identity = `${root} size=${SIZE} bs=${BLOCK}`;
	return [
		await new CowDisk(base, { store: new IdbStore(root), log: () => {} }).open({ onMismatch: "refuse" }),
		await openExtraDisk({ n: N, set, k: 1, gib: 1, onError: () => {} }),
	];
}

const stamped = (stamp: number): Uint8Array => {
	const data = new Uint8Array(BLOCK);
	new Uint32Array(data.buffer).fill(stamp);
	return data;
};

async function stampAt(disk: CowDisk, block: number): Promise<number> {
	const data = new Uint8Array(BLOCK);
	await disk.read(block * BLOCK, [data]);
	const words = new Uint32Array(data.buffer);
	expect(
		words.every((word) => word === words[0]),
		"a block is one write's",
	).toBe(true);
	return words[0];
}

interface Write {
	readonly disk: number;
	readonly block: number;
	readonly stamp: number;
}

/** Both disks with something in most blocks, and what a guest would write to them from then on. */
async function guest() {
	const disks = await openSet(0);
	const log: Write[] = [];
	let stamp = 0;
	// unkernel can lose the zeroing of a block that is written again while it is first saved, so those zeroed are written once.
	const write = (disk: number, block: number, zero = false) => {
		stamp++;
		if (zero) disks[disk].discard(block * BLOCK, BLOCK);
		else void disks[disk].write(block * BLOCK, [stamped(stamp)]);
		log.push({ disk, block, stamp: zero ? ZERO : stamp });
	};
	for (const disk of [0, 1]) {
		for (let block = 0; block < BLOCKS; block += 1 + (block % 3)) write(disk, block);
		await disks[disk].flush();
	}
	const live: LiveDisk[] = disks.map((disk) => ({ disk, store: watchable(disk) }));
	return { disks, live, log, write };
}

/** What every block the log names held after its first `count` writes. */
function after(log: readonly Write[], count: number): Map<string, number> {
	const held = new Map<string, number>();
	for (const { disk, block } of log) held.set(`${disk}:${block}`, ZERO);
	for (const { disk, block, stamp } of log.slice(0, count)) held.set(`${disk}:${block}`, stamp);
	return held;
}

/** After how many of the writes, from `first` on, every block held that. Null when they never did. */
function momentOf(held: ReadonlyMap<string, number>, log: readonly Write[], first: number): number | null {
	const now = after(log, first);
	const wrong = new Set([...now].flatMap(([block, stamp]) => (held.get(block) === stamp ? [] : [block])));
	for (let count = first; count <= log.length; count++) {
		if (wrong.size === 0) return count;
		if (count === log.length) return null;
		const { disk, block, stamp } = log[count];
		const key = `${disk}:${block}`;
		if (held.get(key) === stamp) wrong.delete(key);
		else wrong.add(key);
	}
	return null;
}

async function heldIn(disks: readonly CowDisk[], log: readonly Write[]): Promise<Map<string, number>> {
	const held = new Map<string, number>();
	for (const { disk, block } of log) {
		const key = `${disk}:${block}`;
		if (!held.has(key)) held.set(key, await stampAt(disks[disk], block));
	}
	return held;
}

const copy: SetCopy = { n: N, extras: 1, from: 0, to: 1 };
const back: SetCopy = { n: N, extras: 1, from: 1, to: 2 };
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
	vi.restoreAllMocks();
	await deleteDisks(N, [0, 1, 2], 1);
});

test.each([1, 2, 3, 4])(
	"a checkpoint is both disks after some number of the guest's writes, whatever it writes meanwhile (run %i)",
	async () => {
		const { disks, live, log, write } = await guest();
		const asked = log.length;
		let going = true;
		const writing = (async () => {
			while (going) {
				for (let i = 0; i < 40; i++) {
					const disk = Math.random() < 0.5 ? 0 : 1;
					if (Math.random() < 0.2) {
						write(disk, 3000 + 3 * Math.floor(Math.random() * 200), true);
					} else {
						// Few enough blocks that many are written again, at both ends of what is copied.
						const at = Math.floor(Math.random() * 400);
						write(disk, Math.random() < 0.5 ? BLOCKS - 1 - at : at);
					}
					if (i % 10 === 0) void disks[i % 20 === 0 ? 0 : 1].flush();
				}
				await turn();
			}
		})();
		const bytes = await copyLive(copy, live, turn, () => {}).done;
		going = false;
		await writing;
		expect(log.length - asked, "it wrote on").toBeGreaterThan(200);
		expect(live.every(({ store }) => store.watcher === null)).toBe(true);
		await Promise.all(disks.map((disk) => disk.flush()));

		expect(await copyDisks("restore", back, () => {})).toBe(bytes);
		const restored = await openSet(2);
		expect(restored.map((disk) => disk.persistent)).toEqual([true, true]);
		expect(bytes).toBe(restored.reduce((sum, disk) => sum + disk.overlayBlocks * BLOCK, 0));
		const held = await heldIn(restored, log);
		expect(momentOf(held, log, asked), "no moment of the guest's").not.toBeNull();

		expect(await heldIn(disks, log), "the guest's own are as it wrote them").toEqual(after(log, log.length));
		for (const disk of restored) await disk.store?.close?.();
	},
);

test.each(["not saved", "being saved"])(
	"a block written just before the moment and %s is in the checkpoint as it was then, whatever comes after",
	async (state) => {
		const { disks, live, log, write } = await guest();
		const blocks = [0, 4, 5000];
		const rewrite = () => {
			for (const disk of [0, 1]) for (const block of blocks) write(disk, block);
		};
		let moment = 0;
		const flush = disks[1].flush.bind(disks[1]);
		disks[1].flush = async () => {
			await flush();
			rewrite();
			moment = log.length;
			disks[1].flush = flush;
			if (state === "being saved") void disks[0].flush();
			setTimeout(async () => {
				// Once into the buffers that the disk holds, and once more into new ones while those are saved.
				rewrite();
				const saved = [disks[0].flush(), flush()];
				rewrite();
				await Promise.all(saved);
			});
		};
		await copyLive(copy, live, turn, () => {}).done;
		await copyDisks("restore", back, () => {});
		expect(await heldIn(await openSet(2), log)).toEqual(after(log, moment));
	},
);

test.each(["save", "restore"] as const)("a %s that fails half way leaves nothing of it", async (why) => {
	await guest();
	const job = why === "save" ? copy : back;
	if (why === "restore") await copyDisks("save", copy, () => {});
	const before = await databases();
	let written = 0;
	const method = why === "save" ? "add" : "put";
	const real = IDBObjectStore.prototype[method];
	vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args) {
		if (++written > (why === "save" ? 5 : 2000)) throw new DOMException("no room", "QuotaExceededError");
		return real.apply(this, args);
	});
	await expect(copyDisks(why, job, () => {})).rejects.toMatchObject({ name: "QuotaExceededError" });
	expect(await databases()).toEqual(before);
});

test.each<[string, (store: IDBObjectStore) => boolean]>([
	["the checkpoint's", (store) => store.name === "packs"],
	["the guest's", (store) => store.name === "blocks"],
])("storage that runs out on %s write leaves no checkpoint, and the guest's writes saved", async (_, theirs) => {
	const { disks, live, log, write } = await guest();
	let copied = 0;
	let refused = 0;
	for (const method of ["add", "put"] as const) {
		const real = IDBObjectStore.prototype[method];
		vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (this: IDBObjectStore, ...args) {
			if (this.name === "packs") copied++;
			if (copied > 3 && theirs(this) && refused++ === 0) throw new DOMException("no room", "QuotaExceededError");
			return real.apply(this, args);
		});
	}
	const failing = vi.fn();
	for (const disk of disks) disk.onError = failing;
	let going = true;
	const writing = (async () => {
		while (going) {
			write(0, BLOCKS - 1 - (log.length % 100));
			await disks[0].flush();
		}
	})();
	await expect(copyLive(copy, live, turn, () => {}).done).rejects.toMatchObject({ name: "QuotaExceededError" });
	for (let i = 0; i < 20; i++) await turn();
	going = false;
	await writing;
	expect(refused).toBeGreaterThan(0);
	expect(failing).not.toHaveBeenCalled();
	expect(await databases()).not.toContain(checkpointDatabase(N, 1));
	await Promise.all(disks.map((disk) => disk.flush()));
	expect(await heldIn(await openSet(0), log)).toEqual(after(log, log.length));
});

test("one that is given up leaves nothing, whenever that is", async () => {
	const { live } = await guest();
	for (const turns of [0, 1, 3, 10, 30]) {
		const copying = copyLive(copy, live, turn, () => {});
		const ended = expect(copying.done).rejects.toThrow("It stopped.");
		for (let i = 0; i < turns; i++) await turn();
		await copying.giveUp(new Error("It stopped."));
		await ended;
		expect(await databases(), `after ${turns}`).not.toContain(checkpointDatabase(N, 1));
	}
});

test("a copy of disks that are not there, and a restore of what is not, fail and make nothing", async () => {
	await expect(copyDisks("save", copy, () => {})).rejects.toBeDefined();
	await expect(copyDisks("restore", back, () => {})).rejects.toBeDefined();
	expect(await databases()).toEqual([]);
	expect(extraStore(N, 0, 1)).toBe(`unlab-node${N}.extra1-v1`);
});
