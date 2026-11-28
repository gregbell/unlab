import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import {
	configuration,
	inspector,
	openWithTwoMachines,
	portRow,
	rack,
	root,
	shell,
	status,
	switchDetails,
	typed,
} from "./lab.ts";
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
	await status(page, "3 of 3 ready", 60_000);
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
	if (shots) await page.screenshot({ path: `${shots}/capture-nics.png` });
	const macs = (await call(page, "switch_macs", { switches: "switch0" })) as {
		data: { macs: { mac: string; machine?: string; nic?: string }[] }[];
	};
	expect(macs.data[0].macs.find(({ mac }) => mac === "52:54:00:88:01:0d")).toMatchObject({
		machine: "node3",
		nic: "eth1",
	});

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

test("a cable per NIC: cut one by name, from the switch's details and by machine, and a reload keeps it", async ({
	page,
}) => {
	await openRouted(page);
	const ports = await switchDetails(page, "switch0");
	const word = (port: number) => portRow(ports, port).locator("td[data-state]");
	const details = await configuration(page, "node3");
	const nic = (n: number) => details.locator(".dt-link").nth(n);
	const reaches = async (address: string) => (await shell(page, 1, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

	await expect(nic(0)).toContainText(/switch0:3\s*up/);
	await expect(nic(1)).toContainText(/switch0:4\s*up/);
	if (shots) await page.screenshot({ path: `${shots}/lab-nics.png` });

	expect(await reaches("10.2.0.2")).toBe(true);
	await typed(page, "link down node3:eth1");
	await expect(word(4)).toHaveText("cut");
	await expect(word(3)).toHaveText("up");
	await expect(nic(1)).toContainText(/switch0:4\s*cut/);
	await expect(await inspector(page)).toContainText("Cable to node3:eth1 cut by you.");
	expect(await reaches("10.2.0.2")).toBe(false);
	expect(await reaches("10.88.0.13")).toBe(true);

	await typed(page, "ls");
	const listed = page.locator(".machine-result", { hasText: "node3" });
	await expect(listed).toContainText("eth0 · 10.88.0.13/24 · 52:54:00:88:00:0d · up on port 3");
	await expect(listed).toContainText("eth1 · no address · 52:54:00:88:01:0d · cut on port 4");
	if (shots) await page.screenshot({ path: `${shots}/ls-nics.png` });
	await page.keyboard.press("Escape");

	const reconnect = portRow(await switchDetails(page, "switch0"), 4).getByRole("button", { name: "Reconnect" });
	await expect(reconnect).toHaveAttribute("title", "Reconnect the cable from node3:eth1 to port 4");
	await reconnect.click();
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
	await status(page, "3 of 3 ready", 90_000);
	await expect(word(3)).toHaveText("up");
	await expect(word(4)).toHaveText("cut");
	expect(await root(page, 3, "cat /sys/class/net/eth1/address")).toBe("52:54:00:88:01:0d");
});

test("a NIC left unplugged takes no port, and a machine that needs more ports than are free is refused", async ({
	page,
}) => {
	await openWithTwoMachines(page);
	await typed(page, "spawn 1 alpine --nics 3 --net switch0,none,switch0");
	await status(page, "3 of 3 ready", 60_000);
	const details = await configuration(page, "node3");
	const nic = (n: number) => details.locator(".dt-link").nth(n);
	await expect(nic(0)).toContainText(/switch0:3\s*up/);
	await expect(nic(1)).toContainText("Unplugged");
	await expect(nic(2)).toContainText(/switch0:4\s*up/);
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
	await expect(rack(page).locator("[data-machine]")).toHaveCount(3);

	await nic(1).getByRole("button", { name: "Patch" }).click();
	const patch = page.getByRole("region", { name: "Patch cable", exact: true });
	await expect(patch.getByRole("combobox", { name: "Machine interface" })).toHaveValue("node3:eth1");
	await expect(patch.getByRole("combobox", { name: "Destination" })).toHaveValue("switch0:5");
	await patch.getByRole("button", { name: "Connect" }).click();
	await expect(nic(1)).toContainText(/switch0:5\s*up/);
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
	await status(page, "2 of 2 ready", 60_000);
	const ports = await switchDetails(page, "switch0");
	await expect(portRow(ports, 2).getByRole("button", { name: "Cut cable" })).toHaveAttribute(
		"title",
		"Cut the cable from node1 to port 2",
	);
	const reconnect = portRow(ports, 5).getByRole("button", { name: "Reconnect" });
	await expect(reconnect).toHaveAttribute("title", "Reconnect the cable from node2 to port 5");
	await reconnect.click();
	expect(await shell(page, 1, "ping -c 1 -W 2 node2")).toMatchObject({ exitCode: 0 });
	for (const n of [1, 2]) expect(await root(page, n, "ip -4 -o addr show eth0")).toContain(`10.88.0.1${n}/24`);
});
