// The link while the lab's tab is hidden, as it is behind a terminal. A page
// that Playwright drives is never hidden, so this starts Chromium itself.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { buildCli, freePort, TestCli } from "../test/support/cli.ts";

const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 4173}`;
/**
 * A browser holds a hidden page's timers to one a minute after five minutes.
 * Here it does after ten seconds, so that half a minute shows what ten would.
 * HIDDEN_MINUTES waits as long as it says, at the browser's own pace.
 */
const MINUTES = Number(process.env.HIDDEN_MINUTES ?? 0);
const FEATURES = MINUTES > 0 ? "WebMCP" : "WebMCP,IntensiveWakeUpThrottling:grace_period_seconds/10";

interface Target {
	readonly type: string;
	readonly url: string;
	readonly webSocketDebuggerUrl: string;
}

class Browser {
	readonly #profile = mkdtempSync(join(tmpdir(), "unlab-hidden-"));
	readonly #child: ChildProcess;
	readonly #cdp: Promise<string>;

	constructor(url: string) {
		const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.#profile}`];
		this.#child = spawn(
			chromiumExecutable() ?? chromium.executablePath(),
			[...args, "--no-first-run", "--no-sandbox", `--enable-features=${FEATURES}`, url],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		this.#cdp = new Promise((resolve, reject) => {
			let printed = "";
			this.#child.stderr?.on("data", (text) => {
				printed += text;
				const match = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(printed);
				if (match) resolve(`http://127.0.0.1:${match[1]}`);
			});
			this.#child.once("exit", () => reject(new Error(printed)));
		});
	}

	/** Puts another tab in front, as a person does. */
	async hide(): Promise<void> {
		await fetch(`${await this.#cdp}/json/new?${ORIGIN}/ssh/manifest.json`, { method: "PUT" });
	}

	/** Asked over a connection of its own, which is closed again: one that stays open can change what is measured. */
	async visibility(): Promise<string> {
		const targets = (await (await fetch(`${await this.#cdp}/json`)).json()) as Target[];
		const lab = targets.find(({ type, url }) => type === "page" && /^\/(#.*)?$/.test(url.replace(ORIGIN, "")));
		if (!lab) throw new Error("the lab's tab is gone");
		const socket = new WebSocket(lab.webSocketDebuggerUrl);
		await new Promise((resolve) => socket.addEventListener("open", resolve));
		const said = new Promise<string>((resolve) => {
			socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)).result.result.value));
		});
		const params = { expression: "document.visibilityState" };
		socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params }));
		const visibility = await said;
		socket.close();
		return visibility;
	}

	async close(): Promise<void> {
		this.#child.kill();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		rmSync(this.#profile, { recursive: true, force: true, maxRetries: 5 });
	}
}

/** How long each of `n` keys takes to come back from the guest's terminal. */
async function echoes(cli: TestCli, n: number): Promise<number[]> {
	const args = ["-tt", "-F", join(cli.dir, "person_config"), "node1.unlab", "stty -icanon; echo started; cat"];
	const ssh = spawn("ssh", args, { stdio: ["pipe", "pipe", "ignore"] });
	let printed = "";
	ssh.stdout.on("data", (text) => {
		printed += text;
	});
	const until = async (there: () => boolean) => {
		const late = performance.now() + 20_000;
		while (!there()) {
			if (performance.now() > late) throw new Error(`The guest's terminal printed only: ${printed}`);
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
	};
	await until(() => printed.includes("started"));
	const took: number[] = [];
	for (let i = 0; i < n; i++) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		const before = printed.length;
		const t0 = performance.now();
		ssh.stdin.write(String.fromCharCode(97 + (i % 26)));
		await until(() => printed.length > before);
		took.push(performance.now() - t0);
	}
	ssh.kill();
	return took;
}

let cleanUp = async () => {};
test.afterEach(() => cleanUp());

test("a lab behind other windows answers the CLI and SSH as one in front does", async () => {
	test.setTimeout((MINUTES + 3) * 60_000);
	await buildCli();
	const cli = new TestCli(await freePort(), { origin: ORIGIN });
	const session = cli.start();
	const browser = new Browser(`${ORIGIN}/#cli=${cli.port}`);
	// A test that takes too long is stopped before its own end, and the browser would stay.
	cleanUp = async () => {
		await browser.close();
		cli.close();
	};
	await session.shows("Linked to the lab", 30_000);
	session.type("spawn 1 alpine");
	await session.shows("node1 is ready.", 60_000);
	expect((await cli.ssh("node1.unlab", "true")).code).toBe(0);
	expect(await browser.visibility()).toBe("visible");
	await browser.hide();
	await expect.poll(() => browser.visibility()).toBe("hidden");
	await new Promise((resolve) => setTimeout(resolve, MINUTES > 0 ? MINUTES * 60_000 : 30_000));
	expect(await browser.visibility()).toBe("hidden");

	const commands: number[] = [];
	for (let i = 0; i < 5; i++) {
		const t0 = performance.now();
		expect(await cli.once("exec", "node1", "--", "echo here")).toMatchObject({ code: 0, stdout: "here\n" });
		commands.push(performance.now() - t0);
	}
	const keys = await echoes(cli, 30);
	const worst = (all: number[]) => Math.max(...all).toFixed(0);
	console.log(`hidden: a command took at most ${worst(commands)} ms, a key at most ${worst(keys)} ms`);
	expect(Math.max(...commands)).toBeLessThan(1000);
	expect(Math.max(...keys)).toBeLessThan(100);

	// A CLI that starts while the lab is hidden is found too.
	session.child.kill("SIGTERM");
	await session.exited;
	const t0 = performance.now();
	const again = cli.start();
	await again.shows("Linked to the lab: node1 (alpine)");
	console.log(`hidden: a new CLI was linked in ${(performance.now() - t0).toFixed(0)} ms`);
	expect(performance.now() - t0).toBeLessThan(3000);
	expect(await browser.visibility()).toBe("hidden");
});
