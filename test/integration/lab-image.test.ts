import { CowDisk, createKernel, type KernelInstance, ZeroBase } from "unkernel/node";
import { afterAll, beforeAll, expect, test } from "vitest";
import { execAsRoot } from "../../src/runtime/guest.ts";
import { imagePath } from "../support/images.ts";

let vm: KernelInstance;

beforeAll(async () => {
	const disks = [new CowDisk(new ZeroBase(2 ** 30)), new CowDisk(new ZeroBase(2 ** 30))];
	vm = await createKernel({ distro: imagePath("lab"), disks, memoryMiB: 256, log: () => {} });
});
afterAll(() => vm.stop());

async function run(script: string): Promise<string> {
	const { exitCode, stdout, stderr } = await execAsRoot(vm, `set -e\n${script}`);
	expect(exitCode, `${script}\n${stdout}${stderr}`).toBe(0);
	return stdout.trim();
}

test("the lab image has no network here, so what it has is its own", async () => {
	expect((await run("ip -br link | awk '{ print $1 }'")).split("\n")).not.toContain("eth0");
});

test("ip is iproute2's", async () => {
	expect(await run("ip -V")).toContain("iproute2");
	expect(await run("ip -j addr show lo")).toContain('"127.0.0.1"');
});

test("nginx starts as packaged, curl fetches from it, and tcpdump shows it", async () => {
	await run("timeout 20 tcpdump -lni lo -c 3 'tcp port 80' > /tmp/capture 2>/dev/null & sleep 2; nginx");
	expect(await run("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/")).toBe("404");
	await run(
		"echo 'server { listen 8080; location / { return 200 hello; } }' > /etc/nginx/http.d/page.conf; nginx -s reload",
	);
	expect(await run("sleep 1; curl -s http://127.0.0.1:8080/")).toBe("hello");
	expect(await run("cat /tmp/capture")).toMatch(/127\.0\.0\.1\.\d+ > 127\.0\.0\.1\.80: Flags \[S\]/);
});

test("ssh logs in to sshd", async () => {
	await run("ssh-keygen -A > /dev/null; /usr/sbin/sshd");
	await run(
		"ssh-keygen -q -t ed25519 -N '' -f /tmp/key; mkdir -p -m 700 ~root/.ssh; cp /tmp/key.pub ~root/.ssh/authorized_keys",
	);
	const ssh = "ssh -i /tmp/key -o StrictHostKeyChecking=no -o LogLevel=ERROR root@127.0.0.1";
	expect(await run(`${ssh} 'echo over $SSH_CONNECTION'`)).toMatch(/^over 127\.0\.0\.1 \d+ 127\.0\.0\.1 22$/);
});

test("dig asks a name server", async () => {
	const asked = await run(
		"timeout 20 tcpdump -lni lo -c 1 'udp port 53' > /tmp/dns 2>/dev/null & sleep 2; dig @127.0.0.1 +time=1 +tries=1 name.test || true; sleep 1; cat /tmp/dns",
	);
	expect(asked).toContain("DiG 9");
	expect(asked).toContain("A? name.test.");
});

test("strace runs a command to completion and prints its system calls", async () => {
	const traced = await run("timeout 20 strace cat /etc/hostname 2>&1");
	expect(traced).toMatch(/openat\(AT_FDCWD, "\/etc\/hostname", .*\) = \d+/);
	expect(traced).toContain("+++ exited with 0 +++");
});

test.each([
	["sfdisk", "printf 'label: gpt\\n,\\n' | sfdisk -q /dev/wdc"],
	["parted", "wipefs -qa /dev/wdc; parted -s /dev/wdc mklabel gpt mkpart data ext4 1MiB 100%"],
])("%s partitions a disk, and a file system on the partition is made, checked and mounted", async (_, partition) => {
	await run(`${partition}; mkfs.ext4 -qF /dev/wdc1; mount /dev/wdc1 /mnt; echo kept > /mnt/note; umount /mnt`);
	await run("e2fsck -fn /dev/wdc1");
	expect(await run("mount /dev/wdc1 /mnt; cat /mnt/note; umount /mnt")).toBe("kept");
	expect(await run("lsblk -no NAME,FSTYPE /dev/wdc1; blkid -s TYPE -o value /dev/wdc1")).toMatch(/wdc1 +ext4\s+ext4/);
});
