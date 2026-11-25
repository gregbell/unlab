// Build the lab image: the mirrored Alpine image with the tools a lab needs
// already installed, so a machine with no way to the internet has them.
//
//   npm run distros -- alpine
//   nix shell nixpkgs#erofs-utils -c node scripts/build-lab-image.ts out/lab.erofs
//
// Alpine's own package manager does the work in a guest. Needs the internet,
// and an mkfs.erofs that has zstd (erofs-utils 1.8 or later). Package versions
// are whatever Alpine serves that day, so the result is published once, as a
// release asset, and pinned by checksum in scripts/lab-image.ts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CowDisk, createKernel, directBackend, MemoryFs, ZeroBase } from "unkernel/node";

const PACKAGES = [
	"bind-tools",
	"blkid",
	"curl",
	"e2fsprogs",
	"e2fsprogs-extra",
	"iproute2",
	"lsblk",
	"nginx",
	"openssh",
	"parted",
	"sfdisk",
	"strace",
	"tcpdump",
	"wipefs",
];

const ALPINE = fileURLToPath(new URL("../public/distros/alpine.erofs", import.meta.url));
const ROOT = "/mnt/work/root";

async function tree(): Promise<Uint8Array> {
	const out = new MemoryFs();
	const vm = await createKernel({
		distro: ALPINE,
		disks: [new CowDisk(new ZeroBase(4 * 2 ** 30))],
		memoryMiB: 3072,
		net: directBackend(),
		log: () => {},
		mounts: { "/mnt/out": out },
	});
	const run = async (script: string): Promise<void> => {
		const { exitCode, stdout, stderr } = await vm.exec("/bin/sh", ["-ec", script], { user: "root" });
		console.log(`${stdout}${stderr}`.trim());
		if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${script}`);
	};
	await run(`/usr/lib/kw/net wait
		mkdir -p /mnt/src /mnt/work
		mount -t tmpfs -o size=2g tmpfs /mnt/work
		mount -t erofs -o ro /dev/wda /mnt/src
		cp -a /mnt/src ${ROOT}`);
	// Package scripts run in the tree, and write to these.
	await run(`mkdir -p ${ROOT}/dev ${ROOT}/proc
		mount --bind /dev ${ROOT}/dev
		mount -t proc proc ${ROOT}/proc
		apk add --root ${ROOT} --no-cache --repositories-file /etc/apk/repositories ${PACKAGES.join(" ")}
		umount ${ROOT}/dev ${ROOT}/proc`);
	// As packaged, nginx does not start here: /run is empty at every boot, so its directory there is gone, and the kernel has no IPv6.
	await run(`sed -i '1i pid /run/nginx.pid;' ${ROOT}/etc/nginx/nginx.conf
		sed -i '/listen \\[::\\]/d' ${ROOT}/etc/nginx/http.d/default.conf
		tar -C ${ROOT} --numeric-owner -cf /mnt/out/lab.tar .`);
	const tar = out.readFile("/lab.tar");
	vm.stop();
	return tar;
}

async function main(): Promise<void> {
	const [target] = process.argv.slice(2);
	if (!target) throw new Error("usage: node scripts/build-lab-image.ts <file>");
	const work = mkdtempSync(join(tmpdir(), "unlab-image-"));
	try {
		const tar = join(work, "lab.tar");
		writeFileSync(tar, await tree());
		mkdirSync(dirname(target), { recursive: true });
		rmSync(target, { force: true });
		// As unkernel packs its own: no other compression that its kernel can read is as small.
		const options = ["-zzstd,level=15", "-C131072", "-Efragments,dedupe", "-Lkwroot", "-T0", "-Uclear", "--quiet"];
		execFileSync("mkfs.erofs", ["--tar=f", ...options, target, tar], { stdio: "inherit" });
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	const bytes = readFileSync(target);
	console.log(`${target}\n  size   ${bytes.length}\n  sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
}

await main();
process.exit(0);
