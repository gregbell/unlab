import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, shell, typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

/** When set, the tests also save screenshots of cabled switches there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

interface End {
	readonly kind: "nic" | "port";
	readonly machine?: string;
	readonly nic?: string;
	readonly switch?: string;
	readonly port?: number;
}
interface Listed {
	readonly name: string;
	readonly ports: readonly { readonly port: number; readonly cable: { to: End; link: string } | null }[];
	readonly storm?: { readonly rate: number; readonly dropped: number };
}
interface Topology {
	readonly switches: readonly Listed[];
}
interface Row {
	readonly seq: number;
	readonly switch?: string;
	readonly in?: number;
	readonly out?: readonly number[];
	readonly proto: string;
	readonly from: { readonly name?: string };
	readonly len: number;
	readonly info: string;
	readonly note: string | null;
	readonly looped?: true;
}

async function openLab(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const panel = (page: Page) => page.locator("unlab-switch");
const chooser = (page: Page) => panel(page).getByRole("combobox", { name: "Switch" });
const dock = (page: Page) => page.locator("unlab-capture[mode=dock]");
const full = (page: Page) => page.locator("unlab-capture[mode=full]");

async function topology(page: Page): Promise<Topology> {
	return ((await call(page, "topology_read", {})) as { data: Topology }).data;
}

/** `lan: 1 node2:eth0 up, 8 switch0:3 cut` for each switch. */
async function wiring(page: Page): Promise<string[]> {
	const { switches } = await topology(page);
	return switches.map(({ name, ports }) => {
		const held = ports.flatMap(({ port, cable }) => {
			if (!cable) return [];
			const to =
				cable.to.kind === "port" ? `${cable.to.switch}:${cable.to.port}` : `${cable.to.machine}:${cable.to.nic}`;
			return [`${port} ${to} ${cable.link}`];
		});
		return `${name}: ${held.join(", ")}`;
	});
}

/** The switches that storm, with what the lab says of each. */
async function storms(page: Page): Promise<Record<string, { rate: number; dropped: number }>> {
	const { switches } = await topology(page);
	return Object.fromEntries(switches.flatMap(({ name, storm }) => (storm ? [[name, storm]] : [])));
}

const reaches = async (page: Page, machine: number | string, address: string) =>
	(await shell(page, machine, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

/** `node2 at 3`, with `flushed` after it, for each address that the switch has learned. The switch panel is maximised. */
async function learned(page: Page, on: string): Promise<string[]> {
	await chooser(page).selectOption(on);
	await expect(page.locator("unlab-mac-table").getByRole("heading")).toHaveText(`${on} mac address table`);
	const rows = await page.locator("unlab-mac-table tbody tr").evaluateAll((trs) =>
		trs.map((tr) => {
			const [, port, machine, seen] = [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
			return `${machine} at ${port}${seen.startsWith("flushed") ? " flushed" : ""}`;
		}),
	);
	return rows.sort();
}

/** Keeps what the page tells a screen reader, from now on. */
const listen = (page: Page) =>
	page.evaluate(() => {
		const said: string[] = [];
		const region = document.querySelector("#unlab-announcer");
		if (!region) throw new Error("no announcer");
		new MutationObserver(() => {
			if (region.textContent) said.push(region.textContent);
		}).observe(region, { childList: true, characterData: true, subtree: true });
		Object.assign(window, { said });
	});
const heard = (page: Page) => page.evaluate(() => (window as unknown as { said: string[] }).said.join("\n"));

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

/** What the capture has counted since the lab began: frames that switches accepted. */
async function carried(page: Page): Promise<number> {
	const text = (await page.locator("unlab-capture .counters").first().textContent()) ?? "";
	return Number(/^(\d+) in/.exec(text.trim())?.[1]);
}

async function read(page: Page, filter: string): Promise<readonly Row[]> {
	const reply = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows?: Row[]; error?: string };
	if (!reply.rows) throw new Error(`${filter}: ${reply.error}`);
	return reply.rows;
}

/** One ARP request for an address that nobody has, from the machine: a single broadcast. Returns what arping said. */
const askOnce = (page: Page, machine: number) => root(page, machine, "arping -c 1 -w 1 -I eth0 10.88.0.99; true");

/** The capture's event rows about a switch or a port, oldest first. No frame in these labs is DHCP, so the rows are alone. */
async function events(page: Page, where: string): Promise<string[]> {
	await typed(page, `capture ${where} dhcp`);
	await expect(full(page).getByRole("textbox", { name: "filter" })).toHaveValue(`${where} dhcp`);
	await expect(full(page).locator(".matches")).toHaveText(/^0 of \d+ frames$/);
	const rows = await full(page).locator(".row.event .text").allTextContents();
	await page.keyboard.press("Escape");
	return rows.map((text) => text.replace(/\s+/g, " ").trim());
}

/** How long a command of the lab's takes, in the bar's own parser and from a tool. */
async function answersIn(page: Page): Promise<number> {
	const started = Date.now();
	const listed = (await call(page, "machines_list", {})) as { data: unknown[] };
	expect(listed.data.length).toBeGreaterThan(0);
	return Date.now() - started;
}

test("a cable joins two switches at the lowest free ports or those that are named, their machines ping each other, and another command removes it", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net lan --no-gateway");
	await ready(page, "2 of 2 ready");
	expect(await reaches(page, 1, "node2")).toBe(false);

	// One command, and nothing after it: the next line is the ping.
	await listen(page);
	await typed(page, "cable switch0 lan");
	await expect.poll(() => heard(page)).toContain("switch0 port 2 to lan port 2 cabled");
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await reaches(page, 2, "node1")).toBe(true);
	expect(await wiring(page)).toEqual(["switch0: 1 node1:eth0 up, 2 lan:2 up", "lan: 1 node2:eth0 up, 2 switch0:2 up"]);
	expect((await topology(page)).switches[0].ports[1]).toEqual({
		port: 2,
		cable: { to: { kind: "port", switch: "lan", port: 2 }, link: "up" },
	});
	expect(await events(page, "lan:2")).toEqual([
		"switch0 port 2 and lan port 2 link up. Cable between them plugged in by you.",
	]);

	// Each switch has learned the far machine on the port that its end of the cable is in.
	await page.getByRole("button", { name: "Maximise switches" }).click();
	expect(await learned(page, "switch0")).toEqual(["node1 at 1", "node2 at 2"]);
	expect(await learned(page, "lan")).toEqual(["node1 at 2", "node2 at 1"]);
	const between = panel(page).locator(".port[data-port='2']");
	await expect(between.locator(".name")).toHaveText("switch0");
	await expect(between.locator(".nic")).toHaveText("port 2");
	await expect(between.locator(".word")).toHaveText("up");
	if (shots) await page.screenshot({ path: `${shots}/cable-between-switches.png` });

	// Another command removes it, by either of its ports, and both are free again.
	expect(await call(page, "switch_uncable", { cable: "lan:2" })).toEqual({
		result: "removed the cable from lan:2 to switch0:2",
		data: { from: { switch: "lan", port: 2 }, to: { switch: "switch0", port: 2 } },
	});
	expect(await wiring(page)).toEqual(["switch0: 1 node1:eth0 up", "lan: 1 node2:eth0 up"]);
	expect(await reaches(page, 1, "node2")).toBe(false);
	expect(await learned(page, "lan")).toEqual(["node2 at 1"]);
	expect(await learned(page, "switch0")).toEqual(["node1 at 1"]);
	await page.keyboard.press("Escape");
	expect(await events(page, "switch0:2")).toEqual([
		"switch0 port 2 and lan port 2 link up. Cable between them plugged in by you.",
		"switch0 port 2 and lan port 2 link down. Cable between them unplugged by the agent.",
	]);

	// At ports that are named, from the tool.
	expect(await call(page, "switch_cable", { from: "lan:8", to: "switch0:7" })).toEqual({
		result: "cabled lan:8 to switch0:7",
		data: { from: { switch: "lan", port: 8 }, to: { switch: "switch0", port: 7 }, link: "up", loop: false },
	});
	expect(await wiring(page)).toEqual(["switch0: 1 node1:eth0 up, 7 lan:8 up", "lan: 1 node2:eth0 up, 8 switch0:7 up"]);
	expect(await reaches(page, 2, "node1")).toBe(true);
	expect(errors).toEqual([]);
});

test("a cable between switches is cut and reconnected, which flushes what both learned over it, and a second one carries meanwhile", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net lan --no-gateway");
	await ready(page, "2 of 2 ready");
	await typed(page, "cable switch0:8 lan:7");
	expect(await reaches(page, 1, "node2")).toBe(true);
	await page.getByRole("button", { name: "Maximise switches" }).click();
	expect(await learned(page, "switch0")).toEqual(["node1 at 1", "node2 at 8"]);
	expect(await learned(page, "lan")).toEqual(["node1 at 7", "node2 at 1"]);

	// Cut by the far end's port: both switches forget what they learned over it.
	expect(await call(page, "link_set", { link: "down", machines: "lan:7" })).toEqual({
		result: "lan:7 cut",
		data: [{ switch: "lan", port: 7, to: { switch: "switch0", port: 8 }, link: "cut" }],
	});
	expect(await learned(page, "lan")).toEqual(["node1 at 7 flushed", "node2 at 1"]);
	expect(await learned(page, "switch0")).toEqual(["node1 at 1", "node2 at 8 flushed"]);
	await expect(panel(page).locator(".port[data-port='8'] .word")).toHaveText("cut");
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 8 lan:7 cut",
		"lan: 1 node2:eth0 up, 7 switch0:8 cut",
	]);
	expect(await reaches(page, 1, "node2")).toBe(false);

	// Two switches can have more than one cable: the second carries while the first is cut.
	await typed(page, "cable lan switch0");
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 2 lan:2 up, 8 lan:7 cut",
		"lan: 1 node2:eth0 up, 2 switch0:2 up, 7 switch0:8 cut",
	]);
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await learned(page, "switch0")).toEqual(["node1 at 1", "node2 at 2"]);
	expect(await call(page, "switch_uncable", { cable: "switch0:2" })).toMatchObject({
		result: "removed the cable from switch0:2 to lan:2",
	});
	expect(await reaches(page, 1, "node2")).toBe(false);

	// Reconnected by a click on its port, as a machine's cable is.
	await panel(page).getByRole("button", { name: "Reconnect the cable from switch0 port 8 to lan port 7" }).click();
	await expect(panel(page).locator(".port[data-port='8'] .word")).toHaveText("up");
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await learned(page, "switch0")).toEqual(["node1 at 1", "node2 at 8"]);
	expect(await learned(page, "lan")).toEqual(["node1 at 7", "node2 at 1"]);
	await page.keyboard.press("Escape");
	expect(await events(page, "lan:7")).toEqual([
		"switch0 port 8 and lan port 7 link up. Cable between them plugged in by you.",
		"switch0 port 8 and lan port 7 link down. Cable between them cut by the agent.",
		"switch0 port 8 and lan port 7 link up. Cable between them reconnected by you.",
	]);
});

test("what cannot be cabled is refused in one sentence, the same in the bar and through WebMCP, and the bar completes and previews it", async ({
	page,
}) => {
	await openLab(page);
	for (const name of ["lan", "wan"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "cable lan:3 wan:1");

	await refused(
		page,
		"cable lan nowhere",
		"switch_cable",
		{ from: "lan", to: "nowhere" },
		"No switch is called nowhere, so use switch0, lan or wan.",
	);
	await refused(
		page,
		"cable lan:9 wan",
		"switch_cable",
		{ from: "lan:9", to: "wan" },
		"lan:9 is no port, so use one from lan:1 to lan:8.",
	);
	await refused(
		page,
		"cable lan:4 lan:4",
		"switch_cable",
		{ from: "lan:4", to: "lan:4" },
		"Both ends are lan:4, and a cable has two, so name another port for one of them.",
	);
	await refused(
		page,
		"cable switch0 lan:3",
		"switch_cable",
		{ from: "switch0", to: "lan:3" },
		"lan:3 is taken by the cable to wan:1, so use lan:1.",
	);
	await refused(page, "uncable lan:5", "switch_uncable", { cable: "lan:5" }, "lan:5 has no cable, so use lan:3.");
	// In the bar a switch's name is the start of its port's, which Enter completes.
	expect(await call(page, "switch_uncable", { cable: "lan" })).toEqual({
		error: "lan is a switch, so name a port with a cable in it: lan:3. Nothing was changed.",
	});
	await refused(
		page,
		"uncable switch0:1",
		"switch_uncable",
		{ cable: "switch0:1" },
		"switch0:1 has no cable, and nothing is plugged into switch0.",
	);
	await refused(
		page,
		"link down wan:2",
		"link_set",
		{ link: "down", machines: "wan:2" },
		"wan:2 has no cable, so use wan:1.",
	);

	// A switch that is full says so, and what has room.
	for (const port of [1, 2, 4, 5, 6, 7, 8]) await call(page, "switch_cable", { from: "lan", to: `switch0:${port}` });
	await refused(
		page,
		"cable wan lan",
		"switch_cable",
		{ from: "wan", to: "lan" },
		"lan has no free port, so use switch0 or wan, or free a port with unplug or uncable.",
	);

	// The bar completes each end, says what the line will do, and that a cable closes a loop.
	const options = bar(page).getByRole("option");
	const will = bar(page).locator(".will");
	await page.keyboard.press("Control+/");
	const command = page.getByRole("combobox", { name: "Command" });
	for (const [line, offered, effect] of [
		["cabl", "cable"],
		["uncabl", "uncable"],
		["cable ", "wan"],
		["cable wan:", "wan:2"],
		["cable wan wan", null, "cable wan port 2 to wan port 3 · closes a loop"],
		["cable wan switch0", null, "cable wan port 2 to switch0 port 3 · closes a loop"],
		["uncable ", "wan:1", "remove the cable"],
		["uncable switch0:5", null, "remove the cable from switch0 port 5 to lan port 5"],
		["link down ", "lan:3"],
		["link down lan:3", null, "cut the cable from lan port 3 to wan port 1"],
		[
			"link down lan:3,switch0:1",
			null,
			"cut the cable from lan port 3 to wan port 1 · cut the cable from switch0 port 1",
		],
		["capture lan:", "lan:3"],
	] as const) {
		await command.fill(line);
		if (offered !== null) await expect(options.filter({ hasText: offered }).first(), line).toBeVisible();
		if (effect !== undefined) await expect(will, line).toContainText(effect);
	}
	await command.fill("uncable ");
	await expect(options.filter({ hasText: "cable to lan:3 · up" }).first()).toContainText("wan:1");
	await page.keyboard.press("Escape");

	// A cable from a switch to itself is allowed, and takes two of its ports.
	expect(await call(page, "switch_cable", { from: "wan", to: "wan" })).toMatchObject({
		result: "cabled wan:2 to wan:3 · closes a loop",
		data: { loop: true },
	});
	expect((await wiring(page))[2]).toBe("wan: 1 lan:3 up, 2 wan:3 up, 3 wan:2 up");
});

test("a switch that is removed takes its cables to other switches with it, after asking once with each of them listed", async ({
	page,
}) => {
	await openLab(page);
	for (const name of ["lan", "wan"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await ready(page, "1 of 1 ready");
	for (const line of ["cable lan wan:5", "cable switch0 lan", "cable lan lan"]) {
		await typed(page, line);
	}
	expect(await wiring(page)).toEqual([
		"switch0: 1 lan:3 up",
		"lan: 1 node1:eth0 up, 2 wan:5 up, 3 switch0:1 up, 4 lan:5 up, 5 lan:4 up",
		"wan: 5 lan:2 up",
	]);

	await start(page, "removed", "switch_remove", { switch: "lan" });
	const waiting = page.locator("unlab-agent-panel unlab-confirm");
	await expect(waiting).toHaveCount(1);
	await expect(waiting).toContainText("This unplugs node1 from port 1.");
	await expect(waiting).toContainText(
		"This removes the cables from port 2 to wan port 5, from port 3 to switch0 port 1 and from port 4 to lan port 5.",
	);
	await page.locator("unlab-agent-panel").getByRole("button", { name: "Remove lan", exact: true }).click();
	expect(await finish(page, "removed")).toEqual({
		result: "removed lan · node1 unplugged · cables to wan port 5, switch0 port 1 and lan port 5 removed",
		data: {
			removed: "lan",
			unplugged: [{ machine: "node1", nic: "eth0" }],
			cables: [
				{ port: 2, to: { switch: "wan", port: 5 } },
				{ port: 3, to: { switch: "switch0", port: 1 } },
				{ port: 4, to: { switch: "lan", port: 5 } },
			],
		},
	});
	await expect(waiting).toHaveCount(0);
	expect(await wiring(page)).toEqual(["switch0: ", "wan: "]);
	expect(await events(page, "wan:5")).toEqual([
		"lan port 2 and wan port 5 link up. Cable between them plugged in by you.",
		"lan port 2 and wan port 5 link down. Cable between them unplugged by the agent.",
	]);

	// The person is asked the same, once, in the bar.
	await typed(page, "mkswitch lan");
	await typed(page, "cable lan wan");
	await typed(page, "rmswitch lan");
	const asked = bar(page).locator("unlab-confirm");
	await expect(asked).toHaveCount(1);
	await expect(asked).toContainText("This removes the cable from port 1 to wan port 1.");
	await page.keyboard.press("Enter");
	await expect(chooser(page).getByRole("option")).toHaveText(["switch0", "wan"]);
	expect(await wiring(page)).toEqual(["switch0: ", "wan: "]);
});

test("closing a loop is allowed: one broadcast then goes round, the switches are marked as storming with their rate, the lab still answers, and a cut ends it within a second", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("crash", () => errors.push("the page crashed"));
	await openLab(page);
	for (const name of ["lan", "wan"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net lan --no-gateway");
	await typed(page, "spawn 1 lab --net wan --no-gateway");
	await ready(page, "3 of 3 ready");
	for (const line of ["cable switch0:7 lan:8", "cable lan:7 wan:8"]) {
		await typed(page, line);
	}
	expect(await reaches(page, 1, "node3")).toBe(true);
	// node2 knows node1's address from here on, so that its ping after the storm is not preceded by a broadcast.
	expect(await reaches(page, 2, "node1")).toBe(true);
	expect(await storms(page)).toEqual({});
	await listen(page);

	// The cable that closes the loop goes in as any other, and says what it has done.
	expect(await call(page, "switch_cable", { from: "wan:7", to: "switch0:8" })).toEqual({
		result: "cabled wan:7 to switch0:8 · closes a loop",
		data: { from: { switch: "wan", port: 7 }, to: { switch: "switch0", port: 8 }, link: "up", loop: true },
	});
	const quiet = await carried(page);
	const sent = async () => Number(await root(page, 1, "cat /sys/class/net/eth0/statistics/tx_packets"));
	const before = await sent();
	expect(await askOnce(page, 1)).toContain("Sent 1 probe");
	// node1 sent it once, and a second later the switches still carry it: the newest thousand frames are all that one.
	expect((await sent()) - before).toBeLessThan(5);
	const asked = await read(page, "arp 10.88.0.99");
	expect(asked.filter((row) => row.looped).length).toBeGreaterThan(900);
	expect(asked.every((row) => row.info === asked[0].info && row.from.name === "node1")).toBe(true);
	expect(asked.find((row) => row.looped)?.note).toMatch(/^looped · flooded to/);
	const then = await carried(page);
	expect(then - quiet).toBeGreaterThan(1000);
	await expect.poll(async () => (await carried(page)) - then, { timeout: 5000 }).toBeGreaterThan(2000);

	// Each switch of the loop is marked, with the looped frames it took in the last second.
	await expect.poll(async () => Object.keys(await storms(page)), { timeout: 5000 }).toEqual(["switch0", "lan", "wan"]);
	await expect.poll(async () => Math.min(...Object.values(await storms(page)).map((s) => s.rate))).toBeGreaterThan(300);
	await typed(page, "topology");
	const report = bar(page).locator(".result");
	await expect(report.locator(".header")).toHaveText(
		"3 switches · 9 of 24 ports taken · switch0, lan and wan storming",
	);
	expect((await report.locator("dd").allInnerTexts())[0].split("\n")[0]).toMatch(
		/^storming · \d+ looped frames a second · \d+ dropped$/,
	);
	await page.keyboard.press("Escape");
	await expect(panel(page).locator(".storm")).toContainText(/storming · \d+ looped frames a second · \d+ dropped/);
	await expect(chooser(page).getByRole("option")).toHaveText([
		/switch0 · storming/,
		/lan · storming/,
		/wan · storming/,
	]);
	expect(await heard(page)).toContain("A storm has begun: frames go round a loop of cables until one of them is cut");
	if (shots) await page.screenshot({ path: `${shots}/storm.png` });

	// While it storms the lab answers within a second, every machine too, and nothing has crashed.
	for (let i = 0; i < 3; i++) expect(await answersIn(page)).toBeLessThan(1000);
	for (const machine of [1, 2, 3]) {
		const started = Date.now();
		expect((await shell(page, machine, "echo answered")).output).toContain("answered");
		expect(Date.now() - started).toBeLessThan(1000);
	}
	await expect(page.getByText("3 of 3 ready")).toBeVisible();
	const started = Date.now();
	await typed(page, "ls");
	await expect(bar(page).locator(".result .header")).toContainText("3 ready");
	expect(Date.now() - started).toBeLessThan(1000);
	await page.keyboard.press("Escape");

	// Cutting one cable of the loop ends the storm within a second, and pings work again.
	await call(page, "link_set", { link: "down", machines: "lan:7" });
	const cutAt = Date.now();
	await expect.poll(async () => storms(page), { timeout: 1000, intervals: [20] }).toEqual({});
	expect(Date.now() - cutAt).toBeLessThan(1000);
	// To node1 first, whose address the storm left on the wrong port of each switch, from a machine that asks nobody.
	expect(await reaches(page, 2, "node1")).toBe(true);
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(await reaches(page, 3, "node2")).toBe(true);
	const still = await carried(page);
	await page.waitForTimeout(500);
	expect((await carried(page)) - still).toBeLessThan(50);
	await expect(panel(page).locator(".storm")).toHaveCount(0);
	expect(await heard(page)).toContain("The storm is over");
	const told = await events(page, "wan");
	expect(told).toContain(
		"wan is storming. Frames that go round a loop of cables keep coming into it, until a cable of the loop is cut.",
	);
	expect(told.at(-1)).toMatch(
		/^wan storm over\. It took \d+ looped frames in [\d.]+ s\. It has forgotten its MAC table\.$/,
	);
	expect(errors).toEqual([]);
});

test("a mesh of four switches storms until every loop is cut, and what the lab drops to stay responsive is counted and shown", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("crash", () => errors.push("the page crashed"));
	await openLab(page);
	for (const name of ["b", "c", "d"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net d --no-gateway");
	await ready(page, "2 of 2 ready");
	// A star first, which has no loop, and then the three cables that make it a mesh.
	for (const [from, to] of [
		["switch0", "d"],
		["b", "d"],
		["c", "d"],
	]) {
		expect(await call(page, "switch_cable", { from, to })).toMatchObject({ data: { loop: false } });
	}
	expect(await reaches(page, 1, "node2")).toBe(true);
	for (const [from, to] of [
		["switch0", "b"],
		["switch0", "c"],
		["b", "c"],
	]) {
		expect(await call(page, "switch_cable", { from, to })).toMatchObject({ data: { loop: true } });
	}
	await askOnce(page, 1);

	await expect.poll(async () => Object.keys(await storms(page)), { timeout: 5000 }).toEqual(["switch0", "b", "c", "d"]);
	// Three cables bring each switch looped frames, and each frame is to go out of the other two: half do not fit.
	await expect
		.poll(async () => Math.min(...Object.values(await storms(page)).map((s) => s.dropped)), { timeout: 5000 })
		.toBeGreaterThan(1000);
	for (const storm of Object.values(await storms(page))) {
		expect(storm.rate).toBeGreaterThan(1000);
		expect(storm.rate).toBeLessThanOrEqual(3050);
	}
	const shown = async () =>
		Number(/(\d+) dropped/.exec((await panel(page).locator(".storm").textContent()) ?? "")?.[1]);
	await expect.poll(shown).toBeGreaterThan(1000);
	for (let i = 0; i < 3; i++) expect(await answersIn(page)).toBeLessThan(1000);
	expect((await shell(page, 2, "echo answered")).output).toContain("answered");
	if (shots) await page.screenshot({ path: `${shots}/storm-mesh.png` });

	// One cut leaves other loops whole, so the storm goes on.
	await call(page, "link_set", { link: "down", machines: "switch0:2" });
	await page.waitForTimeout(700);
	expect(Object.keys(await storms(page))).toEqual(["switch0", "b", "c", "d"]);

	// With the star left, it is over within a second, and pings work again.
	await call(page, "link_set", { link: "down", machines: "switch0:3,b:3" });
	const cutAt = Date.now();
	await expect.poll(async () => storms(page), { timeout: 1000, intervals: [20] }).toEqual({});
	expect(Date.now() - cutAt).toBeLessThan(1000);
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await reaches(page, 2, "node1")).toBe(true);

	// The capture says what each storm came to, with what the switch dropped in it.
	expect((await events(page, "d")).at(-1)).toMatch(
		/^d storm over\. It took \d+ looped frames in [\d.]+ s, and did not send on \d+ more that the lab had no room for\. It has forgotten its MAC table\.$/,
	);
	expect(errors).toEqual([]);
});

test("a reload brings back the cables between switches, cut or not, with tables and storms empty, and a lab that was saved with a loop opens and answers", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("crash", () => errors.push("the page crashed"));
	await openLab(page);
	for (const name of ["lan", "wan"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "spawn 1 alpine --no-gateway");
	await typed(page, "spawn 1 alpine --net wan --no-gateway");
	await ready(page, "2 of 2 ready");
	for (const line of ["cable switch0:7 lan:8", "cable lan:7 wan:8", "cable wan:7 switch0:8", "link down wan:7"]) {
		await typed(page, line);
	}
	expect(await reaches(page, 1, "node2")).toBe(true);
	const before = await topology(page);
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 7 lan:8 up, 8 wan:7 cut",
		"lan: 7 wan:8 up, 8 switch0:7 up",
		"wan: 1 node2:eth0 up, 7 switch0:8 cut, 8 lan:7 up",
	]);

	await page.reload();
	await ready(page, "2 of 2 ready");
	expect(await topology(page)).toEqual(before);
	await page.getByRole("button", { name: "Maximise switches" }).click();
	// Only what the machines have said since they booted, and nothing of before the reload.
	expect((await learned(page, "lan")).filter((row) => row.includes("flushed"))).toEqual([]);
	await page.keyboard.press("Escape");
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await events(page, "lan:7")).toEqual([
		"lan port 7 and wan port 8 link up. Cable between them plugged in by the lab.",
	]);

	// Saved with the loop closed, it opens as any other: the machines boot into a storm, and the lab answers.
	expect(await call(page, "link_set", { link: "up", machines: "switch0:8" })).toMatchObject({ result: "switch0:8 up" });
	await askOnce(page, 1);
	await expect.poll(async () => Object.keys(await storms(page)), { timeout: 5000 }).toEqual(["switch0", "lan", "wan"]);
	await page.reload();
	await ready(page, "2 of 2 ready");
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 7 lan:8 up, 8 wan:7 up",
		"lan: 7 wan:8 up, 8 switch0:7 up",
		"wan: 1 node2:eth0 up, 7 switch0:8 up, 8 lan:7 up",
	]);
	for (let i = 0; i < 3; i++) expect(await answersIn(page)).toBeLessThan(1000);
	await askOnce(page, 2);
	await expect.poll(async () => Object.keys(await storms(page)), { timeout: 5000 }).toEqual(["switch0", "lan", "wan"]);
	expect(await answersIn(page)).toBeLessThan(1000);
	await call(page, "link_set", { link: "down", machines: "lan:8" });
	await expect.poll(async () => storms(page), { timeout: 1000, intervals: [20] }).toEqual({});
	expect(await reaches(page, 2, "node1")).toBe(true);
	expect(errors).toEqual([]);
});

interface Saved {
	readonly name: string;
	readonly frames: readonly Buffer[];
}

/** Saves the capture as a person does, and reads the frames in the file. */
async function saved(page: Page): Promise<Saved> {
	const [file] = await Promise.all([
		page.waitForEvent("download"),
		full(page).getByRole("button", { name: "save .pcap" }).click(),
	]);
	const bytes = readFileSync(await file.path());
	const frames: Buffer[] = [];
	for (let o = 24; o < bytes.length; o += 16 + bytes.readUInt32LE(o + 8)) {
		frames.push(bytes.subarray(o + 16, o + 16 + bytes.readUInt32LE(o + 8)));
	}
	return { name: file.suggestedFilename(), frames };
}

/** `request 2`, for each ping among the frames. */
const echoes = (frames: readonly Buffer[]) =>
	frames.flatMap((bytes) =>
		bytes.readUInt16BE(12) === 0x0800 && bytes[23] === 1
			? [`${bytes[34] === 8 ? "request" : "reply"} ${bytes.readUInt16BE(40)}`]
			: [],
	);

test("a cable between switches is filtered by either of its ports, saves each frame once, and its event rows name both ends", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --no-gateway");
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await ready(page, "2 of 2 ready");
	await typed(page, "cable switch0:8 lan:7");
	expect(await reaches(page, 1, "node2")).toBe(true);
	await dock(page).getByRole("button", { name: "Clear" }).click();
	expect((await shell(page, 1, "ping -c 4 -W 1 node2")).exitCode).toBe(0);
	const each = [0, 1, 2, 3].flatMap((seq) => [`request ${seq}`, `reply ${seq}`]);

	// Either port names the cable: the same frames, each as the switch at that end carried it.
	const near = await read(page, "switch0:8 icmp");
	const far = await read(page, "lan:7 icmp");
	expect(near.map((row) => `${row.switch} ${row.in} → ${row.out?.join(",")}`)).toEqual(
		[0, 1, 2, 3].flatMap(() => ["switch0 1 → 8", "switch0 8 → 1"]),
	);
	expect(far.map((row) => `${row.switch} ${row.in} → ${row.out?.join(",")}`)).toEqual(
		[0, 1, 2, 3].flatMap(() => ["lan 7 → 1", "lan 1 → 7"]),
	);
	expect(far.map(({ info, len }) => [info, len])).toEqual(near.map(({ info, len }) => [info, len]));
	// Both together are every hop, and a ping across one cable has two.
	expect(await read(page, "icmp")).toHaveLength(16);

	for (const cable of ["switch0:8", "lan:7"]) {
		await typed(page, `capture ${cable}`);
		const file = await saved(page);
		expect(file.name, cable).toBe(`unlab-${cable.replace(":", "-port")}.pcap`);
		expect(echoes(file.frames), cable).toEqual(each);
		expect(new Set(file.frames.map((bytes) => bytes.toString("hex"))).size, cable).toBe(file.frames.length);
		await page.keyboard.press("Escape");
	}

	// The cable's own rows are there under either port, and each names both ends.
	await typed(page, "link down lan:7");
	await typed(page, "link up switch0:8");
	for (const cable of ["switch0:8", "lan:7"]) {
		await typed(page, `capture ${cable} arp`);
		await expect(full(page).locator(".row.event"), cable).toContainText([
			"switch0 port 8 and lan port 7 link down. Cable between them cut by you.",
			"switch0 port 8 and lan port 7 link up. Cable between them reconnected by you.",
		]);
		await expect(full(page).locator(".row.event"), cable).toHaveCount(2);
		await page.keyboard.press("Escape");
	}
	// A machine's name keeps no row of a cable between switches, and another cable's port keeps none of this one's.
	for (const filter of ["node1", "switch0:1"]) {
		await typed(page, `capture ${filter}`);
		await expect(full(page).locator(".row.frame").first()).toBeVisible();
		await expect(full(page).locator(".row.event"), filter).not.toContainText(["Cable between them"]);
		await page.keyboard.press("Escape");
	}
	if (shots) await page.screenshot({ path: `${shots}/cable-capture.png` });
});
