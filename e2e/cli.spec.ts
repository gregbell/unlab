// The built lab in a browser, with real machines, and the CLI's own process
// beside it: what a person has who runs `npx unlab.run`.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { buildCli, freePort, type Session, TestCli } from "../test/support/cli.ts";
import { linkSaid, openWithTwoMachines, status, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 4173}`;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});
test.beforeAll(buildCli);

let cli: TestCli;
test.beforeEach(async () => {
	cli = new TestCli(await freePort(), { origin: ORIGIN });
});
test.afterEach(() => cli.close());

const access = (page: Page) => page.getByRole("region", { name: "SSH access", exact: true });

/** One at a time, as they are pressed: what comes all at once is taken for pasted text. */
async function keys(session: Session, ...presses: readonly string[]): Promise<void> {
	for (const press of presses) {
		session.press(press);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

const opened = (to = cli) => `/#cli=${to.port}`;

/** Every address the page tried to reach that is not its own. */
function dialled(page: Page): string[] {
	const urls: string[] = [];
	page.on("websocket", (socket) => urls.push(socket.url()));
	page.on("request", (request) => {
		if (!request.url().startsWith(ORIGIN) && !request.url().startsWith("blob:") && !request.url().startsWith("data:"))
			urls.push(request.url());
	});
	return urls;
}

async function linkedLab(page: Page): Promise<Session> {
	await openWithTwoMachines(page);
	const session = cli.start();
	await session.shows("Waiting for the lab");
	await page.evaluate((hash) => {
		location.hash = hash;
	}, `cli=${cli.port}`);
	await session.shows("Linked to the lab: node1 (alpine), node2 (alpine)");
	await expect(await linkSaid(page)).toHaveText("cli: linked");
	return session;
}

test("a lab that has never linked reaches for nothing, and downloads nothing for SSH", async ({ page }) => {
	const urls = dialled(page);
	const ssh: string[] = [];
	page.on("request", (request) => request.url().includes("/ssh/") && ssh.push(request.url()));
	await openWithTwoMachines(page);
	await expect(await linkSaid(page)).toHaveText("cli: off");
	await page.waitForTimeout(3000);
	expect(urls).toEqual([]);
	expect(ssh).toEqual([]);
	expect(await page.evaluate(() => localStorage.getItem("unlab.cli.v1"))).toBeNull();
});

test("the CLI opens a lab that links, gives a shell, and links again by itself after a reload", async ({ page }) => {
	const session = cli.start();
	await session.shows("Waiting for the lab");
	await page.goto(opened());
	await session.shows("Linked to the lab, which has no machines yet.");
	expect(new URL(page.url()).hash).toBe("");

	session.type("spawn 2 alpine");
	await session.shows("booting node1 and node2");
	await session.shows("node1 is ready.", 60_000);
	await session.shows("node2 is ready.", 60_000);
	expect(await cli.ssh("node1.unlab", "id -un; hostname")).toMatchObject({ code: 0, stdout: "user\nnode1\n" });
	const requested: string[] = [];
	page.on("request", (request) => requested.push(request.url()));

	const at = session.printed.length;
	await page.reload();
	await session.shows("The lab is not linked any more. Waiting for it.", 10_000, at);
	await session.shows("node1 (alpine, booting)", 20_000, at);
	await session.shows("node1 is ready.", 60_000, at);
	expect(await cli.ssh("node1.unlab", "hostname")).toMatchObject({ code: 0, stdout: "node1\n" });

	// The first connection was after a reload, so the server is not left from before: it was put there again.
	expect((await cli.ssh("root@node1.unlab", "ls /run/unlab-ssh/host_key")).code).toBe(0);
});

test("a lab that has linked before is linked within three seconds of the CLI starting", async ({ page }) => {
	const first = await linkedLab(page);
	first.child.kill("SIGTERM");
	await first.exited;
	await expect(await linkSaid(page)).toHaveText("cli: waiting", { timeout: 5000 });
	const t0 = Date.now();
	const again = cli.start();
	await again.shows("Linked to the lab: node1");
	expect(Date.now() - t0).toBeLessThan(3000);
});

test("a page the CLI opens beside an open lab hands the link to it, and does not load the lab again", async ({
	page,
	context,
}) => {
	await openWithTwoMachines(page);
	const session = cli.start();
	const second = await context.newPage();
	await second.goto(opened());
	await expect(second.getByText("This lab is open in another tab, and the CLI links to it there.")).toBeVisible();
	await session.shows("Linked to the lab: node1 (alpine), node2 (alpine)");
	await expect(await linkSaid(page)).toHaveText("cli: linked");
});

test("the link is turned off in the lab, by keyboard, and stays off over a reload", async ({ page }) => {
	const session = await linkedLab(page);
	await expect(access(page)).toContainText("Linked to the CLI on this computer.");
	const off = access(page).getByRole("button", { name: "Turn link off" });
	await off.focus();
	await page.keyboard.press("Enter");
	await expect(await linkSaid(page)).toHaveText("cli: off");
	await session.shows("The lab is not linked any more.");
	const urls = dialled(page);
	await page.reload();
	await status(page, "2 of 2 ready", 60_000);
	await page.waitForTimeout(2500);
	await expect(await linkSaid(page)).toHaveText("cli: off");
	expect(urls).toEqual([]);
});

test("the prompt runs the lab's commands, asks for what asks first, and the lab shows who ran them", async ({
	page,
}) => {
	const session = await linkedLab(page);
	const run = async (line: string, shows: string | RegExp) => {
		const at = session.printed.length;
		session.type(line);
		await session.shows(shows, 15_000, at);
	};
	await run("ls", /2 machines · 2 ready[\s\S]*node1 {2}ready {2}10\.88\.0\.11\/24[^\n]*internet through the CLI/);
	await run("topology", "switch0");
	await run("help spawn", "Boot new");
	await run("help", "And the CLI's own:");
	await run("help", /ssh +open a shell in a machine/);
	await run("spwn 1 alpine", "Did you mean: spawn 1 alpine");
	await run("exec node1 -- echo out; false", /out\nnode1 {2}exit 1/);
	await run("link down node2", "node2");
	await run("rm node2", "Remove node2? [y/N]");
	await run("n", "You did not say yes. Nothing was changed.");
	await run("rm node2", "Remove node2? [y/N]");
	await run("yes", "removed node2");
	await status(page, "1 of 1 ready");

	await page.keyboard.press("Control+/");
	await expect(page.locator('[data-source="cli"]').first()).toContainText("cli");
	await page.keyboard.press("Escape");
});

test("one command from a shell: its output, its exit status, its data, and no question without a terminal", async ({
	page,
}) => {
	await linkedLab(page);
	expect(await cli.once("exec", "node1", "--", "uname", "-m")).toMatchObject({ code: 0, stdout: "aarch64\n" });
	expect(await cli.once("exec", "node1", "--", "exit 5 | sh -c 'exit 4'")).toMatchObject({ code: 4 });
	const listed = JSON.parse((await cli.once("--json", "ls")).stdout);
	const { data } = (await call(page, "machines_list", {})) as { data: unknown };
	expect(listed.data).toEqual(data);
	expect(await cli.once("rm", "node2")).toMatchObject({
		code: 1,
		stderr: expect.stringContaining("Nothing was changed."),
	});
	expect((await cli.once("ls")).stdout).toContain("node2");
	expect(await cli.once("--yes", "rm", "node2")).toMatchObject({ code: 0, stdout: "removed node2\n" });
	expect(await cli.once("exec", "node9", "--", "true")).toMatchObject({
		code: 1,
		stderr: expect.stringContaining("node9"),
	});
});

test("one command with no CLI running links by itself", async ({ page }) => {
	const first = await linkedLab(page);
	first.child.kill("SIGTERM");
	await first.exited;
	expect(await cli.once("exec", "node1", "--", "hostname")).toMatchObject({ code: 0, stdout: "node1\n" });
	expect(await cli.once("ssh", "node2", "--", "hostname")).toMatchObject({ code: 0, stdout: "node2\n" });
});

test("a second CLI uses the first", async ({ page }) => {
	await linkedLab(page);
	const second = cli.start();
	await second.shows("The CLI is already running, so this uses it.");
	await second.shows("Linked to the lab: node1");
	second.type("ls");
	await second.shows("2 machines · 2 ready");
});

test("a CLI that is killed leaves the lab as it was, within five seconds", async ({ page }) => {
	const session = await linkedLab(page);
	const uplinks = async (said: string) => {
		await typed(page, "ls");
		await expect(page.locator("unlab-command-bar").locator(".machine-result").first()).toContainText(said);
		await page.keyboard.press("Escape");
	};
	await uplinks("internet through the CLI");
	session.child.kill("SIGKILL");
	await expect(await linkSaid(page)).toHaveText("cli: waiting", { timeout: 5000 });
	await uplinks("package repositories");
	const ping = (await call(page, "shell_exec", { targets: "node1", command: "ping -c 1 10.88.0.12" })) as {
		data: { ran: { exitCode: number }[] };
	};
	expect(ping.data.ran[0].exitCode).toBe(0);
	await status(page, "2 of 2 ready");
});

test("a machine in the browser reaches the internet while linked, and nothing after", async ({ page }) => {
	const address = Object.values(networkInterfaces())
		.flatMap((all) => all ?? [])
		.find((one) => one.family === "IPv4" && !one.internal)?.address;
	const server = createServer((_, response) => response.end("from outside"));
	await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
	const at = server.address();
	const url = `http://${address}:${typeof at === "object" && at ? at.port : 0}/`;
	cli.close();
	cli = new TestCli(await freePort(), { origin: ORIGIN, args: ["--lan"] });
	const session = await linkedLab(page);
	expect(await cli.ssh("node1.unlab", `wget -qO- ${url}`)).toMatchObject({
		code: 0,
		stdout: "from outside",
		stderr: "",
	});
	expect((await cli.ssh("node1.unlab", `ping -c 2 -W 5 ${address}`)).stdout).toContain("2 packets received");
	session.child.kill("SIGKILL");
	await expect(await linkSaid(page)).toHaveText("cli: waiting", { timeout: 5000 });
	const tried = (await call(page, "shell_exec", { targets: "node1", command: `wget -T 3 -qO- ${url}` })) as {
		data: { ran: { exitCode: number }[] };
	};
	expect(tried.data.ran[0].exitCode).not.toBe(0);
	server.close();
});

test("no file of SSH's is in a checkpoint, and a reboot takes it away and the next connection puts it back", async ({
	page,
}) => {
	const session = await linkedLab(page);
	expect((await cli.ssh("node1.unlab", "true")).code).toBe(0);
	session.type("checkpoint node1 with-ssh");
	await session.shows(/with-ssh/);
	await expect.poll(async () => (await cli.once("ls")).stdout, { timeout: 60_000 }).toContain("checkpoint with-ssh");
	expect(await cli.once("--yes", "restore", "node1", "with-ssh")).toMatchObject({ code: 0 });
	await expect.poll(async () => (await cli.once("ls")).stdout, { timeout: 90_000 }).toMatch(/node1 +ready/);
	expect(
		await cli.once("exec", "node1", "--", "ls /run/unlab-ssh; find / -xdev -name '*dropbear*' 2>/dev/null; true"),
	).toMatchObject({ code: 0, stdout: expect.stringContaining("No such file") });
	expect(await cli.ssh("node1.unlab", "hostname")).toMatchObject({ code: 0, stdout: "node1\n" });

	// A new machine under a removed one's name is known without a question.
	expect(await cli.once("spawn", "1", "alpine", "--name", "web")).toMatchObject({ code: 0 });
	await session.shows("web is ready.", 60_000);
	expect((await cli.ssh("web.unlab", "hostname")).stdout).toBe("web\n");
	expect((await cli.once("--yes", "rm", "web")).code).toBe(0);
	const at = session.printed.length;
	expect(await cli.once("spawn", "1", "alpine", "--name", "web")).toMatchObject({ code: 0 });
	await session.shows("web is ready.", 60_000, at);
	expect(await cli.ssh("web.unlab", "hostname")).toMatchObject({ code: 0, stdout: "web\n", stderr: "" });
});

test("scp copies 10 MiB into a machine in the browser and back", async ({ page }) => {
	await linkedLab(page);
	const bytes = Buffer.alloc(10 * 2 ** 20, "unlab ");
	writeFileSync(join(cli.dir, "there"), bytes);
	expect(await cli.scp(join(cli.dir, "there"), "node1.unlab:/tmp/file")).toMatchObject({ code: 0 });
	expect(await cli.scp("node1.unlab:/tmp/file", join(cli.dir, "back"))).toMatchObject({ code: 0 });
	expect(readFileSync(join(cli.dir, "back")).equals(bytes)).toBe(true);
});

test("a forwarded port closes when its machine is removed", async ({ page }) => {
	await linkedLab(page);
	const port = await freePort();
	expect((await cli.once("forward", "node2", `${port}:80`)).code).toBe(0);
	expect((await cli.once("--yes", "rm", "node2")).code).toBe(0);
	await expect.poll(async () => (await cli.once("forward")).stdout).toBe("Nothing is forwarded.\n");
	await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});

test("the prompt completes with the lab's words, keeps its history, and Ctrl-C and Ctrl-D do what they do in a shell", async ({
	page,
}) => {
	await openWithTwoMachines(page);
	const session = cli.startInTerminal();
	await session.shows("Waiting for the lab");
	await page.evaluate((hash) => {
		location.hash = hash;
	}, `cli=${cli.port}`);
	await session.shows("Linked to the lab: node1");
	const next = () => session.printed.length;

	let at = next();
	await keys(session, "topo", "\t");
	await session.shows("topology ", 5000, at);
	session.press("\r");
	await session.shows("switch0", 5000, at);
	at = next();
	await keys(session, "ssh no", "\t", "\t");
	await session.shows(/node1\s+node2/, 5000, at);
	// The line is dropped, and the next is read whole.
	session.press("\x03");
	at = next();
	session.press("ls\r");
	await session.shows("2 machines · 2 ready", 5000, at);

	at = next();
	session.press("exec node1 -- sleep 60\r");
	await page.waitForTimeout(1500);
	session.press("\x03");
	await session.shows("unlab> ", 5000, at + 25);
	at = next();
	// The machine's own command was ended too, so its shell takes another.
	session.press("exec node1 -- echo free again\r");
	await session.shows(/\nfree again/, 10_000, at);

	// A shell in the same terminal, and back.
	at = next();
	session.press("ssh node2\r");
	await session.shows("⇒", 10_000, at);
	session.press("hostname; stty size\r");
	await session.shows(/node2[\s\S]*40 120/, 10_000, at);
	at = next();
	session.press("exit\r");
	await session.shows("unlab> ", 10_000, at);
	at = next();
	session.press("status\r");
	await session.shows("Linked to the lab: node1", 5000, at);
	session.press("\x04");
	expect(await session.exited).toBe(0);

	const again = cli.startInTerminal();
	await again.shows("Linked to the lab: node1");
	at = again.printed.length;
	await keys(again, "\x1b[A", "\x1b[A", "\x1b[A", "\r");
	await again.shows("free again", 10_000, at);
	again.press("\x04");
	await again.exited;
});

test("an agent uses the lab's tools while a CLI is linked", async ({ page }) => {
	await linkedLab(page);
	const listed = (await call(page, "machines_list", {})) as { result: string };
	expect(listed.result).toBe("2 machines · 2 ready · 512 MiB of memory");
	await typed(page, "ls");
	await expect(page.getByText("2 machines · 2 ready")).toBeVisible();
});
