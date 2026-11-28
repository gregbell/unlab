import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { fromMenu, openLab as openDesktop, root, screen, shell, status, typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

/** When set, the tests also save screenshots of an approval there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page, line = "spawn 1 alpine", ready = "1 of 1 ready"): Promise<void> {
	await openDesktop(page);
	await typed(page, line);
	await status(page, ready);
}

const bar = (page: Page) => page.locator("unlab-command-bar");

const panel = (page: Page) => page.locator("unlab-agent-panel");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Put {
	readonly path: string;
	readonly text: string;
	readonly owner?: string;
	readonly mode?: string;
}

const put = (page: Page, file: Put, machine = "node1") => call(page, "file_write", { machine, ...file });

/** A file that must be written, and what the agent is told of it. */
async function wrote(page: Page, file: Put): Promise<unknown> {
	const reply = (await put(page, file)) as { data?: unknown };
	expect(reply, file.path).toHaveProperty("data");
	return reply.data;
}

/** The guest's own sum of it. */
const sum = async (page: Page, path: string) => (await root(page, 1, `sha256sum < ${path}`)).split(" ")[0];

const sessionText = async (page: Page, session: string) =>
	((await call(page, "shell_read", { machine: session, lines: 500 })) as { text: string }).text;

/** What a session's terminal window shows: `node1:console`, `node1:sh1`. */
const shows = (page: Page, session: string) => {
	const [machine, shell] = session.split(":");
	return screen(page, machine, shell === "console" ? undefined : shell);
};

/** Keys on a session's terminal, as a person types them, with its window brought to the front first. */
async function keys(page: Page, session: string, text: string): Promise<void> {
	await typed(page, `focus ${session}`);
	await shows(page, session).click();
	await page.keyboard.type(text);
}

const recent = (page: Page) => bar(page).locator('[data-kind="recent"] .line');

const QUOTED = "'single' \"double\" `id` $(id) $HOME \\n \\\\ \\ ! # ~ * ? & | ; < > % %s\n";
const NON_ASCII = "é ü 漢字 🧪 👩‍👩‍👧 ﻿   end\n";

for (const image of ["alpine", "debian"]) {
	test(`${image}: a text an agent writes arrives unchanged, with its directories, owner and mode, over a reload`, async ({
		page,
	}) => {
		await openLab(page, `spawn 1 ${image}`);
		const texts = [
			QUOTED,
			NON_ASCII,
			"\n  leading, trailing \t\n\n",
			"no newline",
			"-- --mode 600\n--owner user\n--\n",
			"one\r\ntwo\rthree\n",
			"nul \0 escape \x1b[31m end \x04\x03\n",
			"",
		];
		for (const text of texts) {
			await wrote(page, { path: "/root/text", text });
			expect(await sum(page, "/root/text"), JSON.stringify(text)).toBe(sha256(text));
		}
		const largest = `${"é".repeat(2 ** 19 - 1)}\n\n`;
		expect(await wrote(page, { path: "/srv/a/b/largest", text: largest })).toEqual({
			machine: "node1",
			path: "/srv/a/b/largest",
			bytes: 2 ** 20,
			owner: "root:root",
			mode: "644",
		});
		expect(await sum(page, "/srv/a/b/largest")).toBe(sha256(largest));
		expect(await put(page, { path: "/srv/a/b/largest", text: `${largest}x` })).toEqual({
			error: "text has 1048577 bytes, and write takes at most 1048576. Nothing was changed.",
		});
		expect(await sum(page, "/srv/a/b/largest")).toBe(sha256(largest));

		const spaced = '/srv/two words/it\'s "$x"';
		await wrote(page, { path: spaced, text: spaced });
		expect(await root(page, 1, "cat /srv/two*/*")).toBe(spaced);

		const stat = (path: string) => root(page, 1, `stat -c "%U:%G %a" ${path}`);
		expect(await stat("/srv/a /srv/a/b /srv/a/b/largest")).toBe("root:root 755\nroot:root 755\nroot:root 644");
		await wrote(page, { path: "/home/user/.config/rc", text: "a", owner: "user", mode: "600" });
		expect(await stat("/home/user/.config /home/user/.config/rc")).toMatch(/^user:\w+ 755\nuser:\w+ 600$/);
		await wrote(page, { path: "/etc/conf.d/lab", text: QUOTED, owner: "nobody:tty", mode: "4750" });
		expect(await stat("/etc/conf.d/lab")).toBe("nobody:tty 4750");
		await wrote(page, { path: "/etc/conf.d/lab", text: NON_ASCII });
		expect(await stat("/etc/conf.d/lab")).toBe("nobody:tty 4750");
		expect(await sum(page, "/etc/conf.d/lab")).toBe(sha256(NON_ASCII));

		// The last thing before the reload, so nothing but the write itself puts it on the disk.
		await wrote(page, { path: "/etc/late/note", text: QUOTED, mode: "640" });
		await page.reload();
		await status(page, "1 of 1 ready");
		expect(await sum(page, "/etc/late/note")).toBe(sha256(QUOTED));
		expect(await stat("/etc/late/note")).toBe("root:root 640");
		expect(await sum(page, "/srv/a/b/largest")).toBe(sha256(largest));
	});

	test(`${image}: a write leaves a person's program, half-typed line and shell history alone`, async ({ page }) => {
		await openLab(page, `spawn 1 ${image}`);
		await typed(page, "sh node1");
		await expect(shows(page, "node1:sh1")).toContainText("⇒");
		await keys(page, "node1:sh1", image === "alpine" ? "vi /tmp/draft\n" : "cat\n");
		// Keys that come while a shell starts a program are not the program's yet.
		await page.waitForTimeout(1000);
		await page.keyboard.type(image === "alpine" ? "ihalf a sentence" : "half a sentence");
		await expect(shows(page, "node1:sh1")).toContainText("half a sentence");
		await keys(page, "node1:console", "echo typed-$((6*");
		await expect(shows(page, "node1:console")).toContainText("echo typed-$((6*");
		await page.waitForTimeout(500);

		const shown = async () => ({
			text: [await sessionText(page, "node1:console"), await sessionText(page, "node1:sh1")],
			marks: await page.locator("unlab-terminal .gutter .rule").count(),
			focused: await page.evaluate(() => document.activeElement?.closest(".dt-window")?.getAttribute("aria-label")),
		});
		const before = await shown();
		expect(before.text).toEqual([
			expect.stringContaining("echo typed-$((6*"),
			expect.stringContaining("half a sentence"),
		]);
		expect(before.focused).toBe("node1 · terminal");
		await wrote(page, { path: "/etc/secret-path", text: QUOTED });
		await wrote(page, { path: "/home/user/secret-path", text: "two\nlines\n", owner: "user" });
		await page.waitForTimeout(1000);
		expect(await shown()).toEqual(before);

		await page.keyboard.type("7))\n");
		await expect(shows(page, "node1:console")).toContainText("typed-42");
		await page.keyboard.type("history\n");
		await expect(shows(page, "node1:console")).toContainText(/\d+ +history/);
		await page.keyboard.type("cat ~/.ash_history ~/.bash_history; echo hist-$((1+1))\n");
		await expect(shows(page, "node1:console")).toContainText("hist-2");
		expect(await sessionText(page, "node1:console")).not.toContain("secret-path");
		expect(await sum(page, "/etc/secret-path")).toBe(sha256(QUOTED));

		// The person's program is still at what they were typing.
		await keys(page, "node1:sh1", " more");
		if (image === "alpine") {
			await page.keyboard.press("Escape");
			// vi takes what comes at once after an escape for a key's sequence.
			await page.waitForTimeout(500);
			await page.keyboard.type(":wq\n");
			await expect
				.poll(() => root(page, "node1:console", "cat /tmp/draft 2>/dev/null || :"))
				.toBe("half a sentence more");
		} else {
			await page.keyboard.press("Enter");
			await expect(shows(page, "node1:sh1")).toContainText(/half a sentence more\s+half a sentence more/);
		}
	});
}

test("a person writes a line from the bar, which says what it will do and did", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await openLab(page);
	await page.keyboard.press("Control+/");
	await page.keyboard.type("write node1 /etc/app/rc --mo");
	await expect(bar(page)).toContainText("--mode mode");
	await page.keyboard.press("Tab");
	await page.keyboard.type("600 -- ");
	await expect(bar(page)).toContainText("write /etc/app/rc on node1 · empty · mode 600");
	const line = '  it\'s "$HOME" `id` \\n 漢字 -- --owner x  ';
	await page.keyboard.type(line);
	await expect(bar(page)).toContainText(`1 line, ${Buffer.byteLength(line)} bytes · mode 600`);
	await page.keyboard.press("Enter");
	await expect(bar(page)).toContainText(
		`wrote /etc/app/rc on node1 · 1 line, ${Buffer.byteLength(line)} bytes · root:root 600`,
	);
	await page.keyboard.press("Escape");
	expect(await sum(page, "/etc/app/rc")).toBe(sha256(line));

	await page.keyboard.press("Control+/");
	await page.keyboard.press("ArrowUp");
	await expect(page.getByRole("combobox")).toHaveValue(`write node1 /etc/app/rc --mode 600 -- ${line}`);
	await page.keyboard.press("Escape");

	// The bar is one line, and the preview counts what is in it.
	await page.evaluate(() => navigator.clipboard.writeText("one\ntwo\nthree"));
	await page.keyboard.press("Control+/");
	await page.keyboard.type("write node1 /root/pasted -- ");
	await page.keyboard.press("Control+V");
	await expect(bar(page)).toContainText("write /root/pasted on node1 · 1 line, 13 bytes");
	await page.keyboard.press("Enter");
	await expect(bar(page)).toContainText("wrote /root/pasted");
	await page.keyboard.press("Escape");
	expect(await root(page, 1, "cat /root/pasted")).toBe("one two three");

	for (const [asked, said] of [
		["write node1 etc/motd -- a", "write wants a path that starts with /, such as /etc/motd, not etc/motd."],
		["write node1 /etc/motd --mode 999 -- a", "--mode wants three or four octal digits, such as 644, not 999."],
		["write node1 /etc/motd", "write wants a text after --."],
		["write node1 /etc -- a", "/etc on node1 is a directory, so give the path of a file in it."],
		["write node1 /etc/motd --owner bob -- a", "node1 has no user called bob, so --owner cannot name it."],
		["write node1 /etc/passwd/a -- a", "/etc/passwd on node1 is not a directory, so /etc/passwd/a cannot be in it."],
	]) {
		await typed(page, asked);
		await expect(bar(page)).toContainText(said);
		await expect(bar(page)).toContainText("Nothing was changed.");
		await page.keyboard.press("Escape");
	}
});

test("a file system with no room, or that is read-only, is named, and what is there stays", async ({ page }) => {
	await openLab(page);
	await root(
		page,
		1,
		"mkdir /mnt/small /mnt/ro; mount -t tmpfs -o size=64k none /mnt/small; mount -t tmpfs none /mnt/ro; echo old > /mnt/small/a; echo old > /mnt/ro/a; mount -o remount,ro /mnt/ro",
	);
	expect(await put(page, { path: "/mnt/small/a", text: "x".repeat(100_000) })).toEqual({
		error: "The file system on /mnt/small of node1 is full, so /mnt/small/a was not written. Nothing was changed.",
	});
	expect(await put(page, { path: "/mnt/ro/a", text: "new" })).toEqual({
		error: "The file system on /mnt/ro of node1 is read-only, so /mnt/ro/a cannot be written. Nothing was changed.",
	});
	expect(await root(page, 1, "cat /mnt/small/a /mnt/ro/a; ls -A /mnt/small /mnt/ro")).toBe(
		"old\nold\n/mnt/ro:\na\n\n/mnt/small:\na",
	);
});

test("a machine that is not ready is refused with its state", async ({ page }) => {
	await openLab(page, "spawn 2 alpine", "2 of 2 ready");
	const said = async (machine: string) =>
		((await put(page, { path: "/etc/motd", text: "a" }, machine)) as { error: string }).error;
	await typed(page, "spawn 1 alpine");
	expect(await said("node3")).toBe(
		"write wants a ready machine here, and node3 is still booting. Nothing was changed.",
	);
	await status(page, "3 of 3 ready");
	await root(page, 2, "dd if=/dev/urandom of=/root/filler bs=1M count=100 2>/dev/null; sync");
	expect(await call(page, "checkpoint_save", { machine: "node2", checkpoint: "before" })).toHaveProperty("data");
	await typed(page, "restore node2 before");
	await expect(bar(page)).toContainText("Restore");
	await page.keyboard.press("Enter");
	await expect
		.poll(() => said("node2"))
		.toBe("write wants a ready machine here, and node2 is being restored. Nothing was changed.");
	expect(await call(page, "machines_poweroff", { names: "node1" })).toHaveProperty("data");
	expect(await said("node1")).toBe("write wants a ready machine here, and node1 is off. Nothing was changed.");
	expect(await said("node9")).toMatch(/^No machine is called node9, so use /);
});

/** The guest's next write waits before it starts, as one on a busy guest does. */
const slow = (page: Page, seconds: number) =>
	root(
		page,
		1,
		`mkdir -p /usr/local/bin; printf "#!/bin/sh\\ntouch /run/writing; sleep ${seconds}; exec /bin/busybox mktemp \\"\\$@\\"\\n" > /usr/local/bin/mktemp; chmod 755 /usr/local/bin/mktemp`,
	);

const writing = (page: Page) => expect.poll(() => root(page, 1, "ls /run/writing || :")).toContain("/run/writing");

test("a host table that comes while an agent writes /etc/hosts is in it afterwards", async ({ page }) => {
	await openLab(page);
	await slow(page, 10);
	await start(page, "write", "file_write", { machine: "node1", path: "/etc/hosts", text: "10.88.0.99 mine\n" });
	await writing(page);
	await typed(page, "spawn 1 alpine");
	await status(page, "2 of 2 ready");
	expect(await root(page, 1, "cat /etc/hosts"), "the write is not over").not.toContain("mine");
	expect(await finish(page, "write")).toHaveProperty("data");
	await expect.poll(() => root(page, 1, "cat /etc/hosts")).toContain("10.88.0.12 node2");
	expect(await root(page, 1, "cat /etc/hosts")).toMatch(/^10\.88\.0\.99 mine\n# unlab: begin\n/);
});

test("a machine that goes down or comes back while it writes a file says so, and the old file is whole", async ({
	page,
}) => {
	await openLab(page);
	await root(page, 1, "echo old > /etc/motd");
	for (const [line, why, back] of [
		["reboot node1", "rebooted", "1 of 1 ready"],
		["poweroff node1", "powered off", "0 of 1 ready, 1 off"],
	]) {
		await slow(page, 20);
		await start(page, "write", "file_write", { machine: "node1", path: "/etc/motd", text: "new\n" });
		await writing(page);
		await typed(page, line);
		expect(await finish(page, "write")).toEqual({
			error: `node1 ${why} while /etc/motd was being written, so check whether it was.`,
		});
		await status(page, back);
		if (why === "powered off") {
			await typed(page, "boot node1");
			await status(page, "1 of 1 ready");
		}
		expect(await root(page, 1, "cat /etc/motd; ls -A /etc | grep unlab || echo none")).toBe("old\nnone");
	}
	await root(page, 1, "rm /usr/local/bin/mktemp");
	await wrote(page, { path: "/etc/motd", text: "new\n" });
	expect(await root(page, 1, "cat /etc/motd")).toBe("new");
});

test("a write an agent withdraws is whole or not at all, and the next one comes after it", async ({ page }) => {
	await openLab(page);
	await slow(page, 4);
	await start(page, "write", "file_write", { machine: "node1", path: "/etc/motd", text: "withdrawn\n" });
	await writing(page);
	await page.evaluate(() => window.running?.get("write")?.controller.abort());
	await fromMenu(page, "WebMCP");
	await expect(panel(page)).toContainText("withdrawn by the agent");
	await root(page, 1, "rm /usr/local/bin/mktemp");
	await wrote(page, { path: "/etc/motd", text: "next\n" });
	// Were it still to come, the first would be over by now.
	await page.waitForTimeout(5000);
	expect(await root(page, 1, "cat /etc/motd; ls -A /etc | grep unlab || echo none")).toBe("next\nnone");
});

test("a text of several lines is readable where a person approves it, and left out of the lists of lines", async ({
	page,
}) => {
	await openLab(page);
	await fromMenu(page, "WebMCP");
	await page.getByLabel("Policy for file_write").selectOption("ask");
	const text = `server {\n    listen 80;\n\tname $host;\n}\n${"a\n".repeat(20)}${"long ".repeat(60)}\n`;
	await start(page, "write", "file_write", { machine: "node1", path: "/etc/nginx/lab.conf", mode: "600", text });
	const asked = panel(page).locator("unlab-confirm");
	await expect(asked.locator(".heading")).toHaveText("write node1 /etc/nginx/lab.conf --mode 600");
	const detail = asked.locator(".detail");
	const size = `${text.split("\n").length - 1} lines, ${text.length} bytes`;
	expect(await detail.textContent()).toContain(
		`Will write /etc/nginx/lab.conf on node1 · ${size} · mode 600.\nserver {\n    listen 80;\n\tname $host;\n}\n`,
	);
	const box = await detail.evaluate((e) => ({
		wide: e.scrollWidth > e.clientWidth,
		lines: e.clientHeight / Number.parseFloat(getComputedStyle(e).lineHeight),
	}));
	expect(box.wide).toBe(false);
	expect(box.lines, "each line is one").toBeGreaterThan(25);
	if (shots) await page.screenshot({ path: `${shots}/write-approval.png` });
	await expect(asked.getByRole("button", { name: "Write /etc/nginx/lab.conf on node1" })).toBeEnabled();
	await asked.getByRole("button", { name: "Write /etc/nginx/lab.conf on node1" }).click();
	expect(await finish(page, "write")).toHaveProperty("data");
	const logged = panel(page).locator(".call").last();
	await expect(logged.locator(".line")).toHaveText("write node1 /etc/nginx/lab.conf --mode 600");
	await expect(logged.locator(".result")).toHaveText(`→ wrote /etc/nginx/lab.conf on node1 · ${size} · root:root 600`);
	if (shots) await page.screenshot({ path: `${shots}/write-log.png` });

	await page.keyboard.press("Control+/");
	await expect(recent(page).first()).toHaveText("write node1 /etc/nginx/lab.conf --mode 600");
	await recent(page).first().click();
	await expect(page.getByRole("combobox", { name: "Command" })).toHaveValue(
		"write node1 /etc/nginx/lab.conf --mode 600",
	);
	await page.keyboard.press("Enter");
	await expect(bar(page)).toContainText("write wants a text after --.");
	await page.keyboard.press("Escape");
	expect(await sum(page, "/etc/nginx/lab.conf")).toBe(sha256(text));
	expect((await shell(page, 1, "id -un")).output).toBe("user");
});
