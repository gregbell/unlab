import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

type Carried =
	| { readonly mode: "access"; readonly vlan: number }
	| { readonly mode: "trunk"; readonly allowed: readonly number[] | "all"; readonly native: number };
interface Topology {
	readonly switches: readonly {
		readonly name: string;
		readonly ports: readonly { readonly port: number; readonly vlan: Carried }[];
	}[];
}
interface Row {
	readonly switch?: string;
	readonly in?: number;
	readonly out?: readonly number[];
	readonly note: string | null;
	readonly vlan?: number;
	readonly tagged?: readonly number[];
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const panel = (page: Page) => page.locator("unlab-switch");
const full = (page: Page) => page.locator("unlab-capture[mode=full]");

const reaches = async (page: Page, machine: number, address: string) =>
	(await shell(page, machine, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

/** `switch0:1 vlan 10`, `lan:8 trunk all native 1`, for each port that something is in. */
async function carried(page: Page, ...ports: readonly string[]): Promise<string[]> {
	const { switches } = ((await call(page, "topology_read", {})) as { data: Topology }).data;
	return ports.map((name) => {
		const [on, no] = name.split(":");
		const vlan = switches.find((sw) => sw.name === on)?.ports[Number(no) - 1]?.vlan;
		if (!vlan) return `${name} none`;
		if (vlan.mode === "access") return `${name} vlan ${vlan.vlan}`;
		return `${name} trunk ${vlan.allowed === "all" ? "all" : vlan.allowed.join(",")} native ${vlan.native}`;
	});
}

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

/** The frames in the .pcap that the capture saves, as a person saves it. */
async function saved(page: Page): Promise<Buffer[]> {
	const [file] = await Promise.all([
		page.waitForEvent("download"),
		full(page).getByRole("button", { name: "save .pcap" }).click(),
	]);
	const bytes = readFileSync(await file.path());
	const frames: Buffer[] = [];
	for (let o = 24; o < bytes.length; o += 16 + bytes.readUInt32LE(o + 8)) {
		frames.push(bytes.subarray(o + 16, o + 16 + bytes.readUInt32LE(o + 8)));
	}
	return frames;
}

test("a port goes in a VLAN by its number or by its NIC, from the bar and its tool: machines of one subnet in two VLANs do not ping, and in one they do", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "spawn 2 lab --no-gateway");
	await ready(page, "2 of 2 ready");
	expect(await carried(page, "switch0:1", "switch0:2")).toEqual(["switch0:1 vlan 1", "switch0:2 vlan 1"]);
	expect(await reaches(page, 1, "node2")).toBe(true);

	await typed(page, "vlan node1 10");
	expect(await call(page, "port_vlan", { port: "switch0:2", vlan: 20 })).toEqual({
		result: "switch0:2 vlan 20",
		data: { switch: "switch0", port: 2, mode: "access", vlan: 20 },
	});
	expect(await carried(page, "switch0:1", "switch0:2")).toEqual(["switch0:1 vlan 10", "switch0:2 vlan 20"]);
	await expect(panel(page).locator(".port[data-port='1'] .nic")).toHaveText("v10");
	await expect(panel(page).locator(".port[data-port='2'] .nic")).toHaveText("v20");
	await expect(panel(page).locator(".port[data-port='1']")).toHaveAttribute("title", "node1 · vlan 10");
	expect(await reaches(page, 1, "node2")).toBe(false);
	expect(await reaches(page, 2, "node1")).toBe(false);

	await typed(page, "vlan switch0:2 10");
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await reaches(page, 2, "node1")).toBe(true);
	// The machines send and get frames with no tag: the capture has them in VLAN 10, tagged nowhere.
	const pings = await read(page, "vlan 10 icmp");
	expect(pings.length).toBeGreaterThanOrEqual(4);
	expect(pings.every((row) => row.vlan === 10 && row.tagged === undefined && row.note?.startsWith("vlan 10"))).toBe(
		true,
	);

	await refused(
		page,
		"vlan node1 5000",
		"port_vlan",
		{ port: "node1", vlan: 5000 },
		"5000 is no VLAN, so use one from 1 to 4094.",
	);
	await refused(
		page,
		"vlan switch0:5 10",
		"port_vlan",
		{ port: "switch0:5", vlan: 10 },
		"switch0:5 has no cable, so use switch0:1 or switch0:2.",
	);
	await refused(
		page,
		"trunk node1",
		"port_trunk",
		{ port: "node1" },
		"switch0:1 holds the cable of node1, whose kernel has no 802.1Q to read tags with, so make a trunk of a port that a cable between switches is in, or put node1 in one VLAN with vlan node1 10.",
	);

	// The setting is the port's: a cable that comes out leaves it in VLAN 1 for whatever goes in next.
	await typed(page, "unplug node2");
	await typed(page, "plug node2 switch0:2");
	expect(await carried(page, "switch0:2")).toEqual(["switch0:2 vlan 1"]);
	expect(errors).toEqual([]);
});

test("two VLANs cross one trunk, tagged in the capture and its file, each machine reaches only its own, and a reload brings it all back", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 2 lab --no-gateway");
	await typed(page, "spawn 2 lab --net lan --no-gateway");
	await ready(page, "4 of 4 ready");
	await typed(page, "cable switch0:8 lan:8");
	for (const line of ["vlan node1 10", "vlan node3 10", "vlan node2 20", "vlan node4 20", "trunk switch0:8"]) {
		await typed(page, line);
	}
	expect(await call(page, "port_trunk", { port: "lan:8" })).toEqual({
		result: "lan:8 trunk of all VLANs, native 1",
		data: { switch: "lan", port: 8, mode: "trunk", allowed: "all", native: 1 },
	});
	await expect(panel(page).locator(".port[data-port='8'] .nic")).toHaveText("port 8 trunk");
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(await reaches(page, 2, "node4")).toBe(true);
	expect(await reaches(page, 1, "node4")).toBe(false);
	expect(await reaches(page, 2, "node3")).toBe(false);

	// The trunk's rows have each frame's tag, and its file has the tag on each frame as it crossed.
	const trunked = await read(page, "switch0:8 icmp");
	expect(trunked.length).toBeGreaterThanOrEqual(4);
	expect(
		[...new Set(trunked.map((row) => `${row.vlan} ${row.tagged?.join(",")} ${row.note?.split(" · ")[0]}`))].sort(),
	).toEqual(["10 8 802.1Q vlan 10 on switch0 port 8", "20 8 802.1Q vlan 20 on switch0 port 8"]);
	expect((await read(page, "vlan 20 icmp")).every((row) => row.vlan === 20)).toBe(true);
	await typed(page, "capture switch0:8 icmp");
	const file = await saved(page);
	expect(file.length).toBe(trunked.length);
	expect(
		[
			...new Set(
				file.map(
					(bytes) =>
						`${bytes.readUInt16BE(12).toString(16)} ${bytes.readUInt16BE(14)} ${bytes.readUInt16BE(16).toString(16)}`,
				),
			),
		].sort(),
	).toEqual(["8100 10 800", "8100 20 800"]);
	await full(page).getByRole("option").last().click();
	await expect(page.locator("unlab-frame-detail")).toContainText("802.1Q");
	await expect(page.locator("unlab-frame-detail .summary")).toContainText(/ · vlan (10|20)$/);
	await page.keyboard.press("Escape");

	// A VLAN the trunk does not allow does not cross it.
	await typed(page, "trunk switch0:8 --allow 10");
	expect(await reaches(page, 2, "node4")).toBe(false);
	expect(await reaches(page, 1, "node3")).toBe(true);

	// Ends with different native VLANs move untagged frames from one VLAN to the other.
	await typed(page, "trunk switch0:8 --native 10");
	await typed(page, "trunk lan:8 --native 20");
	expect(await reaches(page, 1, "node4")).toBe(true);
	expect(await reaches(page, 1, "node3")).toBe(false);

	const before = await carried(page, "switch0:1", "switch0:2", "switch0:8", "lan:1", "lan:2", "lan:8");
	expect(before).toEqual([
		"switch0:1 vlan 10",
		"switch0:2 vlan 20",
		"switch0:8 trunk all native 10",
		"lan:1 vlan 10",
		"lan:2 vlan 20",
		"lan:8 trunk all native 20",
	]);
	await page.reload();
	await ready(page, "4 of 4 ready");
	expect(await carried(page, "switch0:1", "switch0:2", "switch0:8", "lan:1", "lan:2", "lan:8")).toEqual(before);
	expect(await reaches(page, 1, "node4")).toBe(true);
	expect(await reaches(page, 2, "node3")).toBe(false);
	expect(errors).toEqual([]);
});

test("the desktop's switch details say what each port carries, once one is not in VLAN 1", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Welcome to unLAB" })).toBeVisible();
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 2 lab --no-gateway");
	await typed(page, "cable switch0:8 lan:8");
	const rack = page.getByRole("region", { name: "Rack manager" });
	await rack.getByRole("button", { name: "Inspect switch0" }).click();
	const details = page.getByRole("region", { name: "switch0 · Switch details" });
	const ports = details.getByRole("table", { name: "Ports on switch0" });
	await expect(ports.getByRole("columnheader", { name: "VLAN" })).toHaveCount(0);

	await typed(page, "vlan node1 10");
	await typed(page, "trunk switch0:8 --allow 10,20");
	await expect(ports.getByRole("columnheader", { name: "VLAN" })).toBeVisible();
	const row = (port: number) =>
		ports.getByRole("row").filter({ has: page.getByRole("rowheader", { name: String(port), exact: true }) });
	await expect(row(1)).toContainText("vlan 10");
	await expect(row(2)).toContainText("vlan 1");
	await expect(row(8)).toContainText("trunk of 10 and 20, native 1");
	await expect(row(5).getByRole("cell").nth(2)).toHaveText("—");
	expect(errors).toEqual([]);
});
