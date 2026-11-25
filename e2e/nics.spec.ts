import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { openWithTwoMachines, root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

/** When set, the test also saves screenshots of a lab with a two-NIC machine there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

/** node3 has two NICs and forwards between node1's subnet and node2's. */
async function openRouted(page: Page): Promise<void> {
	await openWithTwoMachines(page);
	await typed(page, "spawn 1 alpine --nics 2");
	await expect(page.getByText("3 of 3 machines ready")).toBeVisible({ timeout: 60_000 });
	await root(page, 3, "ip addr add 10.2.0.1/24 dev eth1 && sysctl -w net.ipv4.ip_forward=1");
	await root(page, 1, "ip route add 10.2.0.0/24 via 10.88.0.13");
	await root(
		page,
		2,
		"ip addr del 10.88.0.12/24 dev eth0 && ip addr add 10.2.0.2/24 dev eth0 && ip route add 10.88.0.0/24 via 10.2.0.1",
	);
}

test("a two-NIC machine forwards in the browser, and the capture and its filter name each hop's NIC", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openRouted(page);

	expect(await root(page, 3, "ip -o link show eth1; ip -4 -o addr show eth1")).toMatch(
		/eth1: <BROADCAST,MULTICAST,UP,LOWER_UP>[\s\S]*52:54:00:88:01:0d[\s\S]*10\.2\.0\.1\/24/,
	);

	const ping = await shell(page, 1, "ping -c 2 -W 2 10.2.0.2");
	expect(ping.output).toContain("2 packets received");
	const hops = async (filter: string) => {
		const { rows } = (await call(page, "capture_read", { filter, limit: 100 })) as {
			rows: { from: { name: string; nic?: string }; to: { name: string; nic?: string }; info: string }[];
		};
		const name = (end: { name: string; nic?: string }) => (end.nic ? `${end.name}:${end.nic}` : end.name);
		return new Set(rows.map((row) => `${name(row.from)} > ${name(row.to)} ${row.info.split(" seq")[0]}`));
	};
	const entering = ["node1 > node3:eth0 echo request", "node3:eth0 > node1 echo reply"];
	const leaving = ["node3:eth1 > node2 echo request", "node2 > node3:eth1 echo reply"];
	expect(await hops("icmp")).toEqual(new Set([...entering, ...leaving]));
	expect(await hops("icmp node3")).toEqual(new Set([...entering, ...leaving]));
	expect(await hops("icmp node3:eth0")).toEqual(new Set(entering));
	expect(await hops("icmp node3:eth1")).toEqual(new Set(leaving));

	await typed(page, "capture icmp node3:eth1");
	const list = page.getByRole("listbox", { name: "Captured frames" });
	await expect(list.getByRole("option").first()).toContainText("node3:eth1");
	await expect(list).not.toContainText("node3:eth0");
	await list.focus();
	await page.keyboard.press("ArrowUp");
	await expect(page.locator("unlab-frame-detail")).toContainText("node3:eth1");
	await expect(page.locator("unlab-mac-table tr", { hasText: "52:54:00:88:01:0d" })).toContainText("node3:eth1");
	if (shots) await page.screenshot({ path: `${shots}/wire-nics.png` });
	await page.keyboard.press("Escape");

	// The same bytes arrive, in each direction, through the browser's workers and vsock.
	const transfer = async (from: number, to: number, address: string, port: number) => {
		const sent = await root(page, from, "head -c 8000000 /dev/urandom > /tmp/sent && md5sum < /tmp/sent");
		await root(page, from, `nc -l -p ${port} < /tmp/sent > /dev/null 2>&1 & sleep 1`);
		const got = await root(page, to, `timeout 60 nc ${address} ${port} < /dev/null | md5sum`);
		expect(got.trim()).toBe(sent.trim());
	};
	await transfer(1, 2, "10.88.0.11", 9001);
	await transfer(2, 1, "10.2.0.2", 9002);
	const { rows } = (await call(page, "capture_read", { filter: "tcp node3:eth1", limit: 1000 })) as {
		rows: { len: number }[];
	};
	expect(Math.max(...rows.map((row) => row.len))).toBe(1514);
	expect(errors).toEqual([]);
});

test("a cable per NIC: cut one by name, from the faceplate and by machine, and a reload keeps it", async ({ page }) => {
	await openRouted(page);
	const rail = page.getByRole("complementary", { name: "Machines" });
	const faceplate = page.locator("unlab-switch[compact]");
	const word = (port: number) => faceplate.locator(`[data-port="${port}"] .word`);
	const details = page.locator("unlab-machine-details");
	const reaches = async (address: string) => (await shell(page, 1, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

	await rail.getByRole("button", { name: /^node3\b/ }).click();
	await expect(details).toContainText("connected on port 3");
	await expect(details).toContainText("52:54:00:88:00:0d");
	await expect(details).toContainText("connected on port 4");
	await expect(details).toContainText("52:54:00:88:01:0d");
	if (shots) await page.screenshot({ path: `${shots}/lab-nics.png` });

	expect(await reaches("10.2.0.2")).toBe(true);
	await typed(page, "link down node3:eth1");
	await expect(word(4)).toHaveText("cut");
	await expect(word(3)).toHaveText("up");
	await expect(details).toContainText("cable cut on port 4");
	await expect(page.locator("unlab-capture[mode=dock]").getByText("Cable to node3:eth1 cut by you.")).toBeVisible();
	expect(await reaches("10.2.0.2")).toBe(false);
	expect(await reaches("10.88.0.13")).toBe(true);

	await typed(page, "ls");
	const listed = page.locator(".machine-result", { hasText: "node3" });
	await expect(listed).toContainText("eth0 · 10.88.0.13/24 · 52:54:00:88:00:0d · up on port 3");
	await expect(listed).toContainText("eth1 · no address · 52:54:00:88:01:0d · cut on port 4");
	if (shots) await page.screenshot({ path: `${shots}/ls-nics.png` });
	await page.keyboard.press("Escape");

	await faceplate.getByRole("button", { name: "Reconnect the cable from node3:eth1 to port 4" }).click();
	await expect(word(4)).toHaveText("up");
	expect(await reaches("10.2.0.2")).toBe(true);

	await typed(page, "link down node3");
	await expect(word(3)).toHaveText("cut");
	await expect(word(4)).toHaveText("cut");
	await typed(page, "link up node3:eth0");
	await expect(word(3)).toHaveText("up");
	await typed(page, "link down node2");
	await expect(word(2)).toHaveText("cut");
	expect(await reaches("10.88.0.13")).toBe(true);

	await page.reload();
	await expect(page.getByText("3 of 3 machines ready")).toBeVisible({ timeout: 90_000 });
	await expect(word(3)).toHaveText("up");
	await expect(word(4)).toHaveText("cut");
	expect(await root(page, 3, "cat /sys/class/net/eth1/address")).toBe("52:54:00:88:01:0d");
});

test("a NIC left unplugged takes no port, and a machine that needs more ports than are free is refused", async ({
	page,
}) => {
	await openWithTwoMachines(page);
	await typed(page, "spawn 1 alpine --nics 3 --net switch0,none,switch0");
	await expect(page.getByText("3 of 3 machines ready")).toBeVisible({ timeout: 60_000 });
	await page
		.getByRole("complementary", { name: "Machines" })
		.getByRole("button", { name: /^node3\b/ })
		.click();
	const details = page.locator("unlab-machine-details");
	await expect(details.locator(".fact", { hasText: "eth0" })).toContainText("connected on port 3");
	await expect(details.locator(".fact", { hasText: "eth1" })).toContainText("unplugged");
	await expect(details.locator(".fact", { hasText: "eth2" })).toContainText("connected on port 4");
	expect(await root(page, 3, "cat /sys/class/net/eth1/address /sys/class/net/eth2/address")).toBe(
		"52:54:00:88:01:0d\n52:54:00:88:02:0d",
	);

	await page.keyboard.press("Control+/");
	await page.keyboard.type("spawn 2 alpine --nics 3");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-command-bar")).toContainText(
		"switch0 has 4 free ports and this takes 6, so add --no-net",
	);
	await page.keyboard.press("Escape");
	await expect(page.locator("unlab-pane")).toHaveCount(3);

	await details.getByRole("button", { name: "plug in eth1" }).click();
	await expect(details.locator(".fact", { hasText: "eth1" })).toContainText("connected on port 5");
});

test("a lab saved before machines had several NICs boots on the ports it had", async ({ page }) => {
	await page.addInitScript(() => {
		if (localStorage.getItem("unlab.workspace.v1")) return;
		const node = (n: number, port: number, cut: boolean) => ({
			...{ n, hue: n, image: "alpine", memMiB: 256, diskGiB: "4", cpus: 1 },
			...{ net: "switch0", port, cut },
		});
		const saved = { version: 1, nextN: 3, nodes: [node(1, 2, false), node(2, 5, true)], dock: "open" };
		localStorage.setItem("unlab.workspace.v1", JSON.stringify({ ...saved, order: ["node1", "node2"], parked: [] }));
	});
	await page.goto("/");
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible({ timeout: 60_000 });
	const faceplate = page.locator("unlab-switch[compact]");
	await expect(faceplate.getByRole("button", { name: "Cut the cable from node1 to port 2" })).toBeVisible();
	await faceplate.getByRole("button", { name: "Reconnect the cable from node2 to port 5" }).click();
	expect(await shell(page, 1, "ping -c 1 -W 2 node2")).toMatchObject({ exitCode: 0 });
	for (const n of [1, 2]) expect(await root(page, n, "ip -4 -o addr show eth0")).toContain(`10.88.0.1${n}/24`);
});
