import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	bundledBoot,
	CowDisk,
	createKernel,
	decodeKwsparse,
	directBackend,
	gunzipIfNeeded,
	SparseBase,
	ZeroBase,
} from "unkernel/node";
import { expect, test } from "vitest";
import { execAsRoot } from "../../src/runtime/guest.ts";
import { imagePath } from "../support/images.ts";

type Image = "alpine" | "debian";
const GIB = 2 ** 30;

/** The root disk as the app first makes it, in memory. */
async function rootDisk(): Promise<CowDisk> {
	const wasm = await readFile(new URL(import.meta.resolve("unkernel/unkernel.wasm")));
	const { datadisk } = bundledBoot(await WebAssembly.compile(wasm));
	if (!datadisk) throw new Error("the kernel has no data disk");
	return new CowDisk(SparseBase.fromKwsparse(decodeKwsparse(await gunzipIfNeeded(datadisk))));
}

const blank = (gib: number) => new CowDisk(new ZeroBase(gib * GIB));

async function contents(disk: CowDisk): Promise<string> {
	const hash = createHash("sha256");
	for (const part of (await disk.exportParts()).parts)
		hash.update(new Uint8Array(await new Blob([part]).arrayBuffer()));
	return hash.digest("hex");
}

async function boot<T>(
	image: Image,
	disks: CowDisk[],
	body: (run: (script: string) => Promise<string>) => Promise<T>,
): Promise<T> {
	const vm = await createKernel({
		distro: imagePath(image),
		disks,
		net: directBackend(),
		memoryMiB: 256,
		log: () => {},
	});
	try {
		return await body(async (script) => {
			const { exitCode, stdout, stderr } = await execAsRoot(vm, script);
			expect(exitCode, `${script}\n${stdout}${stderr}`).toBe(0);
			return stdout.trim();
		});
	} finally {
		vm.stop();
	}
}

const FDISK: Readonly<Record<Image, string>> = { alpine: "fdisk", debian: "/run/kw-lower/bin/fdisk" };

test.each<Image>(["alpine", "debian"])(
	"extra disks on %s are blank, of their size, and can be partitioned",
	async (image) => {
		await boot(image, [await rootDisk(), blank(1), blank(64)], async (run) => {
			const sizes = await run("cd /sys/block; for d in wd*; do echo $d $(cat $d/size); done");
			const [, , wdc, wdd, ...more] = sizes.split("\n");
			expect([wdc, wdd, more]).toEqual([`wdc ${GIB / 512}`, `wdd ${(64 * GIB) / 512}`, []]);
			expect(await run("tr -d '\\000' < /dev/wdc | wc -c")).toBe("0");
			expect(await run("grep -c '^/dev/wd[cd]' /proc/mounts || :")).toBe("0");
			await run(`printf 'n\\np\\n1\\n\\n+256M\\nw\\n' | ${FDISK[image]} /dev/wdc`);
			expect(await run("cat /sys/class/block/wdc1/size")).toBe(String((256 * 2 ** 20) / 512));
		});
	},
);

test("an extra disk is left alone at boot, whatever its file system is labelled", async () => {
	const disks = [await rootDisk(), blank(1), blank(1), blank(1)];
	const [, ...extras] = disks;
	await boot("alpine", disks, async (run) => {
		await run("/usr/lib/kw/net wait; apk add --quiet e2fsprogs");
		// Smaller than their disks, so that growing one would show.
		await run("mkfs.ext4 -q -L kwdata /dev/wdc 100M");
		await run("mkfs.ext4 -q -L kwroot /dev/wdd 100M");
		await run("sync; dd if=/dev/wdb of=/dev/wde bs=1M count=64 2>/dev/null");
		await run("mount /dev/wdc /mnt && echo mine > /mnt/note && umount /mnt");
		await run("echo root > /root/note; sync");
	});
	const before = await Promise.all(extras.map(contents));

	for (const image of ["debian", "alpine"] as const) {
		await boot(image, disks, async (run) => {
			expect(await run("grep ^/dev/wd /proc/mounts | cut -d' ' -f1 | sort")).toBe("/dev/wda\n/dev/wdb");
			expect(await run("grep ' /data ' /proc/mounts")).toMatch(/^\/dev\/wdb /);
			expect(await run("sed -n s/^upper=//p /run/kw-base")).toBe("data");
			if (image === "alpine") expect(await run("cat /root/note")).toBe("root");
		});
		expect(await Promise.all(extras.map(contents))).toEqual(before);
	}
	await boot("debian", disks, async (run) => {
		expect(await run("mount /dev/wdc /mnt && cat /mnt/note")).toBe("mine");
	});
});
