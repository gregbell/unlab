import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { portRow, root, shell, status, switchDetails, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

interface Bridge {
	readonly priority: number;
	readonly address: string;
	readonly switch?: string;
}
interface ListedPort {
	readonly port: number;
	readonly cable: { readonly to: { readonly kind: string } } | null;
	readonly stp?: { readonly role: string; readonly state: string };
	readonly cost?: number;
}
interface Listed {
	readonly name: string;
	readonly ports: readonly ListedPort[];
	readonly storm?: object;
	readonly stp?: "on";
	readonly priority?: number;
	readonly tree?: { readonly bridge: Bridge; readonly root: Bridge; readonly cost: number };
}
interface Row {
	readonly switch?: string;
	readonly in?: number;
	readonly proto: string;
	readonly info: string;
	readonly looped?: true;
}

/** Each switch's address in the tree, which follows from its name. */
const ADDRESS = { switch0: "02:00:0b:35:f3:53", lan: "02:00:56:60:80:10", wan: "02:00:2b:e2:e3:01" } as const;

const ready = (page: Page, said: string) => status(page, said, 90_000);
const bar = (page: Page) => page.locator("unlab-command-bar");

async function switches(page: Page): Promise<readonly Listed[]> {
	return ((await call(page, "topology_read", {})) as { data: { switches: Listed[] } }).data.switches;
}

/** The switch that each switch takes for its root, by name. */
const roots = async (page: Page) => (await switches(page)).map(({ tree }) => tree?.root.switch);

/** The ports between switches that carry nothing, as `lan:8`. */
const blocked = async (page: Page) =>
	(await switches(page)).flatMap(({ name, ports }) =>
		ports.flatMap(({ port, cable, stp }) =>
			cable?.to.kind === "port" && stp && stp.state !== "forwarding" ? [`${name}:${port}`] : [],
		),
	);

const reaches = async (page: Page, machine: number, address: string) =>
	(await shell(page, machine, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

async function read(page: Page, filter: string): Promise<readonly Row[]> {
	const reply = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows?: Row[]; error?: string };
	if (!reply.rows) throw new Error(`${filter}: ${reply.error}`);
	return reply.rows;
}

/** What a guest's tcpdump makes of the next BPDU that its eth0 hears. */
const dumped = (page: Page, machine: number) => root(page, machine, "timeout 10 tcpdump -vnni eth0 -c 1 stp 2>&1");

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

/** What a switch's details say of it in the spanning tree. */
const treeSaid = async (page: Page, on: string) =>
	(await switchDetails(page, on)).locator("dt", { hasText: "Spanning tree" }).locator("xpath=following-sibling::dd");

test("the switches exchange BPDUs that the capture decodes and a guest's tcpdump reads, each says its root and bridge ID, and priority and cost move the root and the blocked port, which a reload keeps", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("crash", () => errors.push("the page crashed"));
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	for (const name of ["lan", "wan"]) await typed(page, `mkswitch ${name}`);
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net lan --no-gateway");
	await typed(page, "spawn 1 lab --net wan --no-gateway");
	await ready(page, "3 of 3 ready");
	await typed(page, "stp on all");
	for (const cable of ["cable switch0:7 lan:8", "cable lan:7 wan:8", "cable wan:7 switch0:8"]) await typed(page, cable);
	await expect.poll(() => blocked(page)).toHaveLength(1);

	// switch0 has the lowest address, so with every priority at 32768 it is the root, and each switch says so.
	await expect.poll(() => roots(page)).toEqual(["switch0", "switch0", "switch0"]);
	const first = await switches(page);
	expect(first.map(({ name, tree }) => [name, tree?.bridge, tree?.cost])).toEqual([
		["switch0", { priority: 32768, address: ADDRESS.switch0 }, 0],
		["lan", { priority: 32768, address: ADDRESS.lan }, 20_000],
		["wan", { priority: 32768, address: ADDRESS.wan }, 20_000],
	]);
	await typed(page, "topology");
	const report = bar(page).locator(".result");
	const lines = (await report.locator("dd").allInnerTexts()).map((text) => text.split("\n"));
	expect(lines.map(([line]) => line)).toEqual([
		`spanning tree on · bridge 32768.${ADDRESS.switch0} · the root`,
		`spanning tree on · bridge 32768.${ADDRESS.lan} · root switch0 at cost 20000`,
		`spanning tree on · bridge 32768.${ADDRESS.wan} · root switch0 at cost 20000`,
	]);
	expect(lines.flat().filter((line) => line.includes(" port · "))).toContainEqual(
		expect.stringMatching(/^port [78] · .* · up · alternate port · blocked$/),
	);
	await page.keyboard.press("Escape");

	// The BPDUs are real frames: the capture decodes what switch0 tells lan, and node2's tcpdump what lan tells it.
	const rows = await read(page, "stp");
	const told = rows.find((row) => row.switch === "lan" && row.in === 8);
	expect(told).toMatchObject({ proto: "RSTP" });
	expect(told?.info).toMatch(
		new RegExp(`^root 32768\\.${ADDRESS.switch0} · cost 0 · from 32768\\.${ADDRESS.switch0} port 7 · designated, `),
	);
	expect(rows.every((row) => row.proto === "RSTP")).toBe(true);
	const heard = await dumped(page, 2);
	expect(heard).toContain("Rapid STP");
	expect(heard).toContain(`bridge-id 8000.${ADDRESS.lan}.8001`);
	expect(heard).toContain(`root-id 8000.${ADDRESS.switch0}, root-pathcost 20000`);

	// wan is made the root. switch0 and lan each reach it by their own cable, and the cable between them blocks at lan.
	await typed(page, "priority wan 4096");
	await expect.poll(() => roots(page)).toEqual(["wan", "wan", "wan"]);
	await expect.poll(() => blocked(page)).toEqual(["lan:8"]);
	expect((await switches(page)).map(({ priority }) => priority)).toEqual([undefined, undefined, 4096]);
	expect(await dumped(page, 1)).toContain(`root-id 1000.${ADDRESS.wan}, root-pathcost 20000`);
	// switch0 now tells lan of a root that is not itself, which the capture says apart from the bridge that sent it.
	const passedOn = new RegExp(`^root 4096\\.${ADDRESS.wan} · cost 20000 · from 32768\\.${ADDRESS.switch0} port 7 · `);
	await expect
		.poll(async () =>
			(await read(page, "stp")).some((row) => row.switch === "lan" && row.in === 8 && passedOn.test(row.info)),
		)
		.toBe(true);
	await root(page, 1, "arping -c 1 -w 1 -I eth0 10.88.0.99; true");
	await page.waitForTimeout(500);
	expect((await read(page, "arp 10.88.0.99")).map((row) => [row.switch, Boolean(row.looped)]).sort()).toEqual([
		["lan", false],
		["switch0", false],
		["wan", false],
	]);
	for (const [from, to] of [
		[1, "node2"],
		[2, "node3"],
		[3, "node1"],
	] as const) {
		expect(await reaches(page, from, to), `node${from} to ${to}`).toBe(true);
	}

	// The desktop says it too: in wan's details that it is the root, and in lan's the port it has blocked.
	await expect(await treeSaid(page, "wan")).toHaveText(`on · bridge 4096.${ADDRESS.wan} · the root`);
	await expect(await treeSaid(page, "lan")).toHaveText(`on · bridge 32768.${ADDRESS.lan} · root wan at cost 20000`);
	const eight = portRow(await switchDetails(page, "lan"), 8);
	await expect(eight).toContainText("switch0 port 7");
	await expect(eight).toContainText("alternate port · blocked");

	// lan's own cable to wan is made dearer than the way round by switch0, so that port blocks instead.
	expect(await call(page, "port_cost", { port: "lan:7", cost: 100_000 })).toEqual({
		result: "lan:7 costs 100000",
		data: { switch: "lan", port: 7, cost: 100_000 },
	});
	await expect.poll(() => blocked(page)).toEqual(["lan:7"]);
	const costly = (await switches(page))[1];
	expect([costly.ports[6].cost, costly.ports[6].stp, costly.tree?.cost]).toEqual([
		100_000,
		{ role: "alternate", state: "discarding" },
		40_000,
	]);
	expect(await reaches(page, 2, "node3")).toBe(true);

	// What cannot run says so in one sentence, the same in the bar and from the tool.
	await refused(
		page,
		"priority wan 4097",
		"switch_priority",
		{ switches: "wan", priority: 4097 },
		"4097 is no bridge priority, so use a step of 4096 from 0 to 61440, such as 4096.",
	);
	await refused(
		page,
		"cost lan:7 0",
		"port_cost",
		{ port: "lan:7", cost: 0 },
		"0 is no port cost, so use a whole number from 1 to 200000000.",
	);

	// A reload brings back the priority and the cost, and so the same root and the same blocked port.
	await page.reload();
	await ready(page, "3 of 3 ready");
	const back = await switches(page);
	expect([back[2].priority, back[1].ports[6].cost]).toEqual([4096, 100_000]);
	await expect.poll(() => roots(page), { timeout: 10_000 }).toEqual(["wan", "wan", "wan"]);
	await expect.poll(() => blocked(page), { timeout: 10_000 }).toEqual(["lan:7"]);
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(errors).toEqual([]);
});

test("the desktop's switch details say the switch's bridge ID, its root and each port's role, and follow a priority and a cost", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Welcome to unLAB" })).toBeVisible();
	for (const line of ["mkswitch lan", "cable switch0:1 lan:1", "cable switch0:2 lan:2"]) await typed(page, line);
	await typed(page, "spawn 1 alpine --no-gateway");
	const rack = page.getByRole("region", { name: "Rack manager" });
	await expect(rack.locator('[data-switch="switch0"] .dt-port-block').nth(2)).toHaveAttribute("data-state", "up", {
		timeout: 90_000,
	});
	await typed(page, "stp on all");
	await expect.poll(() => blocked(page)).toEqual(["lan:2"]);

	await rack.getByRole("button", { name: "Inspect lan" }).click();
	const details = page.getByRole("region", { name: "lan · Switch details" });
	const said = details.locator("dt", { hasText: "Spanning tree" }).locator("xpath=following-sibling::dd");
	await expect(said).toHaveText(`on · bridge 32768.${ADDRESS.lan} · root switch0 at cost 20000`);
	const table = details.getByRole("table", { name: "Ports on lan" });
	const column = await table.getByRole("columnheader").allInnerTexts();
	const at = column.indexOf("Spanning tree");
	expect(at).toBeGreaterThan(0);
	const cell = (port: string) =>
		table
			.getByRole("row")
			.filter({ has: page.getByRole("rowheader", { name: port, exact: true }) })
			.locator("th, td")
			.nth(at);
	await expect(cell("1")).toHaveText("root port");
	await expect(cell("2")).toHaveText("alternate port · blocked");
	await expect(cell("3")).toHaveText("—");

	// lan is made the root, so each of its ports is a way from the root, and switch0 blocks its second cable.
	await typed(page, "priority lan 4096");
	await expect(said).toHaveText(`on · bridge 4096.${ADDRESS.lan} · the root`);
	await expect(cell("1")).toHaveText("designated port");
	await expect(cell("2")).toHaveText("designated port");
	await expect.poll(() => blocked(page)).toEqual(["switch0:2"]);
	// From the tool, so that nothing but the cost changes: the keyboard stays where it was, and the tree as it is.
	expect(await call(page, "port_cost", { port: "lan:2", cost: 2000 })).toMatchObject({ result: "lan:2 costs 2000" });
	await expect(cell("2")).toHaveText("designated port · cost 2000");

	// With spanning tree off, the priority and the cost that were set are still said.
	await typed(page, "stp off all");
	await expect(said).toHaveText("off · priority 4096");
	await expect(cell("2")).toHaveText("cost 2000");
	expect(errors).toEqual([]);
});
