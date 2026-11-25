// Real machines that reach the internet through the CLI. The internet here is
// servers on this computer, which --lan lets a machine reach.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createTcp } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PORTS } from "../../src/model/types.ts";
import { freePort, linkMachines, type Session, TestCli, type TestPage } from "../support/cli.ts";
import { bootLab, type MachineSetup, type TestLab } from "./lab.ts";

const MIB = 2 ** 20;
const big = randomBytes(100 * MIB);
const small = randomBytes(5 * MIB);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** An address of this computer that a guest can be told of, as it would be of a host out there. */
function ownAddress(): string {
	const found = Object.values(networkInterfaces())
		.flatMap((all) => all ?? [])
		.find((one) => one.family === "IPv4" && !one.internal);
	if (!found) throw new Error("This test needs a network address on this computer.");
	return found.address;
}

let host: string;
let port: number;
let web: Server;
let cli: TestCli;
let session: Session;
let lab: TestLab;
let page: TestPage;

const MACHINES: readonly MachineSetup[] = [
	...PORTS.map((port) => ({ n: port, ports: [port], gateway: "packages" as const })),
	{ n: 9, ports: [null], gateway: false },
];

const link = (to: TestCli) =>
	linkMachines(
		to,
		lab.machines.map((machine, i) => ({ machine, n: i + 1, image: "alpine" })),
	);

async function within(ms: number, check: () => Promise<boolean>): Promise<void> {
	const until = performance.now() + ms;
	while (!(await check())) {
		if (performance.now() > until) throw new Error(`Not within ${ms} ms.`);
	}
}

const answers = async (n: number, url = `http://${host}:${port}/hello`) =>
	(await lab.machines[n - 1].exec(`wget -T 3 -qO- ${url}`)).stdout === "hello\n";

beforeAll(async () => {
	host = ownAddress();
	web = createServer((request, response) => {
		if (request.url === "/big") response.end(big);
		else if (request.url === "/small") response.end(small);
		else response.end("hello\n");
	});
	await new Promise<void>((resolve) => web.listen(0, "0.0.0.0", resolve));
	const address = web.address();
	port = typeof address === "object" && address ? address.port : 0;
	lab = await bootLab(MACHINES);
	cli = new TestCli(await freePort(), { args: ["--lan", "--log"] });
	session = cli.start();
	await session.shows("Machines may reach this computer and its local network.");
});

afterAll(async () => {
	page?.close();
	await lab?.stop();
	cli?.close();
	web?.close();
});

test("a running machine reaches nothing before the CLI links, and the internet within five seconds of it", async () => {
	expect(await answers(1)).toBe(false);
	page = await link(cli);
	await within(5000, () => answers(1));
});

test("a machine looks a name up, and one that is none is not found", async () => {
	expect(await lab.machines[0].run("nslookup -type=a localhost")).toContain("127.0.0.1");
	const none = await lab.machines[0].exec("nslookup -type=a no-such-name.invalid");
	expect(none.stdout + none.stderr).toContain("NXDOMAIN");
});

test("a machine without a gateway gets none", async () => {
	expect(await answers(9)).toBe(false);
});

test("100 MiB arrive whole", async () => {
	const t0 = performance.now();
	const got = await lab.machines[0].run(`wget -qO- http://${host}:${port}/big | sha256sum`);
	const seconds = (performance.now() - t0) / 1000;
	console.log(`100 MiB through the relay: ${(100 / seconds).toFixed(1)} MiB/s`);
	expect(got).toContain(sha256(big));
});

test("eight machines download at once, and each finishes", async () => {
	const got = await Promise.all(
		lab.machines.slice(0, 8).map((m) => m.run(`wget -qO- http://${host}:${port}/small | sha256sum`)),
	);
	for (const line of got) expect(line).toContain(sha256(small));
});

test("an upload arrives whole, and either side can stop sending first", async () => {
	const arrived: Buffer[] = [];
	const server = createTcp({ allowHalfOpen: true }, (socket) => {
		socket.on("data", (bytes: Buffer) => arrived.push(bytes));
		// Answers only once the machine has ended its side.
		socket.on("end", () => socket.end(sha256(Buffer.concat(arrived))));
	});
	await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
	const address = server.address();
	const at = typeof address === "object" && address ? address.port : 0;
	const machine = lab.machines[0];
	const got = await machine.run(
		`dd if=/dev/urandom of=/tmp/up bs=1M count=5 2>/dev/null; sha256sum /tmp/up | cut -c1-64; nc ${host} ${at} < /tmp/up`,
	);
	const [there, back] = got.trim().split("\n");
	expect(back).toBe(there);
	server.close();
});

test("a closed port is refused", async () => {
	const closed = await freePort();
	const machine = lab.machines[0];
	const refused = async (to: string) => (await machine.exec(`wget -T 5 -qO- http://${to}/`)).stderr;
	expect(await refused(`${host}:${closed}`)).toContain("Connection refused");
});

test("status and --log say what is open, by machine", async () => {
	const held = createTcp({ allowHalfOpen: true }, (socket) => socket.write("x"));
	await new Promise<void>((resolve) => held.listen(0, "0.0.0.0", resolve));
	const address = held.address();
	const at = typeof address === "object" && address ? address.port : 0;
	const open = lab.machines[1].exec(`timeout 4 nc ${host} ${at}`);
	await session.shows(`node2 → ${host}:${at}`);
	const status = await cli.once("status");
	expect(status.stdout).toContain(`node2 → ${host}:${at}  0 B out, 1 B in`);
	await open;
	held.close();
});

test("it ends within five seconds of the CLI quitting, and a link from another CLI brings it back", async () => {
	session.child.kill("SIGKILL");
	await session.exited;
	await within(5000, async () => !(await answers(1)));
	page.close();

	// One that does not let machines reach this computer.
	const strict = new TestCli(await freePort());
	const next = strict.start();
	await next.shows("Waiting for the lab");
	page = await link(strict);
	await next.shows("Linked to the lab");
	const machine = lab.machines[0];
	const tried = async (to: string) => (await machine.exec(`wget -T 5 -qO- http://${to}/`)).stderr;
	for (const address of [host, "127.0.0.2", "192.168.0.1", "169.254.169.254", "100.64.0.1", "10.99.0.1"]) {
		await within(5000, async () => (await tried(`${address}:${port}`)).includes("Connection refused"));
	}
	// A name for such an address is refused as the address is.
	expect((await machine.run(`nslookup -type=a ${hostname()}`)).split("Name:")[1]).toContain("Address");
	expect(await tried(`${hostname()}:${port}`)).toContain("Connection refused");
	strict.close();
});
