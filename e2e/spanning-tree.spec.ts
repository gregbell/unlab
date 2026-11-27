import { appendFileSync, mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

interface ListedPort {
	readonly port: number;
	readonly cable: {
		readonly to: { readonly kind: string; readonly switch?: string; readonly port?: number };
		link: string;
	} | null;
	readonly stp?: { readonly role: string; readonly state: string };
}
interface Listed {
	readonly name: string;
	readonly ports: readonly ListedPort[];
	readonly storm?: { readonly rate: number; readonly dropped: number };
	readonly stp?: "on";
}
interface Row {
	readonly switch?: string;
	readonly in?: number;
	readonly out?: readonly number[];
	readonly looped?: true;
}

/** The longest that the protocol waits before it acts on a neighbour's silence: three hellos of two seconds. */
const THREE_HELLOS_MS = 6000;

async function openLab(page: Page): Promise<void> {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const panel = (page: Page) => page.locator("unlab-switch");
const chooser = (page: Page) => panel(page).getByRole("combobox", { name: "Switch" });

async function switches(page: Page): Promise<readonly Listed[]> {
	return ((await call(page, "topology_read", {})) as { data: { switches: Listed[] } }).data.switches;
}

/** The switches that storm. */
const storming = async (page: Page) => (await switches(page)).flatMap(({ name, storm }) => (storm ? [name] : []));

/** `wan:8 alternate discarding`, for each port that a cable to a switch is in and the spanning tree has. */
async function tree(page: Page): Promise<string[]> {
	return (await switches(page)).flatMap(({ name, ports }) =>
		ports.flatMap(({ port, cable, stp }) =>
			cable?.to.kind === "port" && stp ? [`${name}:${port} ${stp.role} ${stp.state}`] : [],
		),
	);
}

/** The ports that carry nothing, as `wan:8`. */
const blocked = async (page: Page) =>
	(await tree(page)).filter((port) => !port.endsWith(" forwarding")).map((port) => port.split(" ")[0]);

/** Where the cable in the port goes, as `lan:7`. */
async function farEnd(page: Page, at: string): Promise<string> {
	const [on, port] = at.split(":");
	const to = (await switches(page)).find(({ name }) => name === on)?.ports[Number(port) - 1].cable?.to;
	return `${to?.switch}:${to?.port}`;
}

const reaches = async (page: Page, machine: number, address: string) =>
	(await shell(page, machine, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

/** One ARP request for an address that nobody has, from the machine: a single broadcast. */
const askOnce = (page: Page, machine: number, address = "10.88.0.99") =>
	root(page, machine, `arping -c 1 -w 1 -I eth0 ${address}; true`);

/** Keeps what broadcasts the machine's eth0 hears, from now on. */
async function listen(page: Page, machine: number): Promise<void> {
	await root(page, machine, "tcpdump -lnnei eth0 ether broadcast > /tmp/heard 2> /tmp/said < /dev/null &");
	await root(page, machine, "for i in $(seq 100); do grep -q listening /tmp/said && exit 0; sleep 0.1; done; exit 1");
}

/** How many of the broadcasts that the machine has heard ask for the address. */
const heard = async (page: Page, machine: number, address: string) =>
	(await root(page, machine, "cat /tmp/heard")).split("\n").filter((line) => line.includes(`who-has ${address} `))
		.length;

async function read(page: Page, filter: string): Promise<readonly Row[]> {
	const reply = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows?: Row[]; error?: string };
	if (!reply.rows) throw new Error(`${filter}: ${reply.error}`);
	return reply.rows;
}

/** What a line that cannot run says, in the bar and from its tool. */
async function refused(page: Page, line: string, tool: string, input: object, sentence: string): Promise<void> {
	const said = `${sentence} Nothing was changed.`;
	expect(await call(page, tool, input), line).toEqual({ error: said });
	await typed(page, line);
	const alert = bar(page).getByRole("alert");
	await expect(alert, line).toBeVisible();
	expect((await alert.locator("p").allTextContents()).join(" "), line).toBe(said);
	await page.keyboard.press("Escape");
}

/** Adds a line to what the run measured, which the job keeps. */
function measured(line: string): void {
	mkdirSync("test-results", { recursive: true });
	appendFileSync("test-results/spanning-tree.txt", `${line}\n`);
	console.log(line);
}

/** node1 on switch0, node2 on lan and node3 on wan, and a cable from switch0 to lan and from lan to wan: a line. */
async function line(page: Page): Promise<void> {
	await openLab(page);
	for (const name of ["lan", "wan"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net lan --no-gateway");
	await typed(page, "spawn 1 lab --net wan --no-gateway");
	await ready(page, "3 of 3 ready");
	for (const cable of ["cable switch0:7 lan:8", "cable lan:7 wan:8"]) await typed(page, cable);
}

test("spanning tree is off on a new switch, where a loop storms: turned on, it ends the storm, blocks one port, lets a broadcast reach each machine once, and comes back with a reload", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("crash", () => errors.push("the page crashed"));
	await line(page);
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(await reaches(page, 2, "node1")).toBe(true);

	// A new switch takes no part, so the cable that closes the loop makes a storm, as it did before there was a tree.
	const fresh = await switches(page);
	expect(fresh.map(({ name, stp }) => [name, stp])).toEqual([
		["switch0", undefined],
		["lan", undefined],
		["wan", undefined],
	]);
	expect(fresh.flatMap(({ ports }) => ports).some((port) => "stp" in port)).toBe(false);
	expect(await call(page, "switch_cable", { from: "wan:7", to: "switch0:8" })).toMatchObject({ data: { loop: true } });
	await askOnce(page, 1);
	await expect.poll(() => storming(page), { timeout: 5000 }).toEqual(["switch0", "lan", "wan"]);

	// One line turns it on for every switch, and the storm is over.
	await typed(page, "stp on all");
	const onAt = Date.now();
	await expect.poll(() => storming(page), { timeout: 2000, intervals: [20] }).toEqual([]);
	measured(`a storm in a triangle was over ${Date.now() - onAt} ms after stp on all was typed`);
	expect((await switches(page)).map(({ stp }) => stp)).toEqual(["on", "on", "on"]);

	// Of the six ports that the three cables are in, one carries nothing.
	const ports = await tree(page);
	expect(ports).toHaveLength(6);
	const out = ports.filter((port) => !port.endsWith(" forwarding"));
	expect(out).toEqual([expect.stringMatching(/^(switch0|lan|wan):[78] alternate discarding$/)]);
	const [at] = await blocked(page);
	const [on, no] = at.split(":");
	await typed(page, "topology");
	const report = bar(page).locator(".result");
	await expect(report.locator(".header")).toHaveText("3 switches · 9 of 24 ports taken · 1 port blocked");
	const lines = (await report.locator("dd").allInnerTexts()).map((text) => text.split("\n"));
	expect(lines.map(([first]) => first.split(" · ")[0])).toEqual([
		"spanning tree on",
		"spanning tree on",
		"spanning tree on",
	]);
	expect(lines.flat().filter((text) => text.endsWith(" · blocked"))).toEqual([
		`port ${no} · ${await farEnd(page, at)} · up · alternate port · blocked`,
	]);
	await page.keyboard.press("Escape");
	await chooser(page).selectOption(on);
	const column = panel(page).locator(`[data-port="${no}"]`);
	await expect(column.locator(".nic")).toContainText("blocked");
	await expect(column).toHaveAttribute("title", /blocked by spanning tree/);
	await expect(column.locator(".word")).toHaveText("up");

	// One broadcast now reaches each machine once, and is carried once by each switch.
	for (const machine of [2, 3]) await listen(page, machine);
	expect(await askOnce(page, 1, "10.88.0.98")).toContain("Sent 1 probe");
	await expect.poll(() => heard(page, 2, "10.88.0.98")).toBe(1);
	await page.waitForTimeout(500);
	expect([await heard(page, 2, "10.88.0.98"), await heard(page, 3, "10.88.0.98")]).toEqual([1, 1]);
	const rows = await read(page, "arp 10.88.0.98");
	expect(rows.map((row) => [row.switch, Boolean(row.looped)]).sort()).toEqual([
		["lan", false],
		["switch0", false],
		["wan", false],
	]);
	expect(await storming(page)).toEqual([]);
	for (const [from, to] of [
		[1, "node2"],
		[2, "node3"],
		[3, "node1"],
	] as const) {
		expect(await reaches(page, from, to), `node${from} to ${to}`).toBe(true);
	}

	// What cannot run says so in one sentence, the same in the bar and from the tool.
	await refused(
		page,
		"stp on dmz",
		"switch_stp",
		{ stp: "on", switches: "dmz" },
		"No switch is called dmz, so use switch0, lan, wan or all.",
	);
	await refused(page, "stp up all", "switch_stp", { stp: "up", switches: "all" }, "stp wants on or off here, not up.");

	// A reload brings the setting back, the same port is blocked, and the loop does not storm.
	await page.reload();
	await ready(page, "3 of 3 ready");
	expect((await switches(page)).map(({ stp }) => stp)).toEqual(["on", "on", "on"]);
	await expect.poll(() => blocked(page), { timeout: 10_000 }).toEqual([at]);
	await askOnce(page, 1, "10.88.0.97");
	await page.waitForTimeout(500);
	expect(await storming(page)).toEqual([]);
	expect((await read(page, "arp 10.88.0.97")).map((row) => row.switch).sort()).toEqual(["lan", "switch0", "wan"]);
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(errors).toEqual([]);
});

test("cutting a cable in use brings the blocked port into use and pings resume, and a cable to a switch with spanning tree off still makes a loop that storms", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("crash", () => errors.push("the page crashed"));
	await line(page);
	// With it on before the loop is closed, the lab never storms.
	expect(await call(page, "switch_stp", { stp: "on", switches: "all" })).toEqual({
		result: "spanning tree on for switch0, lan and wan",
		data: { stp: "on", switches: ["switch0", "lan", "wan"], already: [] },
	});
	await typed(page, "cable wan:7 switch0:8");
	await expect.poll(() => blocked(page)).toHaveLength(1);
	await askOnce(page, 1);
	await page.waitForTimeout(500);
	expect(await storming(page)).toEqual([]);
	for (const [from, to] of [
		[1, "node2"],
		[2, "node3"],
		[3, "node1"],
	] as const) {
		expect(await reaches(page, from, to), `node${from} to ${to}`).toBe(true);
	}

	// The blocked port's switch reaches the others by its other cable. That one is cut.
	const [spare] = await blocked(page);
	const [on] = spare.split(":");
	const inUse = (await tree(page)).find((port) => port.startsWith(`${on}:`) && port.endsWith(" root forwarding"));
	if (!inUse) throw new Error(`${on} has no root port`);
	const [cut] = inUse.split(" ");
	const machines = { switch0: 1, lan: 2, wan: 3 } as const;
	const from = machines[on as keyof typeof machines];
	const far = (await farEnd(page, cut)).split(":")[0] as keyof typeof machines;
	await call(page, "link_set", { link: "down", machines: cut });
	const cutAt = Date.now();
	// The first ping after the cut is answered: the way round was in use before it was sent.
	expect(await reaches(page, from, `node${machines[far]}`)).toBe(true);
	const resumed = Date.now() - cutAt;
	measured(`a ping from ${on} to ${far} was answered ${resumed} ms after the cable at ${cut} was cut`);
	expect(resumed).toBeLessThan(THREE_HELLOS_MS);
	expect(await tree(page)).toContain(`${spare} root forwarding`);
	expect(await blocked(page)).toEqual([]);
	for (const [a, b] of [
		[1, "node2"],
		[2, "node3"],
		[3, "node1"],
	] as const) {
		expect(await reaches(page, a, b), `node${a} to ${b}`).toBe(true);
	}

	// Reconnected, the loop is whole again and one port is blocked, with no storm.
	await typed(page, `link up ${cut}`);
	await expect.poll(() => blocked(page)).toEqual([spare]);
	expect(await storming(page)).toEqual([]);

	// wan stops taking part, and its cable to switch0 is taken out and put in again: a cable to a switch with it off.
	expect(await call(page, "switch_stp", { stp: "off", switches: "wan" })).toMatchObject({
		result: "spanning tree off for wan",
	});
	expect((await switches(page)).map(({ name, stp }) => [name, stp])).toEqual([
		["switch0", "on"],
		["lan", "on"],
		["wan", undefined],
	]);
	await typed(page, "uncable wan:7");
	await expect.poll(async () => (await switches(page))[2].ports[6].cable).toBeNull();
	expect(await call(page, "switch_cable", { from: "wan:7", to: "switch0:8" })).toMatchObject({
		result: "cabled wan:7 to switch0:8 · closes a loop",
		data: { loop: true },
	});
	// switch0 and lan hear nothing through wan, so neither sees the loop. Each takes its port towards wan into use once
	// what it had heard there has run out, and then the next broadcast goes round.
	const closedAt = Date.now();
	await expect
		.poll(
			async () => {
				await askOnce(page, 1);
				return storming(page);
			},
			{ timeout: 30_000, intervals: [1000] },
		)
		.toEqual(["switch0", "lan", "wan"]);
	measured(
		`a loop through a switch with spanning tree off stormed ${Date.now() - closedAt} ms after its cable went in`,
	);
	expect((await tree(page)).every((port) => port.endsWith(" forwarding"))).toBe(true);

	// With it on for wan again, the storm ends.
	await typed(page, "stp on wan");
	await expect.poll(() => storming(page), { timeout: 3000, intervals: [50] }).toEqual([]);
	await expect.poll(() => blocked(page)).toHaveLength(1);
	expect(await reaches(page, 2, "node1")).toBe(true);
	expect(errors).toEqual([]);
});

/** The state of each line drawn between the two switches, in the order they are drawn in. */
async function wires(topology: Locator, a: string, b: string): Promise<string[]> {
	const centre = async (name: string) => {
		const box = await topology.locator(`.n-node[data-switch="${name}"] .n-tile`).boundingBox();
		if (!box) throw new Error(`${name} is not drawn`);
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	};
	const p = await centre(a);
	const q = await centre(b);
	// Two cables between one pair of switches are drawn side by side, a few pixels apart.
	const near = (u: number, v: number) => Math.abs(u - v) < 10;
	const states: string[] = [];
	for (const path of await topology.locator(".wire").all()) {
		const box = await path.boundingBox();
		if (
			box &&
			near(box.x, Math.min(p.x, q.x)) &&
			near(box.x + box.width, Math.max(p.x, q.x)) &&
			near(box.y, Math.min(p.y, q.y)) &&
			near(box.y + box.height, Math.max(p.y, q.y))
		)
			states.push((await path.getAttribute("data-state")) ?? "");
	}
	return states;
}

test("the desktop says which port the spanning tree has blocked, where it shows the port, and follows a cut", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Welcome to unLAB" })).toBeVisible();
	// Two cables between two switches are a loop. The machine is there for the desktop to open its windows.
	for (const typedLine of ["mkswitch lan", "cable switch0:1 lan:1", "cable switch0:2 lan:2"])
		await typed(page, typedLine);
	await typed(page, "spawn 1 alpine --no-gateway");
	const topology = page.getByRole("region", { name: "Topology" });
	const rack = page.getByRole("region", { name: "Rack manager" });
	await expect(rack.locator('[data-switch="switch0"] .dt-port-block').nth(2)).toHaveAttribute("data-state", "up", {
		timeout: 90_000,
	});
	await expect.poll(() => wires(topology, "switch0", "lan")).toEqual(["up", "up"]);
	const notes = await topology.locator(".n-node small").allTextContents();

	await typed(page, "stp on all");
	await expect.poll(async () => (await wires(topology, "switch0", "lan")).sort()).toEqual(["blocked", "up"]);
	const [at] = await blocked(page);
	const [on, no] = at.split(":");
	const other = on === "lan" ? "switch0" : "lan";
	const said = new RegExp(`^Port ${no} · to ${other} port ${no} · up · blocked$`, "m");
	await expect(topology.locator(`[data-switch="${on}"]`)).toHaveAttribute("title", said);
	await expect(topology.getByRole("button", { name: `Inspect switch ${on}` })).toHaveAccessibleDescription(
		new RegExp(`Port ${no} · to ${other} port ${no} · up · blocked`),
	);
	await expect(topology.locator(`[data-switch="${other}"]`)).not.toHaveAttribute("title", /blocked/);
	// The map is drawn as it was: each node's note says what it said.
	expect(await topology.locator(".n-node small").allTextContents()).toEqual(notes);

	const inspect = rack.getByRole("button", { name: `Inspect ${on}` });
	await expect(inspect).toHaveAccessibleDescription(new RegExp(`Port ${no} · to ${other} port ${no} · up · blocked`));
	await inspect.click();
	const details = page.getByRole("region", { name: `${on} · Switch details` });
	const term = details.locator("dt", { hasText: "Spanning tree" });
	await expect(term).toBeVisible();
	const row = (port: string) =>
		details.getByRole("row").filter({ has: page.getByRole("rowheader", { name: port, exact: true }) });
	await expect(row(no).getByRole("cell", { name: "up · blocked", exact: true })).toBeVisible();
	const inUse = no === "1" ? "2" : "1";
	await expect(row(inUse).getByRole("cell", { name: "up", exact: true })).toBeVisible();

	// The cable in use is cut from its port, and the blocked one takes over.
	await row(inUse).getByRole("button", { name: "Cut cable" }).click();
	await expect(row(no).getByRole("cell", { name: "up", exact: true })).toBeVisible();
	await expect.poll(async () => (await wires(topology, "switch0", "lan")).sort()).toEqual(["cut", "up"]);
	await expect(topology.locator(`[data-switch="${on}"]`)).not.toHaveAttribute("title", /blocked/);

	await typed(page, "stp off all");
	await expect(term).toHaveCount(0);
	expect(errors).toEqual([]);
});
