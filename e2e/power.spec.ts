import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { crash, root, shell, typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

/** When set, the tests also save screenshots of machines that are off there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const status = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

const rail = (page: Page, name: string) =>
	page.getByRole("complementary", { name: "Machines" }).getByRole("button", { name: new RegExp(`^${name}\\b`) });

const panel = (page: Page, name: string) => page.locator(`#panel-${name}-console`);

const details = (page: Page) => page.locator("unlab-machine-details");

/** The machine's worker, which holds its memory. */
const workers = (page: Page) => page.workers().filter((worker) => worker.url().includes("vm-worker")).length;

/** Keys on the machine's console, as a person types them. */
async function keys(page: Page, name: string, line: string): Promise<void> {
	await panel(page, name).click();
	await page.keyboard.type(`${line}\n`);
}

interface Listed {
	readonly name: string;
	readonly state: string;
	readonly nics: readonly { readonly port: number | null; readonly link: string | null }[];
}

const listed = async (page: Page) => ((await call(page, "machines_list", {})) as { data: Listed[] }).data;

const consoleText = async (page: Page, name: string) =>
	((await call(page, "shell_read", { machine: `${name}:console`, lines: 500 })) as { text: string }).text;

const announced = (page: Page) =>
	page.evaluate(() => {
		const heard: string[] = [];
		const region = document.querySelector("#unlab-announcer");
		if (!region) throw new Error("no announcer");
		new MutationObserver(() => {
			if (region.textContent) heard.push(region.textContent);
		}).observe(region, { childList: true, characterData: true, subtree: true });
		Object.assign(window, { heard });
	});
const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: string[] }).heard.join("\n"));

for (const image of ["alpine", "debian"]) {
	test(`reboot brings ${image} back as it was, with its files and without what only its memory held`, async ({
		page,
	}) => {
		await openLab(page);
		await typed(page, "spawn 1 alpine");
		await typed(page, `spawn 1 ${image} --name box --mem 512 --nics 2 --addr 10.88.0.50/24,10.2.0.1/24 --extra-disk 1`);
		await status(page, "2 of 2 ready");
		await typed(page, "link down box:eth1");
		const before = await listed(page);
		const memory = await root(page, "box", "grep MemTotal /proc/meminfo");

		await root(
			page,
			"box",
			"ip addr add 10.9.9.9/24 dev eth0; sysctl -w net.ipv4.ip_forward=1; sleep 4321 & pidof sleep",
		);
		await root(page, "box", "echo synced > /root/synced; sync");
		await typed(page, "sh box");
		await expect(page.locator("#tab-box-sh1")).toBeVisible();
		await announced(page);
		// What a program writes when it is told to end is written while the machine shuts down.
		await page.locator("#tab-box-console").click();
		await root(
			page,
			"box",
			'(trap "echo late > /root/late; printf raw | dd of=/dev/wdc bs=1M seek=100 conv=notrunc; exit" TERM; while :; do sleep 0.1; done) >/dev/null 2>&1 &',
		);
		await typed(page, "reboot box");
		await expect(rail(page, "box")).toContainText("rebooting");
		await expect(rail(page, "box")).toContainText("booting");
		await status(page, "2 of 2 ready");

		expect(await listed(page)).toEqual(before);
		expect(await root(page, "box", "grep MemTotal /proc/meminfo")).toBe(memory);
		await expect(page.locator("#tab-box-sh1")).toHaveCount(0);
		expect(await heard(page)).toContain("box rebooting. sh1 closed with it.");
		const text = await consoleText(page, "box");
		expect(text).toContain("box is rebooting. sh1 closed with it.");
		expect(text.indexOf("echo synced"), "the last boot is above the new one").toBeLessThan(
			text.indexOf("box is rebooting."),
		);
		expect(text.split("Welcome to").length, "one greeting for each boot").toBe(3);

		expect(await root(page, "box", "cat /root/synced /root/late")).toBe("synced\nlate");
		expect(await root(page, "box", "dd if=/dev/wdc bs=1M skip=100 count=1 2>/dev/null | head -c 3")).toBe("raw");
		expect(await root(page, "box", "cat /proc/sys/net/ipv4/ip_forward")).toBe("0");
		const addresses = await root(page, "box", "ip -4 -o addr show");
		expect(addresses).toMatch(/eth0 +inet 10\.88\.0\.50\/24/);
		expect(addresses).toMatch(/eth1 +inet 10\.2\.0\.1\/24/);
		expect(addresses).not.toContain("10.9.9.9");
		expect(await root(page, "box", "pidof sleep || echo none")).toBe("none");
		expect(await shell(page, 1, "ping -c 1 -W 2 box")).toMatchObject({ exitCode: 0 });
		await keys(page, "box", "echo typed-$((6*7))");
		await expect(panel(page, "box")).toContainText("typed-42");
	});

	test(`reboot and poweroff typed in ${image} do what the commands do`, async ({ page }) => {
		await openLab(page);
		await typed(page, `spawn 1 ${image} --extra-disk 1`);
		await status(page, "1 of 1 ready");
		const before = await listed(page);
		await announced(page);

		await typed(page, "sh node1");
		await expect(page.locator("#panel-node1-sh1")).toContainText("⇒");
		await page.locator("#panel-node1-sh1").click();
		await page.keyboard.type("echo kept > ~/kept; reboot\n");
		await expect(page.locator("#tab-node1-sh1")).toHaveCount(0);
		await expect.poll(() => consoleText(page, "node1")).toContain("node1 is rebooting. sh1 closed with it.");
		await status(page, "1 of 1 ready");
		expect(await heard(page)).toContain("node1 rebooting. sh1 closed with it.");
		expect(await listed(page)).toEqual(before);
		expect(await shell(page, 1, "cat ~/kept; uptime -p 2>/dev/null; cut -d. -f1 /proc/uptime")).toMatchObject({
			exitCode: 0,
		});

		await keys(page, "node1", "poweroff");
		await status(page, "0 of 1 ready, 1 off");
		expect(await listed(page)).toMatchObject([{ name: "node1", state: "off", nics: [{ port: 1, link: "off" }] }]);
		await expect(page.locator("unlab-pane[machine=node1]")).toContainText("node1 is off.");
		await expect.poll(() => workers(page)).toBe(0);
		await page.locator("unlab-pane[machine=node1]").getByRole("button", { name: "Boot" }).click();
		await status(page, "1 of 1 ready");
		expect(await shell(page, 1, "cat ~/kept")).toMatchObject({ output: "kept" });

		await keys(page, "node1", "sudo halt");
		await status(page, "0 of 1 ready, 1 off");
		expect(await heard(page)).not.toContain("failed");
	});
}

test("a machine that is off holds no memory, keeps its ports, name and disks, and stays off across a reload", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 2 alpine --extra-disk 1");
	await status(page, "2 of 2 ready");
	await typed(page, "link down node2");
	await root(page, 2, "echo filed > /root/note; printf raw | dd of=/dev/wdc bs=1M seek=9 conv=notrunc 2>/dev/null");
	expect(workers(page)).toBe(2);

	await typed(page, "poweroff node2");
	await status(page, "1 of 2 ready, 1 off");
	await expect.poll(() => workers(page)).toBe(1);
	expect(await shell(page, 1, "ping -c 1 -W 1 node2")).toMatchObject({ exitCode: 1 });
	const off = async () => {
		expect(await listed(page)).toMatchObject([
			{ name: "node1", state: "ready" },
			{ name: "node2", state: "off", nics: [{ port: 2, link: "cut" }] },
		]);
		await expect(rail(page, "node2")).toContainText("off");
		await expect(page.locator(".port[data-port='2']")).toContainText("cut");
		await typed(page, "exec node2 -- ls");
		await expect(page.locator("unlab-command-bar")).toContainText("node2 is off.");
		await page.keyboard.press("Escape");
	};
	await off();
	if (shots) await page.screenshot({ path: `${shots}/off.png` });
	await typed(page, "ls");
	await expect(page.locator("unlab-command-bar")).toContainText("2 machines · 1 ready, 1 off");
	await page.keyboard.press("Escape");

	await page.reload();
	await status(page, "1 of 2 ready, 1 off");
	expect(workers(page)).toBe(1);
	await off();

	// A person can plug and unplug a machine that is off. Its link comes up when it boots.
	expect(await call(page, "link_set", { link: "up", machines: "node2" })).toMatchObject({
		data: [{ machine: "node2", port: 2, link: "off" }],
	});
	await expect(page.locator(".port[data-port='2']")).toContainText("off");
	await typed(page, "spawn 1 alpine");
	await typed(page, "boot node2");
	await status(page, "3 of 3 ready");
	expect(await listed(page)).toMatchObject([
		{ name: "node1" },
		{ name: "node2", nics: [{ port: 2, link: "up" }] },
		{ name: "node3", nics: [{ port: 3, link: "up" }] },
	]);
	expect(await shell(page, 1, "ping -c 1 -W 2 node2")).toMatchObject({ exitCode: 0 });
	expect(await root(page, 2, "cat /root/note; dd if=/dev/wdc bs=1M skip=9 count=1 2>/dev/null | head -c 3")).toBe(
		"filed\nraw",
	);
});

test("what a disk had taken is kept by a guest that powers off or reboots without shutting down", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --no-net --extra-disk 1,1");
	await status(page, "1 of 1 ready");
	for (const [round, command] of ["poweroff -nf", "reboot -nf"].entries()) {
		const at = 100 + round;
		const raw = (device: string) =>
			`printf raw${round} | dd of=/dev/${device} bs=1M seek=${at} conv=notrunc,fsync 2>/dev/null`;
		// The writes reach the disks, and the kernel ends well inside the second it takes to save them by itself.
		await keys(
			page,
			"node1",
			`sudo sh -c "${raw("wdd")}; printf last${round} | dd of=/dev/wdc bs=4096 seek=${at} conv=notrunc oflag=direct 2>/dev/null; ${command}"`,
		);
		if (round === 0) {
			await status(page, "0 of 1 ready, 1 off");
			await typed(page, "boot node1");
		} else {
			await expect(rail(page, "node1")).toContainText("booting");
		}
		await status(page, "1 of 1 ready");
		expect(await root(page, 1, `dd if=/dev/wdd bs=1M skip=${at} count=1 2>/dev/null | head -c 4`)).toBe(`raw${round}`);
		expect(await root(page, 1, `dd if=/dev/wdc bs=4096 skip=${at} count=1 2>/dev/null | head -c 5`)).toBe(
			`last${round}`,
		);
	}
});

test("an agent's power calls return once the machine is where it was going, and stop waiting when told", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 2 alpine");
	await status(page, "2 of 2 ready");
	await root(page, 1, "echo kept > /root/kept");

	expect(await call(page, "machines_reboot", { names: "all" })).toMatchObject({
		result: "node1 ready, node2 ready",
		data: [
			{ name: "node1", state: "ready" },
			{ name: "node2", state: "ready" },
		],
	});
	expect(await root(page, 1, "cat /root/kept; cut -d. -f1 /proc/uptime")).toMatch(/^kept\n\d$/);

	expect(await call(page, "machines_poweroff", { names: "node1" })).toMatchObject({
		result: "node1 off",
		data: [{ name: "node1", state: "off" }],
	});
	expect(await call(page, "shell_exec", { targets: "node1", command: "true" })).toEqual({
		error: "exec wants a ready machine here, and node1 is off. Nothing was changed.",
	});
	expect(await call(page, "machines_poweroff", { names: "node1" })).toEqual({
		error: "poweroff wants a ready machine here, and node1 is off. Nothing was changed.",
	});
	expect(await call(page, "machines_boot", { names: "all" })).toMatchObject({
		result: "node1 ready · skipped node2: ready",
	});
	expect(await root(page, 1, "cat /root/kept")).toBe("kept");

	await start(page, "reboot", "machines_reboot", { names: "node1" });
	await expect(rail(page, "node1")).toContainText("booting");
	expect(await call(page, "shell_exec", { targets: "node1", command: "true" })).toEqual({
		error: expect.stringMatching(/^exec wants a ready machine here, and node1 is (stopping|still booting)\./),
	});
	await page.evaluate(() => window.running?.get("reboot")?.controller.abort());
	await expect(finish(page, "reboot")).rejects.toThrow(/abort/i);
	await status(page, "2 of 2 ready");
});

test("a guest that does not shut down is stopped, says so, and keeps what its disks have", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --no-net --extra-disk 1");
	await status(page, "1 of 1 ready");
	await root(
		page,
		1,
		'printf "#!/bin/sh\\n" > /usr/local/sbin/poweroff; cp /usr/local/sbin/poweroff /usr/local/sbin/reboot',
	);
	await root(page, 1, "echo late > /root/late; printf raw | dd of=/dev/wdc bs=1M seek=7 conv=notrunc 2>/dev/null");
	await announced(page);
	const said = "It did not shut down in 10 s, so it was stopped, and what it had not written to disk may be lost.";
	const asked = Date.now();
	expect(await call(page, "machines_poweroff", { names: "node1" })).toEqual({
		result: `node1 off: ${said}`,
		data: [{ name: "node1", state: "off", reason: said }],
	});
	expect(Date.now() - asked).toBeLessThan(20_000);
	expect(await heard(page)).toContain(`node1 off. ${said}`);
	await expect(details(page)).toContainText("off · did not shut down");
	expect(await consoleText(page, "node1")).toContain("node1 is off. It did not shut down in 10 s");
	await typed(page, "boot node1");
	await status(page, "1 of 1 ready");
	expect(await root(page, 1, "cat /root/late; dd if=/dev/wdc bs=1M skip=7 count=1 2>/dev/null | head -c 3")).toBe(
		"late\nraw",
	);

	// Removing one that will not shut down does not wait for it.
	await typed(page, "poweroff node1");
	await expect(rail(page, "node1")).toContainText("powering off");
	await typed(page, "rm node1");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0, { timeout: 3000 });
});

test("a reload while a machine stops ends as the stop would have, and an off machine can be removed", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 2 alpine --no-net");
	await status(page, "2 of 2 ready");
	for (const n of [1, 2]) {
		await root(
			page,
			n,
			'printf "#!/bin/sh\\n" > /usr/local/sbin/poweroff; cp /usr/local/sbin/poweroff /usr/local/sbin/reboot; sync',
		);
	}
	await typed(page, "poweroff node1");
	await typed(page, "reboot node2");
	await expect(rail(page, "node1")).toContainText("powering off");
	await expect(rail(page, "node2")).toContainText("rebooting");
	await page.reload();
	await status(page, "1 of 2 ready, 1 off");
	expect(await listed(page)).toMatchObject([
		{ name: "node1", state: "off" },
		{ name: "node2", state: "ready" },
	]);
	await typed(page, "rm node1");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name)))
		.toEqual(["kwdisk:unlab-node2-v1"]);
});

test("a kernel that crashes is a failed machine, and a full-screen program leaves the next boot's console usable", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --no-net");
	await status(page, "1 of 1 ready");
	await keys(page, "node1", "echo before-vi");
	await keys(page, "node1", "vi /tmp/x");
	await expect(panel(page, "node1")).toContainText("~");
	await typed(page, "reboot node1");
	await expect(rail(page, "node1")).toContainText("booting");
	await status(page, "1 of 1 ready");
	await expect.poll(() => consoleText(page, "node1")).toMatch(/before-vi[\s\S]*node1 is rebooting\.[\s\S]*Welcome to/);
	expect(await shell(page, 1, "echo again")).toMatchObject({ exitCode: 0, output: "again" });

	// Init runs a program that ends, and a kernel with no init panics.
	await crash(page, 1);
	await status(page, "0 of 1 ready, 1 failed");
	const [machine] = (await listed(page)) as unknown as { state: string; reason: string }[];
	expect(machine).toMatchObject({ state: "failed", reason: expect.stringContaining("Attempted to kill init") });
	expect(await call(page, "shell_exec", { targets: "node1", command: "true" })).toEqual({
		error: "exec wants a ready machine here, and node1 has failed. Nothing was changed.",
	});
	await typed(page, "boot node1");
	await status(page, "1 of 1 ready");
});

test("a NIC that is gone from a running guest is said, and one that went down with its guest is not", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --nics 2");
	await status(page, "1 of 1 ready");
	const warned: string[] = [];
	page.on("console", (message) => {
		if (/eth1/.test(message.text())) warned.push(message.text());
	});
	await announced(page);
	for (const command of ["reboot", "poweroff"]) {
		await keys(page, "node1", command);
		await expect(rail(page, "node1")).toContainText(command === "reboot" ? "booting" : "off");
		if (command === "poweroff") await status(page, "0 of 1 ready, 1 off");
		else await status(page, "1 of 1 ready");
	}
	await page.waitForTimeout(6000);
	expect(warned).toEqual([]);
	expect(await heard(page)).not.toContain("NIC");

	await typed(page, "boot node1");
	await status(page, "1 of 1 ready");
	await root(page, 1, "kill -9 $(pidof unlab-nic)");
	await expect.poll(() => heard(page)).toMatch(/node1 lost a NIC\. eth1 stopped: .*\. Reboot it to have it back\./);
	await expect(details(page)).toContainText("gone from the guest until it reboots");
	expect(await call(page, "machines_reboot", { names: "node1" })).toMatchObject({ result: "node1 ready" });
	await expect(details(page)).toContainText("connected on port 2");
});
