import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { crash, root, shell, typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const status = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

const details = (page: Page) => page.locator("unlab-machine-details");

/** What the details say of the machine's checkpoints. */
const row = (page: Page) => details(page).locator(".fact", { hasText: "checkpoints" });

const bar = (page: Page) => page.locator("unlab-command-bar");

const rail = (page: Page, name: string) =>
	page.getByRole("complementary", { name: "Machines" }).getByRole("button", { name: new RegExp(`^${name}\\b`) });

interface Listed {
	readonly name: string;
	readonly state: string;
	readonly reason?: string;
	readonly checkpoints: readonly { readonly name: string; readonly bytes: number }[];
}

const listed = async (page: Page) => ((await call(page, "machines_list", {})) as { data: Listed[] }).data;

const names = async (page: Page) => (await listed(page)).map(({ checkpoints }) => checkpoints.map(({ name }) => name));

const consoleText = async (page: Page, name: string) =>
	((await call(page, "shell_read", { machine: `${name}:console`, lines: 500 })) as { text: string }).text;

/** A person answering the question a dangerous line asks. */
async function confirmed(page: Page, line: string, asked: string): Promise<void> {
	await typed(page, line);
	await expect(bar(page)).toContainText(asked);
	await page.keyboard.press("Enter");
}

/** A restore that a person asks for and waits for. */
async function restored(page: Page, checkpoint: string, asked: string): Promise<void> {
	const said = `node1 is back at checkpoint ${checkpoint}.`;
	const times = async () => (await consoleText(page, "node1")).split(said).length;
	const before = await times();
	await confirmed(page, `restore node1 ${checkpoint}`, asked);
	await expect.poll(times, { timeout: 60_000 }).toBe(before + 1);
	await status(page, "1 of 1 machine ready");
}

const databases = (page: Page) =>
	page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name ?? "").sort());

/** The databases of a live set of a machine's disks. */
const kept = (n: number, set: number, extras = 0) => {
	const of = `kwdisk:unlab-node${n}${set === 0 ? "" : `.set${set}`}`;
	return [`${of}-v1`, ...Array.from({ length: extras }, (_, i) => `${of}.extra${i + 1}-v1`)];
};

/** The database of a checkpoint. */
const saved = (n: number, set: number) => `kwdisk:unlab-node${n}.set${set}.checkpoint`;

/** What the blocks of a checkpoint take, counted in the browser. */
const bytesIn = (page: Page, database: string) =>
	page.evaluate(async (database) => {
		const done = <T>(request: IDBRequest<T>) =>
			new Promise<T>((resolve, reject) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		const db = await done(indexedDB.open(database));
		const packs = await done(db.transaction("packs").objectStore("packs").getAll());
		db.close();
		return packs.reduce((sum, { data }) => sum + data.byteLength, 0);
	}, database);

/** Something to copy, so that a copy takes a while. */
const fill = (page: Page, machine: number, mb: number) =>
	root(page, machine, `dd if=/dev/urandom of=/root/filler bs=1M count=${mb} 2>/dev/null; sync`);

for (const image of ["alpine", "debian"]) {
	test(`${image}: a checkpoint of every disk is gone back to, over a reload, and is deleted with its machine`, async ({
		page,
	}) => {
		await openLab(page);
		await typed(page, `spawn 1 ${image} --extra-disk 1,1`);
		await status(page, "1 of 1 machine ready");
		await root(
			page,
			1,
			"echo first > /root/note; mkdir /root/tree; seq 1 5000 > /root/tree/numbers; printf one | dd of=/dev/wdc bs=1M seek=100 conv=notrunc 2>/dev/null; printf two | dd of=/dev/wdd bs=1M seek=7 conv=notrunc 2>/dev/null",
		);
		await typed(page, "sh node1");
		await expect(page.locator("#tab-node1-sh1")).toBeVisible();
		await page.locator("#tab-node1-console").click();
		await root(page, 1, "sleep 4321 & echo $! > /tmp/pid");
		await typed(page, "checkpoint node1 before");
		await expect(row(page)).toContainText(/before \d+\.\d MiB/);
		await root(page, 1, "kill -0 $(cat /tmp/pid)");
		const [{ checkpoints }] = await listed(page);
		expect(checkpoints).toEqual([{ name: "before", bytes: await bytesIn(page, saved(1, 1)) }]);
		await typed(page, "checkpoint node1 before");
		await expect(bar(page)).toContainText("node1 already has a checkpoint called before");
		await page.keyboard.press("Escape");

		// Their names, times, modes and contents.
		const files = () =>
			root(page, 1, "cd /root; find . -type f | sort | xargs md5sum | md5sum; find . | sort | xargs stat -c %n,%Y,%a");
		const before = await files();
		expect(before).toContain("./tree/numbers,");
		const change = () =>
			root(
				page,
				1,
				"echo second > /root/note; rm -r /root/tree; echo new > /root/new; printf ONE | dd of=/dev/wdc bs=1M seek=100 conv=notrunc 2>/dev/null; dd if=/dev/zero of=/dev/wdd bs=1M seek=7 count=1 conv=notrunc 2>/dev/null; printf late | dd of=/dev/wdd bs=1M seek=500 conv=notrunc 2>/dev/null; sync",
			);
		const first = async () => {
			expect(await files()).toBe(before);
			expect(await root(page, 1, "dd if=/dev/wdc bs=1M skip=100 count=1 2>/dev/null | head -c 3")).toBe("one");
			expect(await root(page, 1, "dd if=/dev/wdd bs=1M skip=7 count=1 2>/dev/null | head -c 3")).toBe("two");
			expect(await root(page, 1, 'dd if=/dev/wdd bs=1M skip=500 count=1 2>/dev/null | tr -d "\\000" | wc -c')).toBe(
				"0",
			);
			expect(await shell(page, 1, "pidof sleep")).toMatchObject({ exitCode: 1 });
		};
		await change();
		await confirmed(
			page,
			"restore node1 before",
			"node1 stops without shutting down, so what it runs is lost and 1 shell closes. Everything written to its 3 disks since checkpoint before was saved is gone. There is no undo.",
		);
		await expect(rail(page, "node1")).toContainText("restoring");
		await status(page, "1 of 1 machine ready");
		await expect(page.locator("#tab-node1-sh1")).toHaveCount(0);
		expect(await consoleText(page, "node1")).toContain("node1 is back at checkpoint before. sh1 closed with it.");
		await first();

		await change();
		await page.reload();
		await status(page, "1 of 1 machine ready");
		expect(await root(page, 1, "cat /root/note")).toBe("second");
		await expect(row(page)).toContainText(/before \d+\.\d MiB/);
		await typed(page, "checkpoint node1 after");
		await expect(row(page)).toContainText(/after \d+\.\d MiB · \d+\.\d MiB in all/);
		await typed(page, "poweroff node1");
		await status(page, "0 of 1 machine ready, 1 off");
		expect(await call(page, "checkpoint_save", { machine: "node1", checkpoint: "off" })).toMatchObject({
			data: { machine: "node1", name: "off", bytes: expect.any(Number) },
		});
		expect(await names(page)).toEqual([["before", "after", "off"]]);

		await restored(page, "before", "Everything written to its 3 disks since checkpoint before");
		await first();
		await restored(page, "off", "since checkpoint off was saved");
		expect(await root(page, 1, "cat /root/note /root/new")).toBe("second\nnew");

		await typed(page, "ls");
		await expect(bar(page)).toContainText(/checkpoints before \d+\.\d MiB, after \d+\.\d MiB, off \d+\.\d MiB/);
		await page.keyboard.press("Escape");
		await confirmed(page, "forget node1 after", "node1 cannot go back to it then. Its disks stay as they are now.");
		await expect.poll(() => names(page)).toEqual([["before", "off"]]);
		await confirmed(page, "rm node1", "Its checkpoints before and off are deleted too. There is no undo.");
		await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
		await expect.poll(() => databases(page)).toEqual([]);
	});
}

test("a checkpoint is of one moment on every disk, however the guest writes meanwhile, and the guest is not held up", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --extra-disk 1");
	await status(page, "1 of 1 machine ready");
	await root(page, 1, "apk add --quiet e2fsprogs && mkfs.ext4 -q /dev/wdc && mount /dev/wdc /mnt");
	await fill(page, 1, 150);
	// Each step is on its disk before the next is taken, so at any moment the root's count is the extra's or one more.
	await root(
		page,
		1,
		"(i=0; while :; do i=$((i+1)); echo $i > /root/count.new; fsync /root/count.new; mv /root/count.new /root/count; fsync /root; echo $i > /mnt/count.new; fsync /mnt/count.new; mv /mnt/count.new /mnt/count; fsync /mnt; done) >/dev/null 2>&1 & sleep 1",
	);
	const counted = async () => Number(await root(page, 1, "cat /root/count"));
	const from = await counted();
	await typed(page, "checkpoint node1 moving");
	await expect(row(page)).toContainText(/saving moving [1-9]\d?%/);
	const during = await counted();
	await expect(row(page)).toContainText(/moving \d+\.\d MiB/, { timeout: 60_000 });
	const to = await counted();
	expect(to - from, "it counted on while the disks were copied").toBeGreaterThan(20);

	await restored(page, "moving", "since checkpoint moving was saved");
	const root_ = await counted();
	expect(root_).toBeGreaterThanOrEqual(from);
	expect(root_, "the moment is when it was asked for, not when it was done").toBeLessThanOrEqual(during);
	await root(page, 1, "mount /dev/wdc /mnt");
	const extra = Number(await root(page, 1, "cat /mnt/count"));
	expect([root_, root_ - 1]).toContain(extra);
	await root(page, 1, "umount /mnt; e2fsck -fn /dev/wdc");
	expect(await root(page, 1, "md5sum < /root/filler | wc -c; dmesg | grep -i 'ext4.*error' || echo none")).toContain(
		"none",
	);
});

/** The browser's quota for the lab, set before it first writes: Chromium remembers what was left for 30 s. */
async function limitStorage(page: Page, quotaSize: number): Promise<void> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Storage.overrideQuotaForOrigin", { origin: new URL(page.url()).origin, quotaSize });
}

/** A machine with a checkpoint that takes a while to copy, and files written since. */
async function withCheckpoint(page: Page, quota?: number): Promise<void> {
	await openLab(page);
	if (quota !== undefined) await limitStorage(page, quota);
	await typed(page, "spawn 1 alpine --no-net --extra-disk 1");
	await status(page, "1 of 1 machine ready");
	await root(page, 1, "echo first > /root/note; printf one | dd of=/dev/wdc bs=1M seek=9 conv=notrunc 2>/dev/null");
	await fill(page, 1, 150);
	expect(await call(page, "checkpoint_save", { machine: "node1", checkpoint: "before" })).toMatchObject({
		data: { name: "before" },
	});
	await root(page, 1, "echo second > /root/note; printf two | dd of=/dev/wdc bs=1M seek=9 conv=notrunc 2>/dev/null");
	await root(page, 1, "sync");
	await page.waitForTimeout(1500);
}

const written = async (page: Page) =>
	root(page, 1, "cat /root/note; dd if=/dev/wdc bs=1M skip=9 count=1 2>/dev/null | head -c 3");

test("a reload while a checkpoint is saved leaves none of it, and one while a machine is restored ends restored", async ({
	page,
}) => {
	await withCheckpoint(page);
	await typed(page, "checkpoint node1 cut");
	await expect(row(page)).toContainText(/saving cut [1-9]\d?%/);
	expect(await databases(page)).toEqual([...kept(1, 0, 1), saved(1, 1), saved(1, 2)].sort());
	await page.reload();
	await status(page, "1 of 1 machine ready");
	expect(await names(page)).toEqual([["before"]]);
	await expect.poll(() => databases(page)).toEqual([...kept(1, 0, 1), saved(1, 1)].sort());
	expect(await written(page)).toBe("second\ntwo");

	await confirmed(page, "restore node1 before", "since checkpoint before was saved");
	await expect(rail(page, "node1")).toContainText(/restoring [1-9]\d?%/);
	expect(await listed(page)).toMatchObject([{ name: "node1", state: "restoring" }]);
	expect(await call(page, "shell_exec", { targets: "node1", command: "true" })).toEqual({
		error: "exec has no machine to type into. Skipped node1: being restored. Nothing was changed.",
	});
	await page.reload();
	await expect(rail(page, "node1")).toContainText(/restoring [1-9]\d?%/, { timeout: 60_000 });
	await page.reload();
	await status(page, "0 of 1 machine ready, 1 restoring");
	await status(page, "1 of 1 machine ready");
	expect(await written(page)).toBe("first\none");
	expect(await names(page)).toEqual([["before"]]);
	// The first restore was to set 3, and each reload began again on another.
	await expect.poll(() => databases(page)).toEqual([...kept(1, 5, 1), saved(1, 1)].sort());

	await page.reload();
	await status(page, "1 of 1 machine ready");
	expect(await written(page)).toBe("first\none");
});

test("a machine can be removed while its disks are saved or restored, and nothing of it is left", async ({ page }) => {
	await withCheckpoint(page);
	await typed(page, "checkpoint node1 cut");
	await expect(row(page)).toContainText(/saving cut [1-9]\d?%/);
	await confirmed(page, "rm node1", "Its checkpoint before is deleted too.");
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
	await expect.poll(() => databases(page)).toEqual([]);
	await page.reload();
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await page.evaluate(() => localStorage.clear());
	await withCheckpoint(page);
	await confirmed(page, "restore node1 before", "since checkpoint before was saved");
	await expect(rail(page, "node1")).toContainText(/restoring [1-9]\d?%/);
	await confirmed(page, "rm node1", "Remove node1?");
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
	await expect.poll(() => databases(page)).toEqual([]);
});

const FULL = (what: string) =>
	`Browser storage is full, so ${what} Delete a checkpoint, remove a machine or free some space, then try again.`;
const SAVE_FULL = { error: `${FULL("checkpoint before of node1 could not be saved.")} Nothing was changed.` };

/** The guest runs on, and keeps what it writes. */
async function unharmed(page: Page, extras = 1): Promise<void> {
	expect(await listed(page)).toMatchObject([{ state: "ready", checkpoints: [] }]);
	await expect.poll(() => databases(page)).toEqual(kept(1, 0, extras).sort());
	await root(page, 1, "echo after > /root/after; printf aft | dd of=/dev/wdc bs=1M seek=3 conv=notrunc,fsync; sync");
	await page.reload();
	await status(page, "1 of 1 machine ready");
	expect(await root(page, 1, "cat /root/after; dd if=/dev/wdc bs=1M skip=3 count=1 2>/dev/null | head -c 3")).toBe(
		"after\naft",
	);
}

test("a checkpoint there is no room for is refused naming storage, and the machine is unharmed", async ({ page }) => {
	await openLab(page);
	await limitStorage(page, 200e6);
	await typed(page, "spawn 1 alpine --no-net --extra-disk 1");
	await status(page, "1 of 1 machine ready");
	await fill(page, 1, 110);
	expect(await call(page, "checkpoint_save", { machine: "node1", checkpoint: "before" })).toEqual(SAVE_FULL);
	await unharmed(page);
});

for (const who of ["the checkpoint", "the guest"]) {
	test(`storage that runs out under ${who} while a checkpoint is saved leaves no checkpoint and an unharmed machine`, async ({
		page,
	}) => {
		await openLab(page);
		await typed(page, "spawn 1 alpine --no-net --extra-disk 1");
		await status(page, "1 of 1 machine ready");
		await fill(page, 1, 40);
		const [worker] = page.workers().filter((w) => w.url().includes("vm-worker"));
		// What a browser out of storage does to the copy's writes, or to one of the guest's once the copy is under way.
		await worker.evaluate((who) => {
			const { add, put } = IDBObjectStore.prototype;
			let copied = 0;
			let refused = false;
			const refuse = () => {
				refused = true;
				throw new DOMException("no room", "QuotaExceededError");
			};
			IDBObjectStore.prototype.add = function (...args) {
				return ++copied > 10 && who === "the checkpoint" ? refuse() : add.apply(this, args);
			};
			IDBObjectStore.prototype.put = function (...args) {
				return copied > 10 && who === "the guest" && !refused ? refuse() : put.apply(this, args);
			};
		}, who);
		await start(page, "save", "checkpoint_save", { machine: "node1", checkpoint: "before" });
		if (who === "the guest") await root(page, 1, "for i in $(seq 200); do echo $i > /root/i; fsync /root/i; done");
		expect(await finish(page, "save")).toEqual(SAVE_FULL);
		await unharmed(page);
	});
}

test("a restore that runs out of storage, or whose checkpoint is gone, fails with the disks as they were", async ({
	page,
}) => {
	await withCheckpoint(page, 450e6);
	await typed(page, "poweroff node1");
	await status(page, "0 of 1 machine ready, 1 off");
	const before = await databases(page);
	await confirmed(page, "restore node1 before", "Everything written to its 2 disks");
	await status(page, "0 of 1 machine ready, 1 failed");
	const full = FULL("node1 could not go back to checkpoint before. Its disks are as they were.");
	await expect(details(page)).toContainText(full);
	await expect.poll(() => databases(page)).toEqual(before);

	await page.evaluate(
		(name) =>
			new Promise((resolve) => {
				indexedDB.deleteDatabase(name).onsuccess = resolve;
			}),
		saved(1, 1),
	);
	await confirmed(page, "restore node1 before", "Everything written to its 2 disks");
	await expect(details(page)).toContainText(/could not go back to checkpoint before: .* Its disks are as they were\./);
	await typed(page, "boot node1");
	await status(page, "1 of 1 machine ready");
	expect(await written(page)).toBe("second\ntwo");
});

test("what stops under a checkpoint that is being saved ends it, and what would is refused", async ({ page }) => {
	await withCheckpoint(page);
	await start(page, "save", "checkpoint_save", { machine: "node1", checkpoint: "cut" });
	await expect(row(page)).toContainText(/saving cut [1-9]\d?%/);
	const busy = "node1 is saving checkpoint cut, so wait until it is done. Nothing was changed.";
	for (const tool of ["machines_poweroff", "machines_reboot"]) {
		expect(await call(page, tool, { names: "node1" })).toEqual({ error: busy });
	}
	expect(await call(page, "checkpoint_save", { machine: "node1", checkpoint: "other" })).toEqual({ error: busy });
	expect(await call(page, "checkpoint_restore", { machine: "node1", checkpoint: "before" })).toEqual({ error: busy });
	await shell(page, 1, "sudo poweroff").catch(() => {});
	expect(await finish(page, "save")).toEqual({
		error: "node1 stopped before checkpoint cut was saved. Nothing was changed.",
	});
	await status(page, "0 of 1 machine ready, 1 off");
	expect(await names(page)).toEqual([["before"]]);
	await expect.poll(() => databases(page)).toEqual([...kept(1, 0, 1), saved(1, 1)].sort());

	await start(page, "off", "checkpoint_save", { machine: "node1", checkpoint: "off" });
	await expect(row(page)).toContainText(/saving off [1-9]\d?%/);
	expect(await call(page, "machines_boot", { names: "node1" })).toEqual({
		error: "node1 is saving a checkpoint, so wait until it is done. Nothing was changed.",
	});
	expect(await finish(page, "off")).toMatchObject({ data: { name: "off" } });
	await typed(page, "boot node1");
	await status(page, "1 of 1 machine ready");
	expect(await written(page)).toBe("second\ntwo");
});

test("an agent's restore asks first, runs only for the checkpoint it asked about, and boots a machine that has failed", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine");
	await status(page, "1 of 1 machine ready");
	await root(page, 1, "echo first > /root/note; sync");
	await call(page, "checkpoint_save", { machine: "node1", checkpoint: "before" });
	await root(page, 1, "echo second > /root/note; sync");

	const panel = page.locator("unlab-agent-panel");
	const approve = panel.getByRole("button", { name: "Restore node1 to before", exact: true });
	await start(page, "stale", "checkpoint_restore", { machine: "node1", checkpoint: "before" });
	await expect(panel.locator("unlab-confirm")).toContainText(
		"Everything written to its disk since checkpoint before was saved is gone. There is no undo.",
	);
	await confirmed(page, "forget node1 before", "Delete checkpoint before of node1?");
	await expect.poll(() => names(page)).toEqual([[]]);
	await call(page, "checkpoint_save", { machine: "node1", checkpoint: "before" });
	await approve.click();
	expect(await finish(page, "stale")).toEqual({
		error: "What this does to node1 has changed since it was asked. Nothing was changed.",
	});

	await crash(page, 1);
	await status(page, "0 of 1 machine ready, 1 failed");
	await start(page, "restore", "checkpoint_restore", { machine: "node1", checkpoint: "before" });
	await approve.click();
	expect(await finish(page, "restore")).toEqual({
		result: "node1 ready",
		data: [{ name: "node1", state: "ready" }],
	});
	expect(await root(page, 1, "cat /root/note")).toBe("second");
	await expect(details(page)).toContainText("connected on port 1");

	await start(page, "forget", "checkpoint_remove", { machine: "node1", checkpoint: "before" });
	await panel.getByRole("button", { name: "Delete checkpoint before of node1", exact: true }).click();
	expect(await finish(page, "forget")).toMatchObject({ data: { machine: "node1", removed: "before" } });
	expect(await call(page, "checkpoint_restore", { machine: "node1", checkpoint: "before" })).toEqual({
		error: "node1 has no checkpoint called before. It has none. Nothing was changed.",
	});
});
