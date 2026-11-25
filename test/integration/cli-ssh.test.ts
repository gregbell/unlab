// SSH from this computer into real machines: the CLI's own process, the
// computer's own ssh, scp and rsync, and the machine's end as its worker runs it.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { freePort, hasRsync, linkMachines, type Session, TestCli, type TestPage } from "../support/cli.ts";
import { bootLab, type TestLab } from "./lab.ts";

const IMAGES = ["alpine", "debian", "lab"] as const;

let cli: TestCli;
let session: Session;
let lab: TestLab;
let page: TestPage;

beforeAll(async () => {
	cli = new TestCli(await freePort());
	session = cli.start();
	await session.shows("Waiting for the lab");
	lab = await bootLab([
		...IMAGES.map((distro, i) => ({
			n: i + 1,
			name: `on-${distro}`,
			ports: [([1, 2, 3] as const)[i]],
			distro,
			gateway: "packages" as const,
		})),
		{ n: 4, name: "nogateway", ports: [4], distro: "alpine" },
		{ n: 5, name: "unplugged", ports: [null], distro: "alpine" },
		{ n: 6, name: "taken", ports: [5], distro: "alpine" },
	]);
	page = await linkMachines(
		cli,
		lab.machines.map((machine, i) => ({ machine, n: i + 1, image: IMAGES[i] ?? "alpine" })),
	);
	await session.shows("Linked to the lab");
});

afterAll(async () => {
	page?.close();
	await lab?.stop();
	cli?.close();
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const named = (name: string) => {
	const machine = lab.machines.find((m) => m.name === name);
	if (!machine) throw new Error(`no ${name}`);
	return machine;
};

test.each([...IMAGES.map((image) => `on-${image}`), "nogateway", "unplugged"])(
	"a shell as user and as root, quickly, in %s",
	async (name) => {
		const t0 = performance.now();
		const first = await cli.ssh(`${name}.unlab`, "id -un; hostname");
		const firstMs = performance.now() - t0;
		expect(first).toMatchObject({ code: 0, stdout: `user\n${name}\n`, stderr: "" });
		const t1 = performance.now();
		expect(await cli.ssh(`root@${name}.unlab`, "id -un")).toMatchObject({ code: 0, stdout: "root\n" });
		const laterMs = performance.now() - t1;
		console.log(`${name}: first ${Math.round(firstMs)} ms, later ${Math.round(laterMs)} ms`);
		expect(firstMs).toBeLessThan(3000);
		expect(laterMs).toBeLessThan(1000);
	},
);

test.each(IMAGES)("a command finds what a login finds on %s", async (image) => {
	const path = (await cli.ssh(`on-${image}.unlab`, "echo $PATH")).stdout.trim().split(":");
	for (const dir of ["/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]) expect(path).toContain(dir);
	expect(await cli.ssh(`on-${image}.unlab`, "sudo sh -c 'command -v ip'")).toMatchObject({ code: 0 });
});

test("a terminal's own environment does not matter to ssh", async () => {
	const bare = ["-i", `PATH=${process.env.PATH}`, `HOME=${cli.dir}`, "ssh", "-F", join(cli.dir, "person_config")];
	expect(await cli.run("env", [...bare, "on-alpine.unlab", "hostname"])).toMatchObject({
		code: 0,
		stdout: "on-alpine\n",
	});
});

test("a command's exit status is the shell's, at the CLI too", async () => {
	expect((await cli.ssh("on-alpine.unlab", "exit 7")).code).toBe(7);
	expect(await cli.once("ssh", "on-alpine", "--", "echo out; echo err >&2; exit 3")).toMatchObject({
		code: 3,
		stdout: "out\n",
		stderr: "err\n",
	});
});

test("the terminal's size reaches the guest", async () => {
	const script = `stty cols 91 rows 33; ssh -tt -F ${join(cli.dir, "person_config")} on-alpine.unlab 'stty size'`;
	const ran = await cli.run("script", ["-qec", script, "/dev/null"]);
	expect(ran.stdout).toContain("33 91");
});

test.each(IMAGES)("scp and rsync copy 10 MiB each way on %s", async (image) => {
	const bytes = randomBytes(10 * 2 ** 20);
	const here = join(cli.dir, `${image}-there`);
	const back = join(cli.dir, `${image}-back`);
	writeFileSync(here, bytes);
	expect(await cli.scp(here, `on-${image}.unlab:/tmp/file`)).toMatchObject({ code: 0, stderr: "" });
	expect((await cli.ssh(`on-${image}.unlab`, "sha256sum /tmp/file")).stdout).toContain(sha256(bytes));
	expect(await cli.scp(`on-${image}.unlab:/tmp/file`, back)).toMatchObject({ code: 0 });
	expect(sha256(readFileSync(back))).toBe(sha256(bytes));

	if (!hasRsync()) throw new Error("This test needs rsync on this computer.");
	expect(await cli.rsync(here, `on-${image}.unlab:/tmp/synced`)).toMatchObject({ code: 0, stderr: "" });
	expect((await cli.ssh(`on-${image}.unlab`, "sha256sum /tmp/synced")).stdout).toContain(sha256(bytes));
	writeFileSync(back, "");
	expect(await cli.rsync(`on-${image}.unlab:/tmp/synced`, back)).toMatchObject({ code: 0 });
	expect(sha256(readFileSync(back))).toBe(sha256(bytes));
});

test("ssh -L reaches a web server in the guest", async () => {
	const site = "server { listen 80; root /srv/www; }";
	await named("on-lab").run(
		`mkdir -p /run/nginx /srv/www; echo hello from nginx > /srv/www/index.html; echo '${site}' > /etc/nginx/http.d/default.conf; nginx`,
	);
	const port = await freePort();
	const tunnel = cli.ssh("-L", `${port}:localhost:80`, "on-lab.unlab", "sleep 5");
	let body = "";
	for (let i = 0; i < 40 && body === ""; i++) {
		body = await fetch(`http://127.0.0.1:${port}/`).then(
			(r) => r.text(),
			() => new Promise<string>((resolve) => setTimeout(() => resolve(""), 100)),
		);
	}
	expect(body).toBe("hello from nginx\n");
	await tunnel;
});

test("nothing of it is on a disk or on a network, and only the CLI's key opens it", async () => {
	const machine = named("on-alpine");
	const found = await machine.run(
		"find / -xdev \\( -name '*dropbear*' -o -name authorized_keys -o -name 'sftp-server' \\) 2>/dev/null; true",
	);
	expect(found).toBe("");
	expect(await machine.run("ls /run/unlab-ssh")).toContain("authorized_keys");
	const listening = await machine.run("netstat -ltn 2>/dev/null | awk '/LISTEN/ { print $4 }'");
	expect(listening.trim().split("\n")).toEqual(["127.0.0.1:47022"]);
	const other = await named("on-lab").exec("nc -w 2 10.88.0.11 47022 </dev/null");
	expect(other.exitCode).not.toBe(0);

	const key = join(cli.dir, "another");
	await cli.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
	const proxy = `${process.execPath} ${join(cli.dir, "cli.mjs")} proxy %h ${join(cli.dir, "cli.sock")}`;
	const bare = ["-F", "/dev/null", "-o", `ProxyCommand=${proxy}`, "-o", "StrictHostKeyChecking=no"].concat([
		"-o",
		"UserKnownHostsFile=/dev/null",
		"-o",
		"BatchMode=yes",
		"-o",
		"IdentitiesOnly=yes",
	]);
	const refused = await cli.run("ssh", [...bare, "-i", key, "user@on-alpine.unlab", "true"]);
	expect(refused.code).toBe(255);
	expect(refused.stderr).toContain("Permission denied (publickey)");
});

test("an SSH session puts no frame on the switch", async () => {
	await cli.ssh("on-alpine.unlab", "true");
	const before = lab.frames.length;
	await cli.ssh("on-alpine.unlab", "seq 1000");
	const mac = named("on-alpine").macs[0];
	const since = lab.frames.slice(before).filter((e) => JSON.stringify(e).includes(mac));
	expect(since).toEqual([]);
});

test("a scenario's own SSH server runs beside it on port 22", async () => {
	const machine = named("on-lab");
	await machine.run("ssh-keygen -A >/dev/null 2>&1; mkdir -p /var/empty; /usr/sbin/sshd");
	expect(await machine.run("nc -w 2 127.0.0.1 22 </dev/null | head -1")).toContain("OpenSSH");
	expect((await cli.ssh("on-lab.unlab", "echo still here")).stdout).toBe("still here\n");
});

test("it is put back when someone ends it", async () => {
	await named("nogateway").run("kill $(cat /run/unlab-ssh/pid); sleep 0.5");
	expect((await cli.ssh("nogateway.unlab", "echo back")).stdout).toBe("back\n");
});

test("it takes the next port when a scenario has the first", async () => {
	const machine = named("taken");
	await machine.run("nc -lk -s 127.0.0.1 -p 47022 -e cat >/dev/null 2>&1 & sleep 0.5");
	expect((await cli.ssh("taken.unlab", "echo reached")).stdout).toBe("reached\n");
	expect(await machine.run("netstat -ltn 2>/dev/null")).toContain("127.0.0.1:47023");
});

test("a machine that is off, booting or failed is refused with a sentence", async () => {
	const machines = lab.machines.map((machine, i) => ({
		n: i + 1,
		name: machine.name,
		image: "alpine",
		state: "ready",
	}));
	const more = (["off", "booting", "failed"] as const).map((state, i) => ({
		n: 20 + i,
		name: `is-${state}`,
		image: "alpine",
		state,
	}));
	page.machines([...machines, ...more]);
	expect((await cli.ssh("is-off.unlab", "true")).stderr).toContain("is-off is off. Boot it with: boot is-off");
	expect((await cli.ssh("is-booting.unlab", "true")).stderr).toContain("is-booting is still booting.");
	expect((await cli.ssh("is-failed.unlab", "true")).stderr).toContain("is-failed did not boot.");
	expect((await cli.ssh("nobody.unlab", "true")).stderr).toContain("No machine called nobody. You have on-alpine,");
	page.machines(machines);
});

test("forward leads to a port in a machine, and says what is taken", async () => {
	const port = await freePort();
	expect(await cli.once("forward", "on-lab", `${port}:80`)).toMatchObject({
		code: 0,
		stdout: `localhost:${port} leads to on-lab:80\n`,
	});
	const answer = await fetch(`http://127.0.0.1:${port}/`);
	expect(await answer.text()).toBe("hello from nginx\n");
	expect((await cli.once("forward")).stdout).toContain(`localhost:${port} leads to on-lab:80`);
	const taken = await cli.once("forward", "on-alpine", `${cli.port}:80`);
	expect(taken).toMatchObject({ code: 1, stderr: `Port ${cli.port} is taken on this computer. Choose another.\n` });
	expect(await cli.once("forward", "--rm", String(port))).toMatchObject({ code: 0 });
	await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});
