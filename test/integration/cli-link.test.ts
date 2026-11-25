// Who the CLI talks to, and what it keeps: no machine is needed for these.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { LINK_PORT, PROTOCOL } from "../../src/streams/index.ts";
import { freePort, type Session, TestCli, TestPage } from "../support/cli.ts";

let cli: TestCli;
let session: Session;
beforeEach(async () => {
	cli = new TestCli(await freePort());
	session = cli.start();
	await session.shows("Waiting for the lab");
});
afterEach(() => cli.close());

/** How a WebSocket to the CLI ends when it is not taken. */
function refusal(url: string, origin?: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url, origin === undefined ? {} : { origin });
		socket.on("error", (error) => resolve(error.message));
		socket.on("open", () => resolve("open"));
	});
}

test("only the lab's own pages are taken", async () => {
	for (const origin of ["https://unlab.run.example", "http://unlab.run", "https://example.org", "null", undefined]) {
		expect(await refusal(`${cli.url}/lab`, origin), String(origin)).toContain("403");
	}
	expect(await refusal(`${cli.url}/lab`, "https://unlab.run")).toBe("open");
});

test("a machine's channel needs the token that the lab was given", async () => {
	const at = (token: string) => `${cli.url}/machine?token=${token}&n=1&name=node1`;
	expect(await refusal(at(""), "https://unlab.run")).toContain("403");
	const page = new TestPage(cli.url);
	const token = await page.linked;
	page.machines([{ n: 1, name: "node1", image: "alpine", state: "ready" }]);
	await session.shows("Linked to the lab: node1 (alpine)");
	expect(await refusal(at("guess"), "https://unlab.run")).toContain("403");
	expect(await refusal(at(token), "https://example.org")).toContain("403");
	expect(await refusal(at(token), "https://unlab.run")).toBe("open");
	page.close();
});

test("it listens on this computer alone", async () => {
	const addresses = Object.values(networkInterfaces())
		.flatMap((all) => all ?? [])
		.filter((one) => one.family === "IPv4" && !one.internal);
	for (const { address } of addresses) {
		expect(await refusal(`ws://${address}:${cli.port}/lab`, "https://unlab.run")).toContain("ECONNREFUSED");
	}
});

test("a lab of another version is told which to update, and nothing else happens", async () => {
	const older = new TestPage(cli.url, { protocol: PROTOCOL - 1 });
	expect(await older.refused).toBe("The lab open in the browser is older than this CLI, so reload the lab.");
	await session.shows("reload the lab");
	const newer = new TestPage(cli.url, { protocol: PROTOCOL + 1 });
	expect(await newer.refused).toBe("This CLI is older than the lab, so update it with: npx unlab.run@latest");
	expect((await cli.once("status")).stdout).toContain("The lab is not linked.");
});

test("the port is one that no outgoing connection is given", () => {
	// Linux starts at 32768 and macOS at 49152.
	expect(LINK_PORT).toBeGreaterThan(1024);
	expect(LINK_PORT).toBeLessThan(32768);
});

test("a second lab is refused while the first is there, said once however often it comes, and taken once the first has gone", async () => {
	const first = new TestPage(cli.url);
	await first.linked;
	for (let i = 0; i < 3; i++) {
		const second = new TestPage(cli.url);
		expect(await second.refused).toContain("Another lab is linked to this CLI.");
	}
	await session.shows("Another lab is linked");
	expect(session.printed.split("Another lab is linked").length - 1).toBe(1);
	first.close();
	await expect
		.poll(
			() =>
				new Promise((resolve) => {
					const again = new TestPage(cli.url);
					void again.linked.then(() => resolve("linked"));
					void again.refused.then(() => resolve("refused"));
				}),
		)
		.toBe("linked");
});

test("a command without a lab gives up in a sentence, and says at once why a lab that came cannot be used", async () => {
	expect(await cli.once("--wait", "1", "ls")).toMatchObject({
		code: 1,
		stdout: "",
		stderr: expect.stringContaining("The lab is not linked. Open it in the browser"),
	});
	const asked = cli.once("--wait", "60", "ls");
	await new Promise((resolve) => setTimeout(resolve, 500));
	const newer = new TestPage(cli.url, { protocol: PROTOCOL + 1 });
	await newer.refused;
	expect(await asked).toMatchObject({ code: 1, stderr: expect.stringContaining("npx unlab.run@latest") });

	// With no CLI running it is the same, from one of its own.
	session.child.kill("SIGTERM");
	await session.exited;
	expect(await cli.once("--wait", "1", "ls")).toMatchObject({
		code: 1,
		stderr: expect.stringContaining("The lab is not linked."),
	});
	session = cli.start();
	await session.shows("Waiting for the lab");

	const impatient = await cli.run(process.execPath, [join(cli.dir, "cli.mjs"), "proxy", "node1.unlab"]);
	expect(impatient).toMatchObject({ code: 1, stderr: expect.stringContaining("The lab is not linked.") });
});

test("its keys are its own, and only its person can read them", async () => {
	for (const file of ["client.pem", "host.pem", "id_ed25519", "known_hosts", "ssh_config"]) {
		expect(statSync(join(cli.dir, file)).mode & 0o777, file).toBe(0o600);
	}
	expect(statSync(cli.dir).mode & 0o777).toBe(0o700);
	const config = readFileSync(join(cli.dir, "ssh_config"), "utf8");
	expect(config).not.toContain("/.ssh/");
	const before = readFileSync(join(cli.dir, "id_ed25519"), "utf8");
	session.child.kill("SIGTERM");
	await session.exited;
	expect(existsSync(join(cli.dir, "cli.sock"))).toBe(false);
	const again = cli.start();
	await again.shows("Waiting for the lab");
	expect(readFileSync(join(cli.dir, "id_ed25519"), "utf8")).toBe(before);
	// ssh-keygen reads what the CLI wrote, so ssh does.
	const read = await cli.run("ssh-keygen", ["-y", "-P", "", "-f", join(cli.dir, "id_ed25519")]);
	expect(read.stdout).toMatch(/^ssh-ed25519 /);
});

test("ssh-config prints the line, and edits nothing", async () => {
	const printed = await cli.once("ssh-config");
	expect(printed).toMatchObject({ code: 0, stdout: `Include ${join(cli.dir, "ssh_config")}\n` });
});

test("a CLI that was killed leaves nothing in the way of the next", async () => {
	session.child.kill("SIGKILL");
	await session.exited;
	expect(existsSync(join(cli.dir, "cli.sock"))).toBe(true);
	const again = cli.start();
	await again.shows("Waiting for the lab");
});

test("a port that another program has is said", async () => {
	const port = await freePort();
	const server = createServer().listen(port, "127.0.0.1");
	const other = new TestCli(port);
	expect(await other.once("status")).toMatchObject({
		code: 1,
		stderr: `Another program has port ${port}. Quit it, or choose another with --port.\n`,
	});
	other.close();
	server.close();
});

test("what it cannot read is said, with a status of its own", async () => {
	expect(await cli.once("--nonsense")).toMatchObject({
		code: 2,
		stderr: "There is no option --nonsense. See --help.\n",
	});
	expect((await cli.once("--help")).stdout).toContain("ssh <machine>");
});
