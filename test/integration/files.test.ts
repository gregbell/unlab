import { createHash } from "node:crypto";
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
} from "unkernel/node";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MAX_TEXT_BYTES } from "../../src/commands/index.ts";
import { execAsRoot } from "../../src/runtime/guest.ts";
import { writeFile } from "../../src/runtime/write-file.ts";
import { imagePath } from "../support/images.ts";

/** What a browser would have kept of a disk. */
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

async function openDisk(store: OverlayStore): Promise<CowDisk> {
	const wasm = await readFile(new URL(import.meta.resolve("unkernel/unkernel.wasm")));
	const { datadisk } = bundledBoot(await WebAssembly.compile(wasm));
	if (!datadisk) throw new Error("the kernel has no data disk");
	return new CowDisk(SparseBase.fromKwsparse(decodeKwsparse(await gunzipIfNeeded(datadisk))), { store }).open();
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const written = (path: string, owner = "root:root", mode = "644") => ({ kind: "written", path, owner, mode });

describe.each(["alpine", "debian"] as const)("%s", (image) => {
	const kept = new Kept();
	let vm: KernelInstance;
	const boot = async () =>
		createKernel({ distro: imagePath(image), disks: [await openDisk(kept)], memoryMiB: 256, log: () => {} });
	beforeAll(async () => {
		vm = await boot();
	});
	afterAll(async () => {
		await vm.stop();
	});

	const run = async (script: string): Promise<string> => {
		const { exitCode, stdout, stderr } = await execAsRoot(vm, script);
		expect(exitCode, `${script}\n${stdout}${stderr}`).toBe(0);
		return stdout.trim();
	};
	const put = (path: string, text: string, set: { owner?: string; mode?: string } = {}) =>
		writeFile(vm, "node1", { path, text, owner: set.owner ?? null, mode: set.mode ?? null });
	const refused = async (path: string, text: string, set: { owner?: string; mode?: string } = {}) => {
		const outcome = await put(path, text, set);
		if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
		return outcome.reason;
	};
	const sum = async (path: string) => (await run(`sha256sum < ${path}`)).split(" ")[0];
	const stat = (path: string) => run(`stat -c '%U:%G %a' ${path}`);
	/** Nothing of a write is left over. */
	const tidy = () => run("find / /run /tmp -xdev -name '*unlab.??????' | grep -v /proc || echo none");

	test("a text arrives byte for byte, whatever is in it", async () => {
		const texts = [
			"",
			"\n",
			"no newline",
			" \t leading and trailing \t \n\n\n",
			"'single' \"double\" `id` $(id) $HOME \x24{PATH} \\n \\\\ \\ ! # ~ * ? [a] {b} ; & | < > % %s %%\n",
			"--\n-- --mode 600\n--owner user\n-n -e\n",
			"line\r\nline\rline\n",
			"é ü ß 漢字 🧪 👩‍👩‍👧 \u{feff}     ‮\n",
			"﻿starts with a mark",
			"nul \0 bell \x07 escape \x1b[31m delete \x7f end \x04 cancel \x03 stop \x13 \x1a",
			"EOF\nEOT\n$1 $2\n",
			`${"x".repeat(200_000)}\n`,
			"é".repeat(MAX_TEXT_BYTES / 2),
		];
		for (const text of texts) {
			expect(await put("/root/text", text)).toEqual(written("/root/text"));
			expect(await sum("/root/text"), JSON.stringify(text.slice(0, 60))).toBe(sha256(text));
		}
		expect(await tidy()).toBe("none");
	});

	test("paths with spaces, quotes, dollars, backslashes and non-ASCII are one file", async () => {
		for (const path of ['/srv/a b/it\'s "c".txt', "/srv/$HOME/`id`", "/srv/back\\slash\\n", "/srv/日本/é", "/srv/-n"]) {
			expect(await put(path, path)).toEqual(written(path));
		}
		expect(await run("find /srv -type f | sort | tr '\\n' '|'")).toBe(
			`${['/srv/a b/it\'s "c".txt', "/srv/$HOME/`id`", "/srv/back\\slash\\n", "/srv/日本/é", "/srv/-n"]
				.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
				.join("|")}|`,
		);
	});

	test("a new file is root's with mode 644, and a new directory is the file's owner's with 755", async () => {
		expect(await put("/opt/one/two/new", "a")).toEqual(written("/opt/one/two/new"));
		expect(await stat("/opt/one /opt/one/two")).toBe("root:root 755\nroot:root 755");
		expect(await put("/home/user/.config/app/rc", "a", { owner: "user", mode: "600" })).toEqual(
			written(
				"/home/user/.config/app/rc",
				await run("id -un user; id -gn user").then((s) => s.replace("\n", ":")),
				"600",
			),
		);
		expect(await stat("/home/user/.config /home/user/.config/app")).toMatch(/^user:\w+ 755\nuser:\w+ 755$/);
		const before = await stat("/opt/one");
		await put("/opt/one/owned", "a", { owner: "nobody" });
		expect(await stat("/opt/one"), "one that was there keeps its owner").toBe(before);
		expect(await put("/opt/suid", "a", { mode: "4755" })).toEqual(written("/opt/suid", "root:root", "4755"));
		expect(await put("/opt/ids", "a", { owner: "1234:5678" })).toEqual(written("/opt/ids", "1234:5678"));
		expect(await put("/opt/uid", "a", { owner: await run("id -u user") })).toEqual(
			written("/opt/uid", await run("id -un user; id -gn user").then((s) => s.replace("\n", ":"))),
		);
		expect(await put("/opt/no-one", "a", { owner: "4321" })).toEqual(written("/opt/no-one", "4321:root"));
		expect(await put("/opt/group", "a", { owner: "root:tty" })).toEqual(written("/opt/group", "root:tty"));
	});

	test("a file that is there keeps the owner and mode that were not given", async () => {
		await run("echo old > /opt/kept; chown nobody:tty /opt/kept; chmod 4750 /opt/kept");
		expect(await put("/opt/kept", "new")).toEqual(written("/opt/kept", "nobody:tty", "4750"));
		expect(await put("/opt/kept", "new", { owner: "user:tty" })).toEqual(written("/opt/kept", "user:tty", "4750"));
		expect(await put("/opt/kept", "new", { mode: "600" })).toEqual(written("/opt/kept", "user:tty", "600"));
	});

	test("a link is followed, also to a file that is not there yet", async () => {
		await run(
			"mkdir -p /opt/links; cd /opt/links; echo old > real; ln -s real to; ln -s to again; ln -s /opt/links/later new",
		);
		expect(await put("/opt/links/again", "through")).toEqual(written("/opt/links/real"));
		expect(await put("/opt/links/new", "made")).toEqual(written("/opt/links/later"));
		expect(await run("cd /opt/links; cat real later; readlink to; readlink again; readlink new")).toBe(
			"throughmadereal\nto\n/opt/links/later",
		);
		await run("ln -s /opt/links /opt/dir");
		expect(await put("/opt/dir/sub/file", "a")).toEqual(written("/opt/dir/sub/file"));
		expect(await run("cat /opt/links/sub/file")).toBe("a");
	});

	test("what cannot be written says why, and leaves nothing changed", async () => {
		await run("echo kept > /opt/file; mkfifo /opt/fifo; ln -s /nowhere/at/all /opt/lost; ln -s loop /opt/loop");
		const before = await run("find /opt -printf '%p %u %m %s\\n' 2>/dev/null | sort || find /opt | sort");
		expect(await refused("/etc", "a")).toBe("/etc on node1 is a directory, so give the path of a file in it.");
		expect(await refused("/opt/file/a/b", "a")).toBe(
			"/opt/file on node1 is not a directory, so /opt/file/a/b cannot be in it.",
		);
		expect(await refused("/opt/lost/a", "a")).toBe(
			"/opt/lost on node1 is not a directory, so /opt/lost/a cannot be in it.",
		);
		expect(await refused("/opt/lost", "a")).toBe(
			"/opt/lost on node1 is a link to /nowhere/at/all, and the directory that is in does not exist.",
		);
		expect(await refused("/opt/loop", "a")).toMatch(/^\/opt\/loop on node1 is a link to loop/);
		expect(await refused("/opt/fifo", "a")).toBe(
			"/opt/fifo on node1 is not a regular file, so write cannot replace it.",
		);
		expect(await refused("/dev/null", "a")).toBe(
			"/dev/null on node1 is not a regular file, so write cannot replace it.",
		);
		expect(await refused("/opt/new/file", "a", { owner: "bob" })).toBe(
			"node1 has no user called bob, so --owner cannot name it.",
		);
		expect(await refused("/opt/new/file", "a", { owner: "user:staph" })).toBe(
			"node1 has no group called staph, so --owner cannot name it.",
		);
		expect(await refused("/opt/file", "a", { owner: "bob:tty" })).toBe(
			"node1 has no user called bob, so --owner cannot name it.",
		);
		expect(await refused(`/opt/new/${"n".repeat(300)}`, "a")).toMatch(
			/^node1 could not write .*: File ?name too long\.$/,
		);
		expect(await run("find /opt -printf '%p %u %m %s\\n' 2>/dev/null | sort || find /opt | sort")).toBe(before);
		expect(await run("cat /opt/file")).toBe("kept");
		expect(await tidy()).toBe("none");
	});

	test("a file system that is full or read-only is named, and the old file is whole", async () => {
		await run("mkdir -p /mnt/small /mnt/ro; mount -t tmpfs -o size=64k tmpfs /mnt/small; mount -t tmpfs tmpfs /mnt/ro");
		await run("echo old > /mnt/small/a; echo old > /mnt/ro/a; mount -o remount,ro /mnt/ro");
		const big = "x".repeat(100_000);
		expect(await refused("/mnt/small/a", big)).toBe(
			"The file system on /mnt/small of node1 is full, so /mnt/small/a was not written.",
		);
		expect(await refused("/mnt/small/new/dir/a", big)).toBe(
			"The file system on /mnt/small of node1 is full, so /mnt/small/new/dir/a was not written.",
		);
		for (const path of ["/mnt/ro/a", "/mnt/ro/new", "/mnt/ro/dir/new"]) {
			expect(await refused(path, "new")).toBe(
				`The file system on /mnt/ro of node1 is read-only, so ${path} cannot be written.`,
			);
		}
		expect(await run("cd /mnt; cat small/a ro/a; ls -A small; ls -A ro")).toBe("old\nold\na\na");
		expect(await put("/mnt/small/a", "fits")).toEqual(written("/mnt/small/a"));
	});

	test("a program that reads the file as it is written has the old one or the new one, whole", async () => {
		await put("/opt/read", "old\n");
		await run("(while [ ! -e /run/enough ]; do wc -c < /opt/read >> /run/sizes; done) >/dev/null 2>&1 &");
		for (let i = 1; i <= 4; i++) await put("/opt/read", "x".repeat(MAX_TEXT_BYTES - i));
		await run("touch /run/enough");
		const sizes = (await run("sort -nu /run/sizes")).split("\n").map(Number);
		expect(sizes.filter((size) => size !== 4 && size < MAX_TEXT_BYTES - 4)).toEqual([]);
		expect(sizes.length, "it was read while it changed").toBeGreaterThan(2);
	});

	test("a file that nothing can be renamed over is written over, and put back when that fails", async () => {
		await run(
			"echo inner > /opt/inner; echo outer > /opt/mounted; chmod 640 /opt/inner; mount --bind /opt/inner /opt/mounted",
		);
		expect(await put("/opt/mounted", "both\n")).toEqual(written("/opt/mounted", "root:root", "640"));
		expect(await run("cat /opt/inner /opt/mounted")).toBe("both\nboth");
		expect(await put("/opt/mounted", "set\n", { owner: "nobody:tty", mode: "604" })).toEqual(
			written("/opt/mounted", "nobody:tty", "604"),
		);
		expect(await refused("/opt/mounted", "x", { owner: "bob" })).toBe(
			"node1 has no user called bob, so --owner cannot name it.",
		);
		expect(await run("cat /opt/inner; stat -c '%U %a' /opt/inner; umount /opt/mounted; cat /opt/mounted")).toBe(
			"set\nnobody 604\nouter",
		);

		await run(
			"mkdir -p /mnt/tiny; mount -t tmpfs -o size=32k tmpfs /mnt/tiny; echo old > /mnt/tiny/a; mount --bind /mnt/tiny/a /opt/mounted",
		);
		expect(await refused("/opt/mounted", "x".repeat(60_000))).toMatch(/is full, so \/opt\/mounted was not written\.$/);
		expect(await run("cat /opt/mounted; umount /opt/mounted")).toBe("old");

		await run("sysctl -w net.ipv4.ip_forward=0");
		expect(await put("/proc/sys/net/ipv4/ip_forward", "1")).toMatchObject({ kind: "written" });
		expect(await run("cat /proc/sys/net/ipv4/ip_forward")).toBe("1");
		expect(await refused("/proc/sys/net/ipv4/ip_forward", "yes")).toMatch(
			/^node1 could not write \/proc\/sys\/net\/ipv4\/ip_forward: Invalid argument\.$/i,
		);
		expect(await run("cat /proc/sys/net/ipv4/ip_forward")).toBe("1");
		expect(await refused("/proc/new", "1")).toMatch(/^node1 could not write \/proc\/new: /);
		expect(await tidy()).toBe("none");
	});

	test("a text that does not all arrive, and a guest that does not answer, are said", async () => {
		await run("echo old > /opt/part");
		const cut: Pick<KernelInstance, "exec"> = {
			exec: ((file: string, args: string[], opts: { input: Uint8Array }) =>
				vm.exec(file, args, { ...opts, input: opts.input.subarray(0, 5) })) as KernelInstance["exec"],
		};
		expect(await writeFile(cut, "node1", { path: "/opt/part", text: "a whole text", owner: null, mode: null })).toEqual(
			{
				kind: "refused",
				reason: "The text did not all reach node1, so /opt/part was not written.",
			},
		);
		expect(await run("cat /opt/part")).toBe("old");
		const stuck: Pick<KernelInstance, "exec"> = {
			exec: ((_: string, __: string[], opts: object) =>
				vm.exec("/bin/sleep", ["30"], opts)) as unknown as KernelInstance["exec"],
		};
		expect(await writeFile(stuck, "node1", { path: "/opt/part", text: "a", owner: null, mode: null }, 500)).toEqual({
			kind: "unsure",
			reason: "node1 did not answer in 0.5 s, so check whether /opt/part was written.",
		});
	});

	test("what is written is on the disk at once", async () => {
		expect(await put("/root/deep/er/durable", "kept\n", { mode: "640" })).toMatchObject({ kind: "written" });
		expect(await put("/etc/motd", "hello\n")).toMatchObject({ kind: "written" });
		const blocks = new Map(kept.blocks);
		await vm.stop();
		kept.blocks.clear();
		for (const [b, data] of blocks) kept.blocks.set(b, data);
		vm = await boot();
		expect(await run("cat /root/deep/er/durable /etc/motd; stat -c %a /root/deep/er/durable")).toBe("kept\nhello\n640");
	});
});
