import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, shell } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

/** An agent's spawn, with the person's yes. */
async function spawn(page: Page, input: Record<string, string | number>): Promise<void> {
	await start(page, "spawn", "machines_spawn", { count: 1, ...input });
	await page
		.locator("unlab-agent-panel")
		.getByRole("button", { name: /^Boot / })
		.click();
	expect(await finish(page, "spawn")).not.toHaveProperty("error");
}

interface Listed {
	readonly name: string;
	readonly state: string;
	readonly sessions: unknown;
}

async function list(page: Page): Promise<Listed[]> {
	return ((await call(page, "machines_list", {})) as { data: Listed[] }).data;
}

/** All that a machine comes back with, which is not its shells. */
const machines = async (page: Page) => (await list(page)).map(({ sessions: _, ...kept }) => kept);

/** Asks until each machine is as it should be, as an agent does after a spawn, which answers at once. */
const states = (page: Page, ...want: string[]) =>
	expect.poll(async () => (await list(page)).map(({ state }) => state), { timeout: 60_000 }).toEqual(want);

test("an agent builds a routed network with the page's addresses, and the router's second disk outlives a reboot", async ({
	page,
}) => {
	await openLab(page);
	await spawn(page, {
		image: "lab",
		name: "router",
		nics: 2,
		addr: "10.10.1.1/24,10.10.2.1/24",
		extraDisk: "1",
	});
	await spawn(page, { image: "lab", name: "web", addr: "10.10.1.10/24" });
	await spawn(page, { image: "alpine", name: "db", addr: "10.10.2.10/24" });
	await states(page, "ready", "ready", "ready");
	expect(await list(page)).toMatchObject([
		{
			name: "router",
			state: "ready",
			nics: [
				{ address: "10.10.1.1", prefix: 24, link: "up" },
				{ address: "10.10.2.1", prefix: 24, link: "up" },
			],
			disks: [{ device: "/dev/wdb" }, { device: "/dev/wdc", gib: 1 }],
		},
		{ name: "web", nics: [{ address: "10.10.1.10" }] },
		{ name: "db", nics: [{ address: "10.10.2.10" }] },
	]);

	const forward = () => root(page, "router", "sysctl -qw net.ipv4.ip_forward=1");
	const mount = () => root(page, "router", "mkdir -p /srv/data && mount /dev/wdc1 /srv/data");
	await root(page, "router", 'printf "label: gpt\\n,\\n" | sfdisk -q /dev/wdc && mkfs.ext4 -q /dev/wdc1');
	await mount();
	await root(page, "router", "echo from the page > /srv/data/note");
	await forward();
	await root(page, "web", "ip route replace 10.10.2.0/24 via 10.10.1.1");
	await root(page, "db", "ip route replace 10.10.1.0/24 via 10.10.2.1");

	const ping = () => shell(page, "web", "ping -c 2 -W 2 10.10.2.10");
	expect(await ping()).toMatchObject({ exitCode: 0 });
	await root(page, "router", "sysctl -qw net.ipv4.ip_forward=0");
	expect(await ping()).toMatchObject({ exitCode: 1 });

	expect(await call(page, "machines_reboot", { names: "router" })).toMatchObject({
		data: [{ name: "router", state: "ready" }],
	});
	await mount();
	expect(await root(page, "router", "cat /srv/data/note")).toContain("from the page");
	await forward();
	expect(await ping()).toMatchObject({ exitCode: 0 });
});

test("a reload brings each machine back with its disks, NICs, name, addresses, power, checkpoints and cables", async ({
	page,
}) => {
	await openLab(page);
	await spawn(page, {
		image: "lab",
		name: "gw",
		nics: 2,
		addr: "10.1.0.1/24,10.2.0.1/24",
		extraDisk: "1,2",
		mem: 384,
	});
	await spawn(page, { image: "alpine", name: "spare", addr: "10.1.0.9/24", extraDisk: "1" });
	await spawn(page, { image: "alpine" });
	await states(page, "ready", "ready", "ready");

	await root(page, "gw", "mkfs.ext4 -q /dev/wdc && mkfs.ext4 -q /dev/wdd && mount /dev/wdc /mnt");
	await root(page, "gw", "echo one > /mnt/note; echo root > /root/note");
	expect(await call(page, "checkpoint_save", { machine: "gw", checkpoint: "before" })).not.toHaveProperty("error");
	await root(page, "gw", "echo two > /mnt/note");
	expect(await call(page, "link_set", { link: "down", machines: "gw:eth1" })).not.toHaveProperty("error");
	expect(await call(page, "machines_poweroff", { names: "spare" })).not.toHaveProperty("error");
	await root(page, "gw", "sync");

	const before = await machines(page);
	expect(before).toMatchObject([
		{ name: "gw", state: "ready", checkpoints: [{ name: "before" }], nics: [{ link: "up" }, { link: "cut" }] },
		{ name: "spare", state: "off" },
		{ name: "node3", state: "ready", nics: [{ address: "10.88.0.13" }] },
	]);

	await page.reload();
	await states(page, "ready", "off", "ready");
	expect(await machines(page)).toEqual(before);
	expect(await root(page, "gw", "hostname; nproc; cat /sys/class/net/eth1/address; cat /root/note")).toMatch(
		/^gw\n\d+\n52:54:00:88:01:0b\nroot$/,
	);
	await root(page, "gw", "mount /dev/wdc /mnt");
	expect(await root(page, "gw", "cat /mnt/note")).toContain("two");
	expect(await root(page, "gw", "ip -br addr show eth1")).toContain("10.2.0.1/24");

	await start(page, "restore", "checkpoint_restore", { machine: "gw", checkpoint: "before" });
	await page.locator("unlab-agent-panel").getByRole("button", { name: "Restore gw to before", exact: true }).click();
	expect(await finish(page, "restore")).not.toHaveProperty("error");
	await root(page, "gw", "mount /dev/wdc /mnt");
	expect(await root(page, "gw", "cat /mnt/note")).toContain("one");
	expect(await call(page, "machines_boot", { names: "spare" })).not.toHaveProperty("error");
	expect(await list(page)).toMatchObject([{ state: "ready" }, { state: "ready" }, { state: "ready" }]);
});
