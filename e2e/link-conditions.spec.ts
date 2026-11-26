import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

type Conditions = Readonly<Partial<Record<"delay" | "loss" | "reorder" | "rate" | "mtu", string>>>;
interface Carried {
	readonly delivered: number;
	readonly dropped: { readonly loss: number; readonly rate: number; readonly mtu: number };
}
interface Topology {
	readonly switches: readonly {
		readonly name: string;
		readonly ports: readonly {
			readonly port: number;
			readonly cable: { readonly conditions: Conditions; readonly carried: Carried } | null;
		}[];
	}[];
}
interface Row {
	readonly switch?: string;
	readonly in?: number;
	readonly info: string;
	readonly note: string | null;
	readonly dropped?: readonly { readonly port: number; readonly reason: string }[];
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const panel = (page: Page) => page.locator("unlab-switch");

/** The cable in a port such as `switch0:1`, as topology_read has it. */
async function cable(page: Page, name: string) {
	const { switches } = ((await call(page, "topology_read", {})) as { data: Topology }).data;
	const [on, no] = name.split(":");
	const found = switches.find((sw) => sw.name === on)?.ports[Number(no) - 1]?.cable;
	if (!found) throw new Error(`${name} has no cable`);
	return found;
}

async function read(page: Page, filter: string): Promise<readonly Row[]> {
	const reply = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows?: Row[]; error?: string };
	if (!reply.rows) throw new Error(`${filter}: ${reply.error}`);
	return reply.rows;
}

const reaches = async (page: Page, machine: number, to: string, options = "") =>
	(await shell(page, machine, `ping -c 1 -W 1 ${options} ${to}`)).exitCode === 0;

/** A ping's average round trip in ms, by the guest's own clock. */
async function roundTrip(page: Page, machine: number, to: string): Promise<number> {
	const { output } = await shell(page, machine, `ping -c 3 -W 2 ${to}`);
	const avg = /min\/avg\/max = [\d.]+\/([\d.]+)\//.exec(output);
	if (!avg) throw new Error(output);
	return Number(avg[1]);
}

/** What a line that cannot run says, in the bar and from its tool. */
async function refused(page: Page, line: string, input: object, sentence: string): Promise<void> {
	const said = `${sentence} Nothing was changed.`;
	expect(await call(page, "link_set", input), line).toEqual({ error: said });
	await typed(page, line);
	const alert = bar(page).getByRole("alert");
	await expect(alert, line).toBeVisible();
	expect((await alert.locator("p").allTextContents()).join(" "), line).toBe(said);
	await page.keyboard.press("Escape");
}

const sorted = (list: readonly number[]): boolean => list.every((n, i) => i === 0 || list[i - 1] <= n);

test("one command gives a NIC's cable or a cable between switches a delay, loss and an MTU, in both directions and with no reboot, clears them, and a reload brings them back", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --no-gateway");
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await ready(page, "2 of 2 ready");
	await typed(page, "cable switch0:8 lan:8");
	await shell(page, 1, "touch /tmp/since-boot");
	expect(await reaches(page, 1, "node2")).toBe(true);
	const base = await roundTrip(page, 1, "node2");
	expect(await cable(page, "switch0:1")).toMatchObject({
		conditions: {},
		carried: { dropped: { loss: 0, rate: 0, mtu: 0 } },
	});

	// A delay: from the bar on a NIC's cable, and from the tool on the cable between the switches, by its far port.
	await typed(page, "link up node1 --delay 100ms");
	await expect.poll(async () => (await cable(page, "switch0:1")).conditions).toEqual({ delay: "100ms" });
	// No less than the delay each way, and little more than that on top of what the ping took before.
	const one = await roundTrip(page, 1, "node2");
	expect(one).toBeGreaterThanOrEqual(200);
	expect(one).toBeLessThan(200 + base + 60);
	expect(await call(page, "link_set", { link: "up", machines: "lan:8", delay: "100ms" })).toEqual({
		result: "lan:8 up with delay 100 ms",
		data: [{ switch: "lan", port: 8, to: { switch: "switch0", port: 8 }, link: "up", conditions: { delay: "100ms" } }],
	});
	expect([(await cable(page, "switch0:8")).conditions, (await cable(page, "lan:8")).conditions]).toEqual([
		{ delay: "100ms" },
		{ delay: "100ms" },
	]);
	const two = await roundTrip(page, 2, "node1");
	expect(two).toBeGreaterThanOrEqual(400);
	expect(two).toBeLessThan(400 + base + 70);
	await expect(panel(page).locator(".port[data-port='1'] .nic")).toHaveText("impaired");
	await expect(panel(page).locator(".port[data-port='8'] .nic")).toHaveText("port 8 impaired");
	await expect(panel(page).locator(".port[data-port='1']")).toHaveAttribute(
		"title",
		/^node1 · delay 100 ms · \d+ delivered · 0 dropped$/,
	);

	await typed(page, "link up node1,switch0:8 --clear");
	await expect.poll(async () => (await cable(page, "lan:8")).conditions).toEqual({});
	expect(await roundTrip(page, 1, "node2")).toBeLessThan(base + 20);
	await expect(panel(page).locator(".port[data-port='1'] .nic")).toHaveCount(0);

	// Loss, in both directions of the cable between the switches, with each lost frame in the capture and counted.
	await call(page, "link_set", { link: "up", machines: "switch0:8", loss: "100%" });
	expect(await reaches(page, 1, "node2")).toBe(false);
	expect(await reaches(page, 2, "node1")).toBe(false);
	const lost = (await read(page, "icmp")).filter((row) => row.dropped);
	expect(lost.map((row) => `${row.switch} ${row.note?.split(" · ").at(-1)}`).sort()).toEqual([
		"lan dropped by the cable out of lan port 8: loss",
		"switch0 dropped by the cable out of switch0 port 8: loss",
	]);
	const counted = await cable(page, "switch0:8");
	expect(counted.carried.dropped.loss).toBeGreaterThanOrEqual(2);
	expect((await cable(page, "lan:8")).carried).toEqual(counted.carried);
	await typed(page, "link up switch0:8 --loss 0");
	await expect.poll(() => reaches(page, 1, "node2")).toBe(true);

	// An MTU, on a NIC's cable: a packet of that size passes, and one byte more is dropped on its way to the switch.
	await typed(page, "link up node1 --mtu 1400");
	await expect.poll(async () => (await cable(page, "switch0:1")).conditions).toEqual({ mtu: "1400" });
	expect(await reaches(page, 1, "node2", "-s 1372")).toBe(true);
	expect(await reaches(page, 1, "node2", "-s 1373")).toBe(false);
	const long = (await read(page, "icmp")).filter((row) => row.dropped?.some(({ reason }) => reason === "mtu"));
	expect(long.map((row) => [row.switch, row.in, row.note])).toEqual([
		["switch0", 1, "dropped by the cable into switch0 port 1: MTU"],
	]);
	expect((await cable(page, "switch0:1")).carried.dropped).toEqual({ loss: 0, rate: 0, mtu: 1 });
	await expect(panel(page).locator(".port[data-port='1']")).toHaveAttribute(
		"title",
		/mtu 1400 · \d+ delivered · 1 dropped \(1 by MTU\)$/,
	);
	const { output } = await shell(page, 1, "sudo -n true 2>/dev/null; ls /tmp/since-boot");
	expect(output).toContain("/tmp/since-boot");

	await refused(
		page,
		"link up node1 --reorder 25%",
		{ link: "up", machines: "node1", reorder: "25%" },
		"Reordering lets frames skip a cable's delay, and node1 has none, so give --delay too, such as --delay 20ms.",
	);
	await refused(
		page,
		"link up node1 --mtu 9000",
		{ link: "up", machines: "node1", mtu: 9000 },
		"9000 is no MTU, so use one from 68 to 1500 bytes, such as 1400.",
	);

	await typed(page, "link up lan:8 --delay 30ms --loss 0.5%");
	await expect.poll(async () => (await cable(page, "lan:8")).conditions).toEqual({ delay: "30ms", loss: "0.5%" });
	await page.reload();
	await ready(page, "2 of 2 ready");
	expect([(await cable(page, "switch0:1")).conditions, (await cable(page, "switch0:8")).conditions]).toEqual([
		{ mtu: "1400" },
		{ delay: "30ms", loss: "0.5%" },
	]);
	expect((await cable(page, "switch0:1")).carried.dropped).toEqual({ loss: 0, rate: 0, mtu: 0 });
	expect(await reaches(page, 1, "node2", "-s 1373")).toBe(false);
	expect(await roundTrip(page, 1, "node2")).toBeGreaterThan(55);
	expect(errors).toEqual([]);
});

test("with reordering, pings arrive out of order and the capture shows it, and with a rate, the frames that its queue has no room for are dropped and say so", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "spawn 2 alpine --no-gateway");
	await ready(page, "2 of 2 ready");
	expect(await reaches(page, 1, "node2")).toBe(true);

	await typed(page, "link up node1 --delay 50ms --reorder 50%");
	await expect.poll(async () => (await cable(page, "switch0:1")).conditions).toEqual({ delay: "50ms", reorder: "50%" });
	await typed(page, "capture");
	await page.keyboard.press("Escape");
	const before = (await read(page, "icmp")).length;
	const { output } = await shell(page, 1, "ping -c 40 -i 0.01 -W 2 node2");
	const answered = [...output.matchAll(/seq=(\d+)/g)].map((m) => Number(m[1]));
	expect(answered).toHaveLength(40);
	expect(sorted(answered)).toBe(false);
	// The switch's rows are in the order that it took the frames in: the requests came out of order too.
	const requests = (await read(page, "icmp"))
		.slice(before)
		.flatMap((row) => /^echo request seq (\d+)/.exec(row.info)?.[1] ?? [])
		.map(Number);
	expect(requests.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
	expect(sorted(requests)).toBe(false);

	// At 8 kbit/s a byte takes a millisecond, so 64 KiB of pings wait and the rest of 50 sent in half a second do not.
	await call(page, "link_set", { link: "up", machines: "node1", conditions: "clear", rate: "8kbit" });
	expect((await cable(page, "switch0:1")).conditions).toEqual({ rate: "8kbit" });
	await shell(page, 1, "ping -c 50 -i 0.01 -s 1400 -W 1 -q node2");
	const { carried } = await cable(page, "switch0:1");
	expect(carried.dropped.rate).toBeGreaterThanOrEqual(4);
	expect(carried.dropped.rate).toBeLessThanOrEqual(6);
	const over = (await read(page, "icmp")).filter((row) => row.dropped?.some(({ reason }) => reason === "rate"));
	expect(over).toHaveLength(carried.dropped.rate);
	expect(new Set(over.map((row) => row.note))).toEqual(new Set(["dropped by the cable into port 1: rate"]));

	// Cleared, the cable is as a new one: what waited on it arrives, and a ping is answered at once.
	await typed(page, "link up node1 --clear");
	await expect.poll(async () => (await cable(page, "switch0:1")).conditions).toEqual({});
	expect(await roundTrip(page, 1, "node2")).toBeLessThan(30);
	expect(errors).toEqual([]);
});

test("the desktop says a cable's conditions where it shows the cable: in the switch's ports with what it dropped, in the machine's network, and on the map", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Welcome to unLAB" })).toBeVisible();
	await typed(page, "spawn 2 alpine --no-gateway");
	const rack = page.getByRole("region", { name: "Rack manager" });
	await rack.getByRole("button", { name: "Inspect switch0" }).click();
	const details = page.getByRole("region", { name: "switch0 · Switch details" });
	const ports = details.getByRole("table", { name: "Ports on switch0" });
	const row = (port: number) =>
		ports.getByRole("row").filter({ has: page.getByRole("rowheader", { name: String(port), exact: true }) });
	await expect(row(2)).toContainText("up", { timeout: 90_000 });
	await expect(ports.getByRole("columnheader", { name: "Conditions" })).toHaveCount(0);
	expect(await reaches(page, 1, "node2")).toBe(true);

	await typed(page, "link up node1 --delay 20ms --loss 100%");
	await expect(ports.getByRole("columnheader", { name: "Conditions" })).toBeVisible();
	await expect(row(1)).toContainText("delay 20 ms, loss 100%");
	await expect(row(2).getByRole("cell").nth(2)).toHaveText("—");
	expect(await reaches(page, 1, "node2")).toBe(false);
	await expect(row(1)).toContainText(/\d+ delivered · \d+ dropped \(\d+ by loss\)/);

	const map = page.getByRole("region", { name: "Topology" });
	await expect(map.locator(".n-node[data-machine='node1'] small")).toHaveText("alpine · impaired");
	await expect(map.locator(".n-node[data-machine='node2'] small")).toHaveText("alpine");
	await expect(map.locator(".n-node[data-switch='switch0'] small")).toHaveText("2 / 8 ports · impaired");
	await expect(map.locator(".wire[data-conditions]")).toHaveCount(1);
	await expect(rack.getByRole("button", { name: "Inspect switch0" })).toHaveAttribute(
		"aria-description",
		/Port 1 · node1 · up · delay 20 ms, loss 100%\./,
	);
	await rack.getByRole("button", { name: "Configure node1" }).click();
	await expect(
		page
			.getByRole("region", { name: /node1 · / })
			.locator(".dt-link small")
			.last(),
	).toHaveText("up · delay 20 ms, loss 100%");

	await typed(page, "link up node1 --clear");
	await expect(ports.getByRole("columnheader", { name: "Conditions" })).toHaveCount(0);
	await expect(map.locator(".n-node[data-machine='node1'] small")).toHaveText("alpine");
	await expect(map.locator(".wire[data-conditions]")).toHaveCount(0);
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(errors).toEqual([]);
});
