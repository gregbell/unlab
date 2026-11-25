import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

const databases = (page: Page) =>
	page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name ?? "").sort());

/** The databases of a machine's root disk and its extra ones. */
const kept = (n: number, extras = 0) => [
	`kwdisk:unlab-node${n}-v1`,
	...Array.from({ length: extras }, (_, i) => `kwdisk:unlab-node${n}.extra${i + 1}-v1`),
];

const KIB = 1024;
const sizes = async (page: Page, machine: number) =>
	Object.fromEntries(
		(await root(page, machine, "cat /proc/partitions"))
			.split("\n")
			.slice(2)
			.map((line) => line.trim().split(/\s+/))
			.map(([, , blocks, name]) => [name, Number(blocks)]),
	);

test("extra disks are blank and sized as asked, take a partition and a file system, and keep them", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --extra-disk 1,2");
	await ready(page, "1 of 1 machine ready");

	expect(await sizes(page, 1)).toMatchObject({ wdb: 4 * KIB * KIB, wdc: KIB * KIB, wdd: 2 * KIB * KIB });
	expect(await sizes(page, 1)).not.toHaveProperty("wde");
	expect(await root(page, 1, 'tr -d "\\000" < /dev/wdc | wc -c')).toBe("0");

	const details = page.locator("unlab-machine-details");
	for (const [device, size] of Object.entries({ wdb: 4, wdc: 1, wdd: 2 })) {
		await expect(details.locator(".fact", { hasText: `/dev/${device}` })).toContainText(`${size} GiB`);
	}
	await typed(page, "ls");
	await expect(page.locator("unlab-command-bar")).toContainText("/dev/wdb 4 GiB, /dev/wdc 1 GiB, /dev/wdd 2 GiB");
	await page.keyboard.press("Escape");
	expect(await call(page, "machines_list", {})).toMatchObject({
		data: [
			{
				disks: [
					{ device: "/dev/wdb", gib: 4 },
					{ device: "/dev/wdc", gib: 1 },
					{ device: "/dev/wdd", gib: 2 },
				],
			},
		],
	});

	await root(page, 1, 'printf "n\\np\\n1\\n\\n+256M\\nw\\n" | fdisk /dev/wdc');
	expect(await sizes(page, 1)).toMatchObject({ wdc1: 256 * KIB });
	await root(page, 1, "apk add --quiet e2fsprogs");
	await root(page, 1, "mkfs.ext4 -q /dev/wdc1 && mount /dev/wdc1 /mnt && echo filed > /mnt/note && sync");
	// No flush follows a raw write that nothing syncs. The second it takes to be saved is all it is given.
	await root(page, 1, "printf raw | dd of=/dev/wdd bs=1M seek=100 conv=notrunc");
	await page.waitForTimeout(4000);

	const held = async () => {
		expect(await sizes(page, 1)).toMatchObject({ wdc: KIB * KIB, wdc1: 256 * KIB, wdd: 2 * KIB * KIB });
		expect(await root(page, 1, "mount /dev/wdc1 /mnt && cat /mnt/note && df -Pm /mnt | tail -1")).toMatch(
			/filed\n\/dev\/wdc1 +2\d\d /,
		);
		expect(await root(page, 1, "dd if=/dev/wdd bs=1M skip=100 count=1 2>/dev/null | head -c 3")).toBe("raw");
	};
	await page.reload();
	await ready(page, "1 of 1 machine ready");
	await held();

	await shell(page, 1, "sudo poweroff -f").catch(() => {});
	await expect(details).toContainText("failed", { timeout: 60_000 });
	await typed(page, "boot node1");
	await ready(page, "1 of 1 machine ready");
	await held();
});

test("rm lists every disk it deletes, once, and what a reload cut short is deleted after it", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --no-net --extra-disk 1,16");
	await typed(page, "spawn 1 alpine --no-net --extra-disk 64");
	await typed(page, "spawn 1 alpine --no-net");
	await ready(page, "3 of 3 machines ready");
	expect(await databases(page)).toEqual([...kept(1, 2), ...kept(2, 1), ...kept(3)].sort());

	await typed(page, "rm node1");
	const bar = page.locator("unlab-command-bar");
	await expect(bar).toContainText(
		"everything on its 3 disks is gone: /dev/wdb 4 GiB, /dev/wdc 1 GiB, /dev/wdd 16 GiB. There is no undo.",
	);
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
	await expect.poll(() => databases(page)).toEqual([...kept(2, 1), ...kept(3)].sort());

	await page.evaluate(() => {
		IDBFactory.prototype.deleteDatabase = () => ({}) as IDBOpenDBRequest;
		// Saved under a number this lab has not given out, and by something that is not a machine.
		for (const name of ["kwdisk:unlab-node9.extra2-v1", "kwdisk:unlab-notes"]) indexedDB.open(name);
	});
	await typed(page, "rm node2");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-pane[machine=node2]")).toHaveCount(0);
	expect(await databases(page)).toEqual(expect.arrayContaining(kept(2, 1)));
	await page.reload();
	await ready(page, "1 of 1 machine ready");
	const left = [...kept(3), "kwdisk:unlab-node9.extra2-v1", "kwdisk:unlab-notes"].sort();
	await expect.poll(() => databases(page)).toEqual(left);
	expect(await sizes(page, 3)).toHaveProperty("wdb", 4 * KIB * KIB);

	await page.evaluate(() => localStorage.clear());
	await page.reload();
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	expect(await databases(page), "a lost record is no reason to delete disks").toEqual(left);
});

test("a machine the browser has no memory for fails naming memory and the size, and one past the limit is refused", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --mem 4097");
	await expect(page.locator("unlab-command-bar")).toContainText("A machine has at most 4096 MiB of memory.");
	await page.keyboard.press("Escape");

	const refused = await page.evaluate(() => {
		const taken: WebAssembly.Memory[] = [];
		(window as unknown as { taken: unknown }).taken = taken;
		try {
			for (;;) taken.push(new WebAssembly.Memory({ initial: 1, maximum: 65536 }));
		} catch (error) {
			return String(error);
		}
	});
	expect(refused).toContain("could not allocate memory");
	const reason =
		"The browser could not give node1 512 MiB of memory. Remove a machine or close other tabs, then boot it again.";
	await typed(page, "spawn 1 alpine --no-net --mem 512");
	await expect(page.locator("unlab-machine-details")).toContainText(reason);
	expect(await call(page, "machines_list", {})).toMatchObject({ data: [{ state: "failed", reason }] });
});

/** The browser's quota for the lab, set before it first writes: Chromium remembers what was left for 30 s. */
async function limitStorage(page: Page, quotaSize?: number): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Storage.overrideQuotaForOrigin", {
		origin: new URL(page.url()).origin,
		...(quotaSize === undefined ? {} : { quotaSize }),
	});
}

/** The sentence a person sees in the details and an agent reads in the list. */
async function outOfStorage(page: Page, machine: string, device: string): Promise<void> {
	const reason = `Browser storage is full, so ${machine}'s disk ${device} could not be saved. Remove a machine or free some space, then boot it again.`;
	await expect(page.locator("unlab-machine-details")).toContainText(reason);
	const { data } = (await call(page, "machines_list", {})) as { data: { name: string }[] };
	expect(data.find(({ name }) => name === machine)).toMatchObject({ state: "failed", reason });
}

for (const [device, file] of [
	["/dev/wdb", "/root/file"],
	["/dev/wdc", "/dev/wdc"],
] as const) {
	test(`writing more to ${device} than the browser can store fails the machine, naming storage and the disk`, async ({
		page,
	}) => {
		await openLab(page);
		await limitStorage(page, 8e6);
		await typed(page, "spawn 1 alpine --no-net --extra-disk 1");
		await ready(page, "1 of 1 machine ready");
		await shell(page, 1, `sudo sh -c "dd if=/dev/urandom of=${file} bs=1M count=32; sync"`).catch(() => {});
		await outOfStorage(page, "node1", device);

		await limitStorage(page);
		await typed(page, "boot node1");
		await ready(page, "1 of 1 machine ready");
	});
}

test("a machine the browser has no storage for fails naming storage and the disk", async ({ page }) => {
	await openLab(page);
	await limitStorage(page, 1000);
	await typed(page, "spawn 1 alpine --no-net");
	await outOfStorage(page, "node1", "/dev/wdb");
	await typed(page, "spawn 1 alpine --no-net --extra-disk 1");
	await expect(page.locator("unlab-pane[machine=node2]")).toBeVisible();
	await typed(page, "focus node2");
	await outOfStorage(page, "node2", "/dev/wdc");
});
