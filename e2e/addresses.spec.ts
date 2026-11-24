import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { openWithTwoMachines, root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

/** When set, the test also saves screenshots of a lab with chosen addresses there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

/** Every IPv4 address in the guest but loopback's, as `eth0 10.1.0.1/24`. */
async function held(page: Page, node: number): Promise<string[]> {
	const out = await root(page, node, "ip -4 -o addr show");
	return [...out.matchAll(/^\d+: (eth\d) +inet (\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
}

interface End {
	readonly kind: string;
	readonly name?: string;
	readonly nic?: string;
}
interface Row {
	readonly seq: number;
	readonly from: End;
	readonly to: End;
	readonly info: string;
}

/** The captured frames a filter keeps, as `node1:eth0 > node2 echo request`. */
async function rows(page: Page, filter: string): Promise<string[]> {
	const { rows } = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows: Row[] };
	const name = (end: End) => (end.kind === "machine" ? (end.nic ? `${end.name}:${end.nic}` : end.name) : end.kind);
	return rows.map((row) => `${name(row.from)} > ${name(row.to)} ${row.info.split(" seq")[0]}`);
}

async function seqs(page: Page, filter: string): Promise<number[]> {
	const { rows } = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows: Row[] };
	return rows.map((row) => row.seq);
}

/** node1 is on two subnets, node2 on the first of them and node3 on the second. node4 chooses nothing. */
async function openAddressed(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "spawn 1 alpine --nics 3 --addr 10.1.0.1/24,10.2.0.1/24,none");
	await expect(page.locator("unlab-pane")).toHaveCount(1);
	await typed(page, "spawn 1 alpine --addr 10.1.0.9/24");
	await expect(page.locator("unlab-pane")).toHaveCount(2);
	await typed(page, "spawn 1 alpine --addr 10.2.0.9/24 --no-gateway");
	await expect(page.locator("unlab-pane")).toHaveCount(3);
	await typed(page, "spawn 1 alpine");
	await expect(page.getByText("4 of 4 machines ready")).toBeVisible({ timeout: 60_000 });
}

const GATEWAY_LEASE = "eth0 10.0.2.15/24";
const NODE1 = [GATEWAY_LEASE, "eth0 10.1.0.1/24", "eth1 10.2.0.1/24"];

test("chosen addresses are on the NICs, in ls and in the details, and are applied again after every boot", async ({
	page,
}) => {
	await openAddressed(page);
	const setAsChosen = async () => {
		expect(await held(page, 1)).toEqual(NODE1);
		expect(await held(page, 2)).toEqual([GATEWAY_LEASE, "eth0 10.1.0.9/24"]);
		expect(await held(page, 3)).toEqual(["eth0 10.2.0.9/24"]);
		expect(await held(page, 4)).toEqual([GATEWAY_LEASE, "eth0 10.88.0.14/24"]);
	};
	await setAsChosen();
	expect(await root(page, 1, "ip -o link show eth2")).toContain("UP,LOWER_UP");

	const listed = async () => {
		await typed(page, "ls");
		const row = (name: string) => page.locator(".machine-result", { hasText: name });
		await expect(row("node1")).toContainText("eth0 · 10.1.0.1/24 · 52:54:00:88:00:0b · up on port 1");
		await expect(row("node1")).toContainText("eth1 · 10.2.0.1/24 · 52:54:00:88:01:0b · up on port 2");
		await expect(row("node1")).toContainText("eth2 · no address · 52:54:00:88:02:0b · up on port 3");
		await expect(row("node3")).toContainText("10.2.0.9/24 · 52:54:00:88:00:0d · up on port 5 · no package gateway");
		await expect(row("node4")).toContainText("10.88.0.14/24 ·");
		if (shots) await page.screenshot({ path: `${shots}/ls-addresses.png` });
		await page.keyboard.press("Escape");
	};
	await listed();

	const rail = page.getByRole("complementary", { name: "Machines" });
	await expect(rail.getByRole("button", { name: /^node3\b/ })).toContainText("10.2.0.9");
	await rail.getByRole("button", { name: /^node3\b/ }).click();
	const details = page.locator("unlab-machine-details");
	await expect(details.locator(".fact", { hasText: "address" })).toContainText("10.2.0.9/24");
	await expect(details.locator(".fact", { hasText: "gateway" })).toContainText("off");
	await expect(page.locator("unlab-switch[compact] .subnet")).toHaveText("L2 · 3 subnets");
	if (shots) await page.screenshot({ path: `${shots}/lab-addresses.png` });

	await root(page, 1, "ip addr flush dev eth0 && ip addr flush dev eth1 && ip addr add 10.7.7.7/24 dev eth1");
	await page.reload();
	await expect(page.getByText("4 of 4 machines ready")).toBeVisible({ timeout: 90_000 });
	await setAsChosen();
	await listed();

	await root(page, 1, "ip addr flush dev eth1");
	await shell(page, 1, "sudo poweroff -f").catch(() => {});
	await expect(rail.getByRole("button", { name: /^node1\b/ })).toContainText("failed", { timeout: 60_000 });
	await typed(page, "boot node1");
	await expect(page.getByText("4 of 4 machines ready")).toBeVisible({ timeout: 60_000 });
	expect(await held(page, 1)).toEqual(NODE1);
	expect(await shell(page, 3, "ping -c 1 -W 2 10.2.0.1")).toMatchObject({ exitCode: 0 });
});

test("the capture names the machine at each end in any subnet, and a reused address does not rename old rows", async ({
	page,
}) => {
	await openAddressed(page);
	expect(await shell(page, 2, "ping -c 1 -W 2 10.1.0.1")).toMatchObject({ exitCode: 0 });
	expect(await shell(page, 3, "ping -c 1 -W 2 10.2.0.1")).toMatchObject({ exitCode: 0 });

	const left = [
		"node2 > everyone who has 10.1.0.1? tell 10.1.0.9",
		"node1:eth0 > node2 10.1.0.1 is at 52:54:00:88:00:0b",
		"node2 > node1:eth0 echo request",
		"node1:eth0 > node2 echo reply",
	];
	const right = [
		"node3 > everyone who has 10.2.0.1? tell 10.2.0.9",
		"node1:eth1 > node3 10.2.0.1 is at 52:54:00:88:01:0b",
		"node3 > node1:eth1 echo request",
		"node1:eth1 > node3 echo reply",
	];
	const ipv4 = (await rows(page, "arp or icmp")).filter((row) => left.includes(row) || right.includes(row));
	expect(ipv4.slice(0, 4)).toEqual(left);
	const ofNode1 = new Set(await rows(page, "node1"));
	for (const row of [...left, ...right]) expect(ofNode1).toContain(row);
	// The two requests are broadcast, so only the address they ask for says they are about node1.
	expect(new Set(await rows(page, "arp 10.2.0.1"))).toContain(right[0]);
	const ofNode3 = new Set(await rows(page, "node3"));
	for (const row of right) expect(ofNode3).toContain(row);
	for (const row of left) expect(ofNode3).not.toContain(row);

	await typed(page, "capture arp node1");
	const list = page.getByRole("listbox", { name: "Captured frames" });
	await expect(list.getByRole("option", { name: /node3 → everyone/ }).first()).toBeVisible();
	await list
		.getByRole("option", { name: /node2 → everyone.*who has 10\.1\.0\.1\?/ })
		.first()
		.click();
	await expect(page.locator("unlab-frame-detail .pair", { hasText: "target ip" })).toContainText(/10\.1\.0\.1\s+node1/);
	if (shots) await page.screenshot({ path: `${shots}/wire-addresses.png` });
	await page.keyboard.press("Escape");

	const before = await seqs(page, "arp 10.1.0.9");
	expect(before.length).toBeGreaterThan(0);
	expect(await seqs(page, "arp node2")).toEqual(expect.arrayContaining(before));
	await typed(page, "rm node2");
	await page.getByRole("button", { name: "Remove node2" }).click();
	await expect(page.locator("unlab-pane[machine=node2]")).toHaveCount(0);
	await typed(page, "spawn 1 alpine --addr 10.1.0.9/24");
	await expect(page.locator("unlab-pane[machine=node5]")).toBeVisible();
	await expect(page.getByText("4 of 4 machines ready")).toBeVisible({ timeout: 60_000 });
	expect(await shell(page, 5, "ping -c 1 -W 2 10.1.0.1")).toMatchObject({ exitCode: 0 });

	expect(await seqs(page, "arp node2")).toEqual(expect.arrayContaining(before));
	const ofNode5 = await seqs(page, "arp node5");
	expect(ofNode5.length).toBeGreaterThan(0);
	expect(ofNode5.filter((seq) => before.includes(seq))).toEqual([]);
});

test("an address the machine could not use is refused in a sentence, and nothing boots", async ({ page }) => {
	await openWithTwoMachines(page);
	for (const [option, sentence] of [
		[
			"--addr 10.0.2.9/24",
			"--addr 10.0.2.9/24 overlaps 10.0.2.0/24, which the package gateway uses, so choose another subnet or add --no-gateway.",
		],
		["--addr 10.88.0.11/24", "10.88.0.11 is already node1's, so give another address with --addr."],
		["--addr 10.1.0.0/24", "--addr 10.1.0.0/24 names its whole subnet, so use one from 10.1.0.1 to 10.1.0.254."],
	]) {
		await page.keyboard.press("Control+/");
		await page.keyboard.type(`spawn 1 alpine ${option}`);
		await page.keyboard.press("Enter");
		await expect(page.locator("unlab-command-bar")).toContainText(sentence);
		await page.keyboard.press("Escape");
	}
	await expect(page.locator("unlab-pane")).toHaveCount(2);

	await typed(page, "spawn 1 alpine --addr 10.0.2.9/24 --no-gateway");
	await expect(page.getByText("3 of 3 machines ready")).toBeVisible({ timeout: 60_000 });
	expect(await held(page, 3)).toEqual(["eth0 10.0.2.9/24"]);
});

test("a machine left with no address says so, and the others' host tables have the first address of each that has one", async ({
	page,
}) => {
	await openAddressed(page);
	await typed(page, "spawn 1 alpine --addr none --no-gateway");
	await expect(page.getByText("5 of 5 machines ready")).toBeVisible({ timeout: 60_000 });
	expect(await held(page, 5)).toEqual([]);
	expect(await root(page, 5, "ip -o link show eth0")).toContain("UP,LOWER_UP");
	const rail = page.getByRole("complementary", { name: "Machines" });
	await expect(rail.getByRole("button", { name: /^node5\b/ })).toContainText("no address");
	await expect(page.locator("unlab-pane[machine=node5] .header")).toContainText("no address");

	const hosts = await root(page, 4, "cat /etc/hosts");
	const table = /# unlab: begin\n([\s\S]*)\n# unlab: end/.exec(hosts.replaceAll("\r", ""))?.[1].split("\n");
	expect(table).toEqual(["10.88.0.14 node4", "10.1.0.1 node1", "10.1.0.9 node2", "10.2.0.9 node3"]);
	expect(await shell(page, 1, "ping -c 1 -W 2 node3")).toMatchObject({ exitCode: 0 });
});
