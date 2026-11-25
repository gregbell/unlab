import { readFile } from "node:fs/promises";
import {
	bundledBoot,
	CowDisk,
	createKernel,
	decodeKwsparse,
	gunzipIfNeeded,
	type KernelInstance,
	type OverlayStore,
	SparseBase,
	ZeroBase,
} from "unkernel/node";
import { expect, test } from "vitest";
import { execAsRoot } from "../../src/runtime/guest.ts";
import { nextOf, saveDisks, shutDown } from "../../src/runtime/power.ts";
import { imagePath } from "../support/images.ts";

type Image = "alpine" | "debian";
const IMAGES: readonly Image[] = ["alpine", "debian"];

/** What a browser would have kept, and what it has been asked to keep. */
class Kept implements OverlayStore {
	readonly blocks = new Map<number, Uint8Array>();
	async open() {
		return { keys: new Set(this.blocks.keys()), initialized: true };
	}
	async getBlocks(blocks: number[]) {
		return new Map(blocks.flatMap((b) => (this.blocks.has(b) ? [[b, this.blocks.get(b) ?? new Uint8Array()]] : [])));
	}
	async save(puts: [number, Uint8Array][], dels: number[] = []) {
		for (const [b, data] of puts) this.blocks.set(b, data.slice());
		for (const b of dels) this.blocks.delete(b);
	}
	async clear() {
		this.blocks.clear();
	}
}

/** The root disk as the app first makes it. */
async function rootDisk(): Promise<CowDisk> {
	const wasm = await readFile(new URL(import.meta.resolve("unkernel/unkernel.wasm")));
	const { datadisk } = bundledBoot(await WebAssembly.compile(wasm));
	if (!datadisk) throw new Error("the kernel has no data disk");
	const base = SparseBase.fromKwsparse(decodeKwsparse(await gunzipIfNeeded(datadisk)));
	return new CowDisk(base, { store: new Kept() }).open();
}

const boot = (image: Image, disks: CowDisk[]): Promise<KernelInstance> =>
	createKernel({ distro: imagePath(image), disks, memoryMiB: 256, log: () => {} });

async function run(vm: KernelInstance, script: string): Promise<string> {
	const { exitCode, stdout, stderr } = await execAsRoot(vm, script);
	expect(exitCode, `${script}\n${stdout}${stderr}`).toBe(0);
	return stdout.trim();
}

test.each(IMAGES)(
	"%s shuts down when it is asked, ends what it runs first, and boots again on its disks",
	async (image) => {
		const disks = [await rootDisk()];
		for (const next of ["off", "reboot"] as const) {
			const vm = await boot(image, disks);
			await run(vm, `(trap "echo ${next} > /root/last; exit" TERM; while :; do sleep 0.1; done) >/dev/null 2>&1 &`);
			expect(await shutDown(vm, next, 10_000)).toBe(true);
			expect(nextOf(await vm.exited)).toBe(next);
			const again = await boot(image, disks);
			expect(await run(again, "cat /root/last; pidof sleep || :")).toBe(next);
			again.stop();
		}
	},
);

test.each(
	IMAGES.flatMap((image) => [
		{ image, command: "poweroff", next: "off" },
		{ image, command: "reboot", next: "reboot" },
		{ image, command: "halt", next: "off" },
		{ image, command: "poweroff -f", next: "off" },
		{ image, command: "reboot -f", next: "reboot" },
	]),
)("$command run by $image's own user is a guest that goes $next", async ({ image, command, next }) => {
	const vm = await boot(image, [await rootDisk()]);
	// Debian's own commands take no -f.
	const line = command.endsWith("-f") ? `sudo /run/kw-lower/bin/busybox ${command}` : command;
	vm.exec("/bin/sh", ["-lc", line]).catch(() => {});
	expect(nextOf(await vm.exited)).toBe(next);
});

test("a kernel that panics has not shut down", async () => {
	const vm = await boot("alpine", [await rootDisk()]);
	execAsRoot(vm, "echo ::restart:/bin/false >> /etc/inittab; kill -HUP 1; sleep 1; kill -QUIT 1").catch(() => {});
	const exit = await vm.exited;
	expect(exit).toMatchObject({ kind: "panic" });
	expect(nextOf(exit)).toBeNull();
});

test("a guest that does not shut down is given up on, with its files written back", async () => {
	const disks = [await rootDisk()];
	const vm = await boot("alpine", disks);
	await run(vm, 'printf "#!/bin/sh\\n" > /usr/local/sbin/poweroff; echo late > /root/late');
	const asked = performance.now();
	expect(await shutDown(vm, "off", 500)).toBe(false);
	expect(performance.now() - asked).toBeLessThan(4000);
	await vm.stop();
	const again = await boot("alpine", disks);
	expect(await run(again, "cat /root/late")).toBe("late");
	again.stop();
});

test("what a disk took and no one flushed is saved once the guest has powered off without syncing", async () => {
	const kept = new Kept();
	const extra = await new CowDisk(new ZeroBase(2 ** 30), { store: kept }).open();
	const disks = [await rootDisk(), extra];
	const vm = await boot("alpine", disks);
	execAsRoot(
		vm,
		"printf last | dd of=/dev/wdc bs=4096 seek=100 conv=notrunc oflag=direct; /run/kw-lower/bin/busybox poweroff -nf",
	).catch(() => {});
	await vm.exited;
	expect(kept.blocks.has(100)).toBe(false);
	expect(await saveDisks(disks)).toBe(true);
	expect(new TextDecoder().decode(kept.blocks.get(100)?.subarray(0, 4))).toBe("last");
});

test("a disk that cannot be saved is said", async () => {
	const kept = new Kept();
	kept.save = () => Promise.reject(new DOMException("full", "QuotaExceededError"));
	const disk = await new CowDisk(new ZeroBase(2 ** 20), { store: kept, log: () => {} }).open();
	await disk.write(0, [new Uint8Array(4096).fill(1)]);
	expect(await saveDisks([disk])).toBe(false);
});
