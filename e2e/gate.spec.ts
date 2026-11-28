import { expect, type Page, test } from "@playwright/test";
import type { Topology } from "../src/commands/index.ts";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { inGuests, scenarioLines, THREE_SUBNETS_WIRING, waitsForMachines, wiringOf } from "../test/support/scenario.ts";
import { learned, shell, switchDetails, typed } from "./lab.ts";
import { call, registered } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

const LINES = scenarioLines("three-subnets");

interface End {
	readonly name?: string;
	readonly nic?: string;
}
interface Row {
	readonly seq: number;
	readonly switch?: string;
	readonly in?: number;
	readonly out?: readonly number[];
	readonly vlan?: number;
	readonly tagged?: readonly number[];
	readonly from: End;
	readonly to: End;
	readonly info: string;
	readonly dropped?: readonly { readonly port: number; readonly reason: string }[];
}

const bar = (page: Page) => page.locator("unlab-command-bar");

async function topology(page: Page): Promise<Topology> {
	return ((await call(page, "topology_read", {})) as { data: Topology }).data;
}

const lossy = async (page: Page) => {
	const edge = (await topology(page)).switches.find(({ name }) => name === "edge");
	const cable = edge?.ports[2].cable;
	if (!cable) throw new Error("edge:3 has no cable");
	return cable.carried;
};

const allReady = (page: Page) =>
	expect
		.poll(
			async () =>
				((await call(page, "machines_list", {})) as { data: { state: string }[] }).data.every(
					({ state }) => state === "ready",
				),
			{ timeout: 90_000 },
		)
		.toBe(true);

/** A line typed into the command bar. One that runs in guests leaves its results open until each is done. */
async function run(page: Page, line: string): Promise<void> {
	if (waitsForMachines(line)) await allReady(page);
	await typed(page, line);
	if (inGuests(line)) {
		const targets = line.split(" ")[1].split(",").length;
		await expect(bar(page).locator(".machine-result").filter({ hasText: "exit 0" })).toHaveCount(targets);
		await page.keyboard.press("Escape");
	}
	await expect(bar(page).getByRole("alert")).toHaveCount(0);
	await expect(bar(page)).not.toHaveAttribute("open");
}

/** How many of its echoes alice's ping sent, and how many came back. */
async function ping(page: Page, count: number): Promise<{ sent: number; received: number }> {
	const { output } = await shell(page, "alice", `ping -c ${count} -i 0.2 -W 1 10.3.0.10`);
	const said = /(\d+) packets transmitted, (\d+) packets received/.exec(output);
	if (!said) throw new Error(output);
	return { sent: Number(said[1]), received: Number(said[2]) };
}

async function echoes(page: Page): Promise<readonly Row[]> {
	const reply = (await call(page, "capture_read", { filter: "icmp", limit: 1000 })) as { rows?: Row[]; error?: string };
	if (!reply.rows) throw new Error(reply.error);
	return reply.rows;
}

const end = (e: End) => (e.nic ? `${e.name}:${e.nic}` : String(e.name));
const hop = (row: Row) => {
	const tags = row.tagged ? ` tagged ${row.tagged.join(",")}` : "";
	const lost = (row.dropped ?? []).map(({ port, reason }) => ` lost at ${port} to ${reason}`).join("");
	return `${row.switch} ${row.in} → ${row.out?.join(",")} vlan ${row.vlan}${tags} ${end(row.from)} > ${end(row.to)} ${row.info.split(" seq")[0]}${lost}`;
};

/** One ping there and back: over the trunk in VLAN 10 to r1, out of r1 in VLAN 20 over the trunk again to r2, and out of r2 in VLAN 30 over the lossy cable to bob. */
const ROUND_TRIP = [
	"edge 1 → 8 vlan 10 tagged 8 alice > r1:eth0 echo request",
	"core 8 → 1 vlan 10 tagged 8 alice > r1:eth0 echo request",
	"core 2 → 8 vlan 20 tagged 8 r1:eth1 > r2:eth0 echo request",
	"edge 8 → 2 vlan 20 tagged 8 r1:eth1 > r2:eth0 echo request",
	"edge 3 → 4 vlan 30 r2:eth1 > bob echo request",
	"edge 4 → 3 vlan 30 bob > r2:eth1 echo reply",
	"edge 2 → 8 vlan 20 tagged 8 r2:eth0 > r1:eth1 echo reply",
	"core 8 → 2 vlan 20 tagged 8 r2:eth0 > r1:eth1 echo reply",
	"core 1 → 8 vlan 10 tagged 8 r1:eth0 > alice echo reply",
	"edge 8 → 1 vlan 10 tagged 8 r1:eth0 > alice echo reply",
];

/** A ping of ten from alice to bob: each echo that came back crossed every hop of the round trip in order, and the lossy cable counted it. */
async function crossed(page: Page): Promise<void> {
	const last = (await echoes(page)).at(-1)?.seq ?? 0;
	const before = await lossy(page);
	const { received } = await ping(page, 10);
	expect(received).toBeGreaterThan(0);
	const rows = (await echoes(page)).filter(({ seq }) => seq > last);
	const echo = (row: Row) => Number(/seq (\d+)/.exec(row.info)?.[1]);
	const answered = [...new Set(rows.filter((row) => hop(row) === ROUND_TRIP.at(-1)).map(echo))];
	expect(answered).toHaveLength(received);
	for (const seq of answered) {
		expect(rows.filter((row) => echo(row) === seq).map(hop), `echo ${seq}`).toEqual(ROUND_TRIP);
	}
	const after = await lossy(page);
	expect(after.delivered - before.delivered).toBeGreaterThanOrEqual(2 * received);
}

test("the recorded command set, typed into the bar, builds three subnets and two routers; a ping crosses both routers, the trunk and the lossy cable, every echo is answered at 0% and none at 100%, and a reload brings it all back", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	for (const line of LINES) await run(page, line);

	// Box 1: what the lines built, as the agent's tool reads it.
	expect(wiringOf(await topology(page))).toEqual(THREE_SUBNETS_WIRING);
	expect((await shell(page, "r2", "cat /proc/sys/net/ipv4/ip_forward")).output.trim()).toBe("1");

	// Box 2: the ping, hop by hop.
	await crossed(page);

	// Box 3: every echo at no loss, and none at all loss.
	await run(page, "link up r2:eth1 --loss 0");
	expect(await ping(page, 20)).toEqual({ sent: 20, received: 20 });
	await run(page, "link up r2:eth1 --loss 100%");
	const before = await lossy(page);
	expect(await ping(page, 20)).toEqual({ sent: 20, received: 0 });
	const after = await lossy(page);
	expect(after.delivered).toBe(before.delivered);
	expect(after.dropped.loss).toBeGreaterThan(before.dropped.loss);
	await run(page, "link up r2:eth1 --loss 10%");

	// Story 8.1 asks for spanning tree settings too, so they go in before the reload.
	for (const line of ["stp on core,edge", "priority core 4096", "cost edge:8 40000"]) await run(page, line);
	const tree = (lines: readonly string[]) => lines.filter((line) => line.includes("stp"));
	await expect
		.poll(async () => tree(wiringOf(await topology(page))))
		.toContain('edge:8 core:8 up {"mode":"trunk","allowed":[10,20],"native":1} {} stp root forwarding cost 40000');
	const wired = wiringOf(await topology(page));
	await crossed(page);
	const carried = await lossy(page);
	await expect.poll(() => learned(page, "edge")).toEqual(["alice", "r2:eth0", "r2:eth1", "bob", "r1:eth0", "r1:eth1"]);

	// Box 4: a reload, which boots every machine again with all that the lab held.
	await page.reload();
	await expect.poll(() => registered(page)).toContain("topology_read");
	await allReady(page);
	await expect.poll(async () => wiringOf(await topology(page))).toEqual(wired);
	expect((await lossy(page)).delivered).toBeLessThan(carried.delivered);
	await expect(await switchDetails(page, "edge")).toContainText("Nothing learned yet.");
	// A boot forgets routes and forwarding, so the lines that set them in the guests run again, and only those.
	for (const line of LINES.filter(inGuests)) await run(page, line);
	await crossed(page);
	expect(errors).toEqual([]);
});
