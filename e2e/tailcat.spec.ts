import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

const relayBinary = process.env.TAILCAT_TEST_RELAY;
test.use({ ignoreHTTPSErrors: Boolean(relayBinary) });

let keyDirectory: string;
test.beforeEach(async () => {
	keyDirectory = await mkdtemp(join(tmpdir(), "unlab-share-ssh-"));
});
test.afterEach(async () => {
	await rm(keyDirectory, { recursive: true, force: true });
});

test("a remote SSH client reaches only the selected guest with the shared key", async ({ page, context }) => {
	const client = process.env.TAILCAT_BIN;
	test.skip(!client, "Set TAILCAT_BIN to run the live Tailcat relay test.");
	if (!client) return;
	test.setTimeout(150_000);

	let mapURL: string | undefined;
	const relay = relayBinary ? spawn(relayBinary, [], { stdio: ["pipe", "pipe", "inherit"] }) : undefined;
	try {
		if (relay) {
			const lines = createInterface({ input: relay.stdout });
			const first = await lines[Symbol.asyncIterator]().next();
			if (first.done) throw new Error("The test relay did not start.");
			mapURL = first.value;
			const response = await fetch(first.value);
			const map = await response.text();
			await context.route("https://tailcat.dev/derpmap.json", (route) =>
				route.fulfill({
					contentType: "application/json",
					body: map,
					headers: { "access-control-allow-origin": "*" },
				}),
			);
		}
		const identity = join(keyDirectory, "identity");
		const stranger = join(keyDirectory, "stranger");
		for (const file of [identity, stranger]) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);

		await page.goto("/");
		await page.getByRole("button", { name: "Boot 2 machines" }).click();
		await page.getByRole("button", { name: "Configure node2" }).click();
		const settings = page.getByRole("region", { name: "Share node2 via SSH" });
		await settings.getByRole("button", { name: "Share via SSH" }).click();
		await settings.getByRole("textbox").fill(await readFile(`${identity}.pub`, "utf8"));
		await settings.getByRole("button", { name: "Start sharing" }).click();
		const copy = settings.getByRole("button", { name: "Copy command" });
		const failure = settings.getByRole("alert");
		await expect(copy.or(failure)).toBeVisible({ timeout: 60_000 });
		if (await failure.isVisible()) throw new Error((await failure.textContent()) ?? "Could not start SSH sharing.");
		const command = (await settings.locator("code").textContent()) ?? "";
		expect(command).toMatch(/^tailcat ssh user@tc[A-Za-z0-9_-]+$/);
		const destination = command.slice("tailcat ssh ".length);
		const ssh = (key: string, script: string) =>
			run(
				client,
				["--key=new", ...(mapURL ? [`--derpmap-url=${mapURL}`] : []), "ssh", "-i", key, destination, script],
				{
					timeout: 25_000,
					env: { ...process.env, SSH_AUTH_SOCK: "", XDG_CONFIG_HOME: join(keyDirectory, "config") },
				},
			);

		await expect(ssh(stranger, "true")).rejects.toMatchObject({ stderr: expect.stringContaining("Permission denied") });
		const { stdout } = await ssh(identity, "hostname; id -un");
		expect(stdout).toBe("node2\nuser\n");
		const session = ssh(identity, "echo connected; exec sleep 60");
		const exit = session.then(
			() => 0,
			(error: { code: number | string; killed?: boolean }) => (error.killed ? "timed out" : error.code),
		);
		const stream = session.child.stdout;
		if (!stream) throw new Error("SSH client has no output stream.");
		const lines = createInterface({ input: stream });
		expect((await lines[Symbol.asyncIterator]().next()).value).toBe("connected");
		await settings.getByRole("button", { name: "Stop sharing" }).click();
		await expect(exit).resolves.toBe(255);
		await expect(settings.getByRole("button", { name: "Start sharing" })).toBeVisible();
	} finally {
		relay?.stdin.end();
	}
});
