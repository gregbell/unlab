import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, shell, typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

/** When set, the tests also save screenshots of a lab with several switches there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

interface Port {
	readonly port: number;
	readonly cable: { readonly to: { machine: string; nic: string; state: string }; readonly link: string } | null;
}
interface Topology {
	readonly switches: readonly { readonly name: string; readonly ports: readonly Port[] }[];
	readonly unplugged: readonly { readonly machine: string; readonly nic: string }[];
}
interface Row {
	readonly kind: string;
	readonly switch?: string;
	readonly from: { readonly name?: string };
}

async function openLab(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const panel = (page: Page) => page.locator("unlab-switch");
const chooser = (page: Page) => panel(page).getByRole("combobox", { name: "Switch" });

/** Takes the only call that waits, as the person. */
async function approve(page: Page, action: string): Promise<void> {
	await page.locator("unlab-agent-panel").getByRole("button", { name: action, exact: true }).click();
}

async function topology(page: Page): Promise<Topology> {
	return ((await call(page, "topology_read", {})) as { data: Topology }).data;
}

/** `lan: 1 node2:eth0 up, 2 node3:eth0 cut` for each switch. */
async function wiring(page: Page): Promise<string[]> {
	const { switches } = await topology(page);
	return switches.map(({ name, ports }) => {
		const held = ports.flatMap(({ port, cable }) =>
			cable ? [`${port} ${cable.to.machine}:${cable.to.nic} ${cable.link}`] : [],
		);
		return `${name}: ${held.join(", ")}`;
	});
}

/** The frames of a machine that were captured, by the switch that carried them. */
async function carried(page: Page, filter: string, from: string): Promise<string[]> {
	const { rows } = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows: Row[] };
	return [...new Set(rows.filter((row) => row.from.name === from).map((row) => String(row.switch)))];
}

/** Keeps what broadcasts the machine's eth0 hears, from now on. */
async function listen(page: Page, machine: number): Promise<void> {
	await root(page, machine, "tcpdump -lnnei eth0 ether broadcast > /tmp/heard 2> /tmp/said < /dev/null &");
	await root(page, machine, "for i in $(seq 100); do grep -q listening /tmp/said && exit 0; sleep 0.1; done; exit 1");
}

const heard = async (page: Page, machine: number, from: string) =>
	(await root(page, machine, "cat /tmp/heard")).includes(`${from} > ff:ff:ff:ff:ff:ff`);

const reaches = async (page: Page, machine: number | string, address: string) =>
	(await shell(page, machine, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

const NODE1 = "52:54:00:88:00:0b";
const NODE3 = "52:54:00:88:00:0d";

test("a broadcast stays on its switch, and each switch has its own MAC table and counters to look at", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 2 lab --no-gateway");
	await ready(page, "2 of 2 ready");
	await typed(page, "spawn 2 lab --net lan --no-gateway");
	await ready(page, "4 of 4 ready");
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 2 node2:eth0 up",
		"lan: 1 node3:eth0 up, 2 node4:eth0 up",
	]);

	for (const machine of [2, 3, 4]) await listen(page, machine);
	await shell(page, 1, "ping -c 2 -W 1 10.88.0.99");
	expect(await heard(page, 2, NODE1)).toBe(true);
	expect(await heard(page, 3, NODE1)).toBe(false);
	expect(await heard(page, 4, NODE1)).toBe(false);
	expect(await carried(page, "arp node1", "node1")).toEqual(["switch0"]);

	await shell(page, 3, "ping -c 2 -W 1 10.88.0.98");
	expect(await heard(page, 4, NODE3)).toBe(true);
	expect(await heard(page, 2, NODE3)).toBe(false);
	expect(await carried(page, "arp node3", "node3")).toEqual(["lan"]);

	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await reaches(page, 3, "node4")).toBe(true);
	expect(await reaches(page, 1, "node3")).toBe(false);

	// The same addresses, by eye: each switch's own ports, counters and MAC table.
	const names = panel(page).locator(".port .name");
	const counters = async () =>
		(
			/^(\d+) in · (\d+) delivered · (\d+) flooded$/.exec(
				(await panel(page).locator(".counters").textContent()) ?? "",
			) ?? []
		)
			.slice(1)
			.map(Number);
	const captured = async (on: string) => {
		const { rows } = (await call(page, "capture_read", { limit: 1000 })) as { rows: Row[] };
		return rows.filter((row) => row.kind === "frame" && row.switch === on).length;
	};
	await page.getByRole("button", { name: "Maximise switches" }).click();
	await expect(chooser(page)).toHaveValue("switch0");
	await expect(names).toHaveText(["node1", "node2"]);
	await expect(page.locator("unlab-mac-table tbody .machine")).toHaveText(["node1", "node2"]);
	await expect(async () => expect((await counters())[0]).toBe(await captured("switch0"))).toPass({ timeout: 15_000 });

	await chooser(page).focus();
	await page.keyboard.press("ArrowDown");
	await expect(chooser(page)).toHaveValue("lan");
	await expect(names).toHaveText(["node3", "node4"]);
	await expect(page.locator("unlab-mac-table tbody .machine")).toHaveText(["node3", "node4"]);
	await expect(page.locator("unlab-mac-table").getByRole("heading")).toHaveText("lan mac address table");
	await expect(async () => expect((await counters())[0]).toBe(await captured("lan"))).toPass({ timeout: 15_000 });
	const [lanIn] = await counters();
	expect(lanIn).toBeGreaterThan(0);
	expect(lanIn).not.toBe(await captured("switch0"));
	const axe = await new AxeBuilder({ page }).include("unlab-switch").analyze();
	expect(axe.violations.map((v) => v.id)).toEqual([]);
	if (shots) await page.screenshot({ path: `${shots}/switch-lan-maximised.png` });
	await page.keyboard.press("Escape");
	if (shots) await page.screenshot({ path: `${shots}/switch-lan-dock.png` });
	expect(errors).toEqual([]);
});

test("a switch is added by a chosen name or the next free one, and a taken name and a ninth are refused", async ({
	page,
}) => {
	await openLab(page);
	// A name that a saved lab may have given a machine is skipped.
	await typed(page, "spawn 1 alpine --name switch1 --no-gateway");
	await ready(page, "1 of 1 ready");
	await typed(page, "mkswitch lan");
	await expect(chooser(page).getByRole("option")).toHaveText(["switch0", "lan"]);
	await typed(page, "mkswitch");
	await expect(chooser(page).getByRole("option")).toHaveText(["switch0", "lan", "switch2"]);
	expect(await call(page, "switch_add", { name: "wan" })).toEqual({ result: "added wan", data: { name: "wan" } });
	expect(await call(page, "switch_add", {})).toEqual({ result: "added switch3", data: { name: "switch3" } });

	const refused = async (line: string, tool: string, input: object, sentence: string) => {
		const said = `${sentence} Nothing was changed.`;
		expect(await call(page, tool, input), line).toEqual({ error: said });
		await typed(page, line);
		const alert = bar(page).getByRole("alert");
		await expect(alert).toBeVisible();
		expect((await alert.locator("p").allTextContents()).join(" "), line).toBe(said);
		await page.keyboard.press("Escape");
	};
	await refused("mkswitch lan", "switch_add", { name: "lan" }, "A switch is already called lan, so give another name.");
	await refused(
		"mkswitch switch1",
		"switch_add",
		{ name: "switch1" },
		"A machine is already called switch1, so give another name.",
	);
	await refused(
		"spawn 1 alpine --name lan",
		"machines_spawn",
		{ count: 1, image: "alpine", name: "lan" },
		"A switch is already called lan, so give another name with --name.",
	);
	await refused(
		"spawn 1 alpine --net dmz",
		"machines_spawn",
		{ count: 1, image: "alpine", net: "dmz" },
		"spawn wants switch0, lan, switch2, wan, switch3 or none after --net, not dmz.",
	);
	await refused(
		"rmswitch switch0",
		"switch_remove",
		{ switch: "switch0" },
		"switch0 cannot be removed, so use lan, switch2, wan or switch3.",
	);
	for (const name of ["a", "b", "c"]) await call(page, "switch_add", { name });
	expect((await topology(page)).switches).toHaveLength(8);
	const limit = "The lab has all 8 switches that it can, so remove one with rmswitch first.";
	await refused("mkswitch d", "switch_add", { name: "d" }, limit);

	// They are there at once: a machine is on one of them without another step.
	await typed(page, "spawn 1 alpine --net c --no-gateway");
	await ready(page, "2 of 2 ready");
	expect(await wiring(page)).toContain("c: 1 node2:eth0 up");
});

test("each NIC goes on the switch that spawn names, or on none", async ({ page }) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --no-gateway --addr 10.1.0.1/24");
	await ready(page, "1 of 1 ready");
	await typed(page, "spawn 1 alpine --net lan --no-gateway --addr 10.2.0.2/24");
	await ready(page, "2 of 2 ready");
	await typed(page, "spawn 1 alpine --nics 3 --net lan,none,switch0 --no-gateway --addr 10.2.0.3/24,none,10.1.0.3/24");
	await ready(page, "3 of 3 ready");
	const wired = await topology(page);
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 2 node3:eth2 up",
		"lan: 1 node2:eth0 up, 2 node3:eth0 up",
	]);
	expect(wired.unplugged).toEqual([{ kind: "nic", machine: "node3", nic: "eth1", state: "ready" }]);
	expect(wired.switches.map(({ ports }) => ports.length)).toEqual([8, 8]);
	expect(await reaches(page, 1, "10.1.0.3")).toBe(true);
	expect(await reaches(page, 2, "10.2.0.3")).toBe(true);

	await typed(page, "link down node3:eth0");
	await typed(page, "topology");
	const report = bar(page).locator(".result");
	await expect(report.locator(".header")).toHaveText("2 switches · 4 of 16 ports taken");
	await expect(report.locator("dt")).toHaveText(["switch0", "lan", "unplugged"]);
	expect(await report.locator("dd").allInnerTexts()).toEqual([
		"port 1 · node1 · up\nport 2 · node3:eth2 · up\nports 3, 4, 5, 6, 7 and 8 · free",
		"port 1 · node2 · up\nport 2 · node3:eth0 · cut\nports 3, 4, 5, 6, 7 and 8 · free",
		"node3:eth1 · no cable",
	]);
	if (shots) await page.screenshot({ path: `${shots}/topology.png` });
	await page.keyboard.press("Escape");
	expect(await wiring(page)).toContain("lan: 1 node2:eth0 up, 2 node3:eth0 cut");
	await expect(page.locator("unlab-capture[mode=dock]")).toContainText("lan port 2 link down");
});

test("a switch asks before it goes, unplugs what is in it, and leaves the machines running", async ({ page }) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "mkswitch wan");
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await ready(page, "1 of 1 ready");
	await typed(page, "spawn 1 alpine --nics 2 --net lan,switch0 --no-gateway");
	await ready(page, "2 of 2 ready");
	expect(await reaches(page, 1, "node2")).toBe(true);
	await root(page, 1, "nohup sleep 9999 > /dev/null 2>&1 < /dev/null &");
	const bootId = await root(page, 1, "cat /proc/sys/kernel/random/boot_id");

	// The person is asked once, with nothing plugged in.
	await typed(page, "rmswitch wan");
	const asked = bar(page).locator("unlab-confirm");
	await expect(asked).toContainText("Remove wan?");
	await expect(asked).toContainText("Nothing is plugged into it.");
	expect((await topology(page)).switches).toHaveLength(3);
	await page.keyboard.press("Enter");
	await expect(chooser(page).getByRole("option")).toHaveText(["switch0", "lan"]);

	await chooser(page).selectOption("lan");
	await start(page, "denied", "switch_remove", { switch: "lan" });
	const waiting = page.locator("unlab-agent-panel unlab-confirm");
	await expect(waiting).toContainText("rmswitch lan");
	await expect(waiting).toContainText("This unplugs node1 from port 1 and node2:eth0 from port 2.");
	await expect(waiting).toHaveCount(1);
	await approve(page, "Deny");
	expect(await finish(page, "denied")).toEqual({ error: "Denied by the user." });
	expect((await wiring(page))[1]).toBe("lan: 1 node1:eth0 up, 2 node2:eth0 up");

	await start(page, "removed", "switch_remove", { switch: "lan" });
	await approve(page, "Remove lan");
	expect(await finish(page, "removed")).toEqual({
		result: "removed lan · node1 and node2:eth0 unplugged",
		data: {
			removed: "lan",
			unplugged: [
				{ machine: "node1", nic: "eth0" },
				{ machine: "node2", nic: "eth0" },
			],
		},
	});
	await expect(waiting).toHaveCount(0);

	// The link is down, and the same kernel and program run on.
	await expect(page.locator("unlab-capture[mode=dock]")).toContainText("lan port 1 link down");
	expect(await reaches(page, 1, "node2")).toBe(false);
	expect(await root(page, 1, "cat /proc/sys/kernel/random/boot_id")).toBe(bootId);
	expect(await root(page, 1, "pidof sleep")).not.toBe("");
	await ready(page, "2 of 2 ready");
	expect(await topology(page)).toMatchObject({
		unplugged: [
			{ machine: "node1", nic: "eth0" },
			{ machine: "node2", nic: "eth0" },
		],
	});
	expect(await wiring(page)).toEqual(["switch0: 1 node2:eth1 up"]);
	await expect(panel(page).locator(".title")).toHaveText("switch0");
	await expect(chooser(page)).toHaveCount(0);

	// Its name is free, and the one that takes it starts empty.
	await typed(page, "mkswitch lan");
	await chooser(page).selectOption("lan");
	await expect(panel(page).locator(".counters")).toHaveText("0 in · 0 delivered · 0 flooded");
	await page.getByRole("button", { name: "Maximise switches" }).click();
	await expect(page.locator("unlab-mac-table")).toContainText("Nothing learned yet.");
	await page.keyboard.press("Escape");
	await typed(page, "rmswitch lan");
	await page.keyboard.press("Enter");
	await expect(chooser(page)).toHaveCount(0);

	await page.reload();
	await ready(page, "2 of 2 ready");
	expect(await wiring(page)).toEqual(["switch0: 1 node2:eth1 up"]);
	expect(await reaches(page, 1, "node2")).toBe(false);

	expect(await call(page, "link_set", { link: "up", machines: "node1,node2:eth0" })).toEqual({
		result: "node1 up, node2:eth0 up",
		data: [
			{ machine: "node1", nic: "eth0", port: 2, link: "up" },
			{ machine: "node2", nic: "eth0", port: 3, link: "up" },
		],
	});
	expect(await reaches(page, 1, "node2")).toBe(true);
});

test("a reload brings back every switch and what was plugged in, with tables and counters empty", async ({ page }) => {
	await openLab(page);
	for (const name of ["wan", "", "lan"]) await typed(page, `mkswitch ${name}`.trim());
	await typed(page, "spawn 2 alpine --net lan --no-gateway");
	await ready(page, "2 of 2 ready");
	await typed(page, "spawn 1 alpine --nics 2 --net wan,switch0 --no-gateway");
	await ready(page, "3 of 3 ready");
	await typed(page, "link down node3:eth0");
	await chooser(page).selectOption("lan");
	expect((await shell(page, 1, "ping -c 60 -i 0.05 node2")).exitCode).toBe(0);
	const before = await topology(page);
	expect(before.switches.map(({ name }) => name)).toEqual(["switch0", "wan", "switch1", "lan"]);
	const counted = async () => Number(/^\d+/.exec((await panel(page).locator(".counters").textContent()) ?? "")?.[0]);
	await expect.poll(counted).toBeGreaterThan(120);

	await page.reload();
	await ready(page, "3 of 3 ready");
	expect(await topology(page)).toEqual(before);
	await expect(chooser(page)).toHaveValue("lan");
	expect(await counted()).toBeLessThan(60);
	await chooser(page).selectOption("switch1");
	await expect(panel(page).locator(".counters")).toHaveText("0 in · 0 delivered · 0 flooded");
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await reaches(page, 1, "node3")).toBe(false);
});
