import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { openWithTwoMachines, root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

/** When set, the tests also save screenshots of named machines there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

const LONG = `long-${"x".repeat(56)}-1`;

const allReady = (page: Page, count: number) =>
	expect(page.getByText(`${count} of ${count} machines ready`)).toBeVisible({ timeout: 90_000 });

/** web-1 is alpine, db is debian, and the third chooses nothing. */
async function openNamed(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "spawn 1 alpine --name web-1");
	await expect(page.locator("unlab-pane")).toHaveCount(1);
	await typed(page, "spawn 1 debian --name db");
	await expect(page.locator("unlab-pane")).toHaveCount(2);
	await typed(page, "spawn 1 alpine");
	await allReady(page, 3);
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

/** The captured frames a filter keeps, as `web-1 > db echo request`, by their number. */
async function rows(page: Page, filter: string): Promise<Map<number, string>> {
	const { rows } = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows: Row[] };
	const name = (end: End) => (end.kind === "machine" ? (end.nic ? `${end.name}:${end.nic}` : end.name) : end.kind);
	return new Map(rows.map((row) => [row.seq, `${name(row.from)} > ${name(row.to)} ${row.info.split(" seq")[0]}`]));
}

/** The last line the machine's console shows. */
const prompt = async (page: Page, machine: string) =>
	((await call(page, "shell_read", { machine: `${machine}:console`, lines: 1 })) as { text: string }).text.trim();

const names = async (page: Page) =>
	((await call(page, "machines_list", {})) as { data: { name: string }[] }).data.map((m) => m.name);

test("a chosen name is the guest's, and the rail, the panes, ls, the prompt and the switch show it", async ({
	page,
}) => {
	await openNamed(page);
	const shown = async () => {
		const rail = page.getByRole("complementary", { name: "Machines" });
		for (const name of ["web-1", "db", "node3"]) {
			await expect(rail.getByRole("button", { name: new RegExp(`^${name}\\b`) })).toBeVisible();
			await expect(page.locator(`unlab-pane[machine=${name}] .header .name`)).toHaveText(name);
			expect(await shell(page, name, "hostname")).toMatchObject({ exitCode: 0, output: name });
		}
		await expect(page.getByRole("button", { name: "Cut the cable from web-1 to port 1" })).toBeVisible();
		await expect.poll(() => prompt(page, "web-1")).toBe("web-1 ~ ⇒");
		await expect.poll(() => prompt(page, "db")).toBe("db ~ ⇒");
		await expect.poll(() => prompt(page, "node3")).toBe("~ ⇒");
		await typed(page, "ls");
		const row = (name: string) => page.locator(".machine-result", { hasText: name });
		await expect(row("web-1")).toContainText("10.88.0.11/24 · 52:54:00:88:00:0b · up on port 1");
		await expect(row("db")).toContainText("10.88.0.12/24 · 52:54:00:88:00:0c · up on port 2");
		await page.keyboard.press("Escape");
		expect(await names(page)).toEqual(["web-1", "db", "node3"]);
	};
	await shown();
	if (shots) await page.screenshot({ path: `${shots}/names.png` });

	for (const from of ["web-1", "db", "node3"]) {
		for (const [to, address] of [
			["web-1", "10.88.0.11"],
			["db", "10.88.0.12"],
			["node3", "10.88.0.13"],
		]) {
			const ping = await shell(page, from, `ping -c 1 -W 2 ${to}`);
			expect(ping, `${from} to ${to}`).toMatchObject({ exitCode: 0 });
			expect(ping.output).toContain(address);
		}
	}

	await root(page, "db", "echo kept > /home/user/note; sync");
	await page.reload();
	await allReady(page, 3);
	await shown();
	expect((await shell(page, "db", "cat ~/note")).output).toBe("kept");
});

test("every command that takes a machine takes its name", async ({ page }) => {
	await openNamed(page);
	await typed(page, "sh web-1");
	await expect(page.locator("#panel-web-1-sh1")).toBeVisible();
	await expect(page.locator("#panel-web-1-sh1")).toContainText("web-1 ~ ⇒");
	await typed(page, "focus web-1:console");
	await expect(page.locator("#panel-web-1-console")).toBeVisible();
	await typed(page, "exec web-1:sh1,db -- echo said-$((40+2))-$(hostname)");
	await expect(page.locator(".machine-result", { hasText: "said-42-web-1" })).toContainText("exit 0");
	await expect(page.locator(".machine-result", { hasText: "said-42-db" })).toContainText("exit 0");
	await page.keyboard.press("Escape");
	expect(await call(page, "shell_read", { machine: "web-1:sh1", lines: 5 })).toMatchObject({
		session: "web-1:sh1",
		text: expect.stringContaining("said-42-web-1"),
	});

	await typed(page, "link down db");
	await expect(page.getByRole("button", { name: "Reconnect the cable from db to port 2" })).toBeVisible();
	expect((await shell(page, "web-1", "ping -c 1 -W 1 db")).exitCode).toBe(1);
	expect(await call(page, "link_set", { link: "up", machines: "db:eth0" })).toMatchObject({
		data: [{ machine: "db", nic: "eth0", link: "up" }],
	});
	expect((await shell(page, "web-1", "ping -c 1 -W 2 db")).exitCode).toBe(0);

	await typed(page, "capture icmp db or arp web-1:eth0");
	const list = page.getByRole("listbox", { name: "Captured frames" });
	await expect(list.getByRole("option", { name: /web-1 → db.*echo request/ }).first()).toBeVisible();
	await expect(list.getByRole("option", { name: /port 2 link down\. Cable to db cut by you\./ })).toBeVisible();
	await expect(list.getByRole("option", { name: /web-1 → everyone.*who has 10\.88\.0\.12\?/ }).first()).toBeVisible();
	await list
		.getByRole("option", { name: /db → web-1.*echo reply/ })
		.first()
		.click();
	await expect(page.locator("unlab-frame-detail .pair", { hasText: "destination" }).first()).toContainText(
		/52:54:00:88:00:0b\s+web-1/,
	);
	await expect(page.locator("unlab-mac-table tr", { hasText: "52:54:00:88:00:0c" })).toContainText("db");
	if (shots) await page.screenshot({ path: `${shots}/names-wire.png` });
	await page.keyboard.press("Control+/");
	await page.keyboard.type("capture dbx");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-command-bar")).toContainText("capture cannot read dbx.");
	await page.keyboard.press("Escape");
	await page.getByRole("link", { name: "← lab" }).click();
	await typed(page, "focus db --max");
	await expect(page.locator("unlab-pane:visible")).toHaveCount(1);
	await typed(page, "focus db --max");

	await shell(page, "web-1", "sudo poweroff -f").catch(() => {});
	const rail = page.getByRole("complementary", { name: "Machines" });
	await expect(rail.getByRole("button", { name: /^web-1\b/ })).toContainText("failed", { timeout: 60_000 });
	await typed(page, "boot web-1");
	await allReady(page, 3);
	expect((await shell(page, "web-1", "hostname")).output).toBe("web-1");

	await typed(page, "rm web*");
	await page.getByRole("button", { name: "Remove web-1" }).click();
	await expect(page.locator("unlab-pane[machine=web-1]")).toHaveCount(0);
	expect(await names(page)).toEqual(["db", "node3"]);
});

test("a name in use or that is not a hostname is refused in a sentence, and nothing boots", async ({ page }) => {
	await openWithTwoMachines(page);
	await typed(page, "spawn 1 alpine --name web");
	await allReady(page, 3);
	for (const [options, sentence] of [
		["1 alpine --name web", "A machine is already called web, so give another name with --name."],
		["1 alpine --name Web", "--name wants lowercase letters, so use web."],
		["1 alpine --name web_1", "such as web-1, not web_1."],
		["1 alpine --name -web", "such as web-1, not -web."],
		[`1 alpine --name ${"x".repeat(64)}`, "--name wants at most 63 characters, and that is 64."],
		["1 alpine --name node1", "The lab gives out node1 itself, so use another name, such as web-1."],
		["1 alpine --name arp", "arp already means something in the lab, so use another name, such as arp-1."],
		["2 alpine --name db", "--name names one machine, so spawn 1 at a time with it."],
	]) {
		await page.keyboard.press("Control+/");
		await page.keyboard.type(`spawn ${options}`);
		await page.keyboard.press("Enter");
		await expect(page.locator("unlab-command-bar")).toContainText(sentence);
		await page.keyboard.press("Escape");
	}
	await expect(page.locator("unlab-pane")).toHaveCount(3);
});

test("a name is free once its machine is gone, and the next machine of that name is another machine", async ({
	page,
}) => {
	await openNamed(page);
	expect((await shell(page, "web-1", "ping -c 1 -W 2 db")).exitCode).toBe(0);
	await root(page, "web-1", "echo old > /home/user/note; sync");
	await expect.poll(async () => [...(await rows(page, "icmp web-1")).values()]).toContain("web-1 > db echo request");
	const before = await rows(page, "icmp web-1");

	await typed(page, "rm web-1");
	await page.getByRole("button", { name: "Remove web-1" }).click();
	await expect(page.locator("unlab-pane[machine=web-1]")).toHaveCount(0);
	await typed(page, "spawn 1 debian --name web-1");
	await allReady(page, 3);
	expect(await names(page)).toEqual(["db", "node3", "web-1"]);
	expect(await call(page, "machines_list", {})).toMatchObject({
		data: [{}, {}, { name: "web-1", address: "10.88.0.14", nics: [{ mac: "52:54:00:88:00:0e" }] }],
	});
	expect((await shell(page, "web-1", "cat /etc/os-release")).output).toContain("Debian");
	expect((await shell(page, "web-1", "cat ~/note")).exitCode).toBe(1);
	await expect
		.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name).sort()))
		.toEqual(["kwdisk:unlab-node2-v1", "kwdisk:unlab-node3-v1", "kwdisk:unlab-node4-v1"]);
	expect((await shell(page, "db", "ping -c 1 -W 2 web-1")).output).toContain("10.88.0.14");

	const after = await rows(page, "icmp web-1");
	for (const [seq, row] of before) expect(after.get(seq)).toBe(row);
	expect([...after].filter(([seq]) => !before.has(seq)).map(([, row]) => row)).toEqual(
		expect.arrayContaining(["db > web-1 echo request", "web-1 > db echo reply"]),
	);
	expect([...(await rows(page, "icmp 52:54:00:88:00:0e")).keys()].filter((seq) => before.has(seq))).toEqual([]);
	await expect.poll(() => prompt(page, "web-1")).toBe("web-1 ~ ⇒");
});

test("a lab saved before machines had names keeps them and their disks", async ({ page }) => {
	await openWithTwoMachines(page);
	await root(page, 2, "echo mine > /home/user/note; sync");
	await page.evaluate(() => {
		const key = "unlab.workspace.v1";
		const saved = JSON.parse(localStorage.getItem(key) ?? "");
		saved.version = 3;
		for (const node of saved.nodes) delete node.name;
		const set = Storage.prototype.setItem;
		set.call(localStorage, key, JSON.stringify(saved));
		// The page saves again as it goes.
		Storage.prototype.setItem = () => {};
	});
	await page.reload();
	await allReady(page, 2);
	expect(await names(page)).toEqual(["node1", "node2"]);
	expect((await shell(page, 2, "cat ~/note")).output).toBe("mine");
});

test("a name as long as a hostname can be fits everywhere it is shown", async ({ page }) => {
	await openWithTwoMachines(page);
	await typed(page, `spawn 1 alpine --name ${LONG}`);
	await allReady(page, 3);
	expect((await shell(page, LONG, "hostname")).output).toBe(LONG);
	expect((await shell(page, 1, `ping -c 1 -W 2 ${LONG}`)).exitCode).toBe(0);
	const overflow = (selector: string) =>
		page.locator(selector).evaluate((element) => element.scrollWidth - element.clientWidth);
	for (const part of ["unlab-rail", `unlab-pane[machine=${LONG}] .header`, "unlab-switch[compact] .header", "body"]) {
		expect(await overflow(part), part).toBe(0);
	}
	await expect(page.locator("unlab-switch[compact] [data-port='3']")).toHaveAttribute("title", LONG);
	await expect(page.locator(".route", { hasText: LONG }).first()).toHaveAttribute("title", /→/);
	if (shots) await page.screenshot({ path: `${shots}/long-name.png` });
	await typed(page, "capture icmp");
	await expect(page.getByRole("option", { name: new RegExp(LONG) }).first()).toBeVisible();
	if (shots) await page.screenshot({ path: `${shots}/long-name-wire.png` });
	await typed(page, "ls");
	if (shots) await page.screenshot({ path: `${shots}/long-name-ls.png` });
	await page.keyboard.press("Escape");
	await page.keyboard.press("Control+/");
	await page.keyboard.type("rm l");
	if (shots) await page.screenshot({ path: `${shots}/long-name-complete.png` });
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("button", { name: `Remove ${LONG}` })).toBeVisible();
	if (shots) await page.screenshot({ path: `${shots}/long-name-rm.png` });
});

test("a filter typed before its machine is there takes effect once it is", async ({ page }) => {
	await openWithTwoMachines(page);
	const filter = page.getByLabel("filter");
	await filter.fill("later");
	await expect(filter).toHaveAttribute("aria-invalid", "true");
	await typed(page, "spawn 1 alpine --name later");
	await allReady(page, 3);
	await expect(filter).toHaveAttribute("aria-invalid", "false");
	expect((await shell(page, 1, "ping -c 1 -W 2 node2; ping -c 1 -W 2 later")).exitCode).toBe(0);
	const list = page.locator("unlab-capture[mode=dock]").getByRole("listitem");
	await expect(list.filter({ hasText: "later" }).filter({ hasText: "echo reply" })).toHaveCount(1);
	await expect(list.filter({ hasText: "node2" })).toHaveCount(0);
});
