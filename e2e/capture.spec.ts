import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

/** When set, the tests also save screenshots of the capture there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

interface End {
	readonly kind: string;
	readonly name?: string;
	readonly nic?: string;
}
interface Row {
	readonly seq: number;
	readonly time: string;
	readonly proto: string;
	readonly switch?: string;
	readonly in?: number;
	readonly out?: readonly number[];
	readonly from: End;
	readonly to: End;
	readonly len: number;
	readonly info: string;
}

const status = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const full = (page: Page) => page.locator("unlab-capture[mode=full]");
const dock = (page: Page) => page.locator("unlab-capture[mode=dock]");

async function read(page: Page, filter: string): Promise<readonly Row[]> {
	const reply = (await call(page, "capture_read", { filter, limit: 1000 })) as { rows?: Row[]; error?: string };
	if (!reply.rows) throw new Error(`${filter}: ${reply.error}`);
	return reply.rows;
}

/** node1 and node4 in different subnets, with two routers and a switch of their own between them. */
async function routed(page: Page): Promise<void> {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "mkswitch mid");
	await typed(page, "mkswitch far");
	await typed(page, "spawn 1 alpine --no-gateway --addr 10.1.0.2/24");
	await typed(page, "spawn 1 alpine --name r1 --nics 2 --net switch0,mid --no-gateway --addr 10.1.0.1/24,10.2.0.1/24");
	await typed(page, "spawn 1 alpine --name r2 --nics 2 --net mid,far --no-gateway --addr 10.2.0.2/24,10.3.0.1/24");
	await typed(page, "spawn 1 alpine --net far --no-gateway --addr 10.3.0.2/24");
	await status(page, "4 of 4 ready");
	await root(page, "node1", "ip route add default via 10.1.0.1");
	await root(page, "r1", "sysctl -w net.ipv4.ip_forward=1; ip route add 10.3.0.0/24 via 10.2.0.2");
	await root(page, "r2", "sysctl -w net.ipv4.ip_forward=1; ip route add 10.1.0.0/24 via 10.2.0.1");
	await root(page, "node4", "ip route add default via 10.3.0.1");
	// Every ARP cache and MAC table on the way is filled.
	await expect.poll(() => pinged(page, 1), { timeout: 30_000 }).toBe(true);
}

const pinged = async (page: Page, count: number) =>
	(await shell(page, "node1", `ping -c ${count} -W 2 10.3.0.2`)).output.includes(`${count} packets received`);

const end = (e: End) => (e.nic ? `${e.name}:${e.nic}` : String(e.name));
const hop = (row: Row) =>
	`${row.switch} ${row.in} → ${row.out?.join(",")} ${end(row.from)} > ${end(row.to)} ${row.info.split(" seq")[0]}`;

/** One ping there and back, each hop with the ports that the topology has its ends in. */
const PING = [
	"switch0 1 → 2 node1 > r1:eth0 echo request",
	"mid 1 → 2 r1:eth1 > r2:eth0 echo request",
	"far 1 → 2 r2:eth1 > node4 echo request",
	"far 2 → 1 node4 > r2:eth1 echo reply",
	"mid 2 → 1 r2:eth0 > r1:eth1 echo reply",
	"switch0 2 → 1 r1:eth0 > node1 echo reply",
];

test("a ping across two routers is captured at every hop in order, each with its switch and ports", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await routed(page);
	const before = (await read(page, "icmp")).length;
	expect(await pinged(page, 3)).toBe(true);

	const rows = (await read(page, "icmp")).slice(before);
	expect(rows.map(hop)).toEqual([...PING, ...PING, ...PING]);
	expect(rows.map(({ seq }) => seq)).toEqual(rows.map(({ seq }) => seq).sort((a, b) => a - b));
	// A ping takes less than its clock shows, so hops on different switches have one time.
	expect(rows.some((row, i) => i > 0 && rows[i - 1].time === row.time && rows[i - 1].switch !== row.switch)).toBe(true);

	// A person sees the same, in the panel that the bar's verb maximises and in a frame's detail.
	await typed(page, "capture icmp");
	const via = full(page).locator(".row.frame .via");
	await expect(via.last()).toHaveText("switch0 2 → 1");
	const shown = await via.allTextContents();
	expect(shown.slice(-6)).toEqual(PING.map((line) => line.split(" ").slice(0, 4).join(" ")));
	await expect(via.last()).toHaveAttribute("title", "On switch0, in by port 2 and out of port 1.");
	await full(page).getByRole("option").nth(-5).click();
	const detail = page.locator("unlab-frame-detail");
	await expect(detail).toContainText("in on mid port 1");
	await expect(detail).toContainText("mid had learned r2:eth0 on mid port 2, so it forwarded the frame there only.");
	if (shots) await page.screenshot({ path: `${shots}/two-routers.png` });
	await page.keyboard.press("Escape");
	await expect(dock(page).locator(".row.frame .via").first()).toBeVisible();
	if (shots) await page.screenshot({ path: `${shots}/two-routers-dock.png` });
	expect(errors).toEqual([]);
});

test("a filter takes a switch or one cable, beside the other terms, the same in the bar, the panel and capture_read", async ({
	page,
}) => {
	await routed(page);
	expect(await pinged(page, 2)).toBe(true);
	await typed(page, "link down node4");
	await typed(page, "link up node4");
	expect(await pinged(page, 1)).toBe(true);
	const all = await read(page, "");
	const on = (row: Row, name: string, port?: number) =>
		row.switch === name && (port === undefined || row.in === port || (row.out ?? []).includes(port));
	const icmp = (row: Row) => row.proto === "ICMP";
	const of = (row: Row, text: string) => [row.from, row.to].some((e) => end(e) === text || e.name === text);

	for (const [filter, test] of [
		["mid", (row) => on(row, "mid")],
		["MID:1", (row) => on(row, "mid", 1)],
		["mid:1 icmp", (row) => on(row, "mid", 1) && icmp(row)],
		["far:2 arp", (row) => on(row, "far", 2) && row.proto === "ARP"],
		["far:8", () => false],
		["switch0:1 or far:2 icmp", (row) => on(row, "switch0", 1) || (on(row, "far", 2) && icmp(row))],
		["port:1", (row) => on(row, String(row.switch), 1)],
		["far port:1 icmp", (row) => on(row, "far", 1) && icmp(row)],
		["icmp r1:eth1", (row) => icmp(row) && of(row, "r1:eth1")],
		["icmp r1:eth1 switch0", () => false],
	] as readonly (readonly [string, (row: Row) => boolean])[]) {
		const want = all.filter(test).map(({ seq }) => seq);
		expect(
			(await read(page, filter)).map(({ seq }) => seq).filter((seq) => seq <= all[all.length - 1].seq),
			filter,
		).toEqual(want);
		await typed(page, `capture ${filter}`);
		await expect(full(page).getByRole("textbox", { name: "filter" })).toHaveValue(filter);
		await expect(full(page).getByRole("textbox", { name: "filter" })).toHaveAttribute("aria-invalid", "false");
		await expect.poll(async () => (await full(page).locator(".matches").textContent())?.split(" ")[0]).not.toBe("");
		const counted = Number((await full(page).locator(".matches").textContent())?.split(" ")[0]);
		expect(counted, filter).toBe((await read(page, filter)).length);
		await page.keyboard.press("Escape");
	}
	expect((await read(page, "mid:1 icmp")).length).toBe(8);

	// Typed in the panel itself. Each cable has its own event rows.
	await page.getByRole("button", { name: "Maximise capture" }).click();
	const field = full(page).getByRole("textbox", { name: "filter" });
	await field.fill("far:2 icmp");
	const events = full(page).locator(".row.event");
	await expect(events).toContainText([
		"far port 2 link up. Cable to node4 plugged in by the lab.",
		"far port 2 link down. Cable to node4 cut by you.",
		"far port 2 link up. Cable to node4 reconnected by you.",
	]);
	await expect(full(page).locator(".row.frame .via").first()).toHaveText("far 1 → 2");
	if (shots) await page.screenshot({ path: `${shots}/one-cable.png` });
	await field.fill("mid:2 icmp");
	await expect(full(page).locator(".row.frame .via").first()).toHaveText("mid 1 → 2");
	await expect(events).toContainText(["mid port 2 link up. Cable to r2:eth0 plugged in by the lab."]);
	await expect(events).toHaveCount(1);
	await field.fill("mid:2 icmp nowhere:2");
	await expect(field).toHaveAttribute("aria-invalid", "true");
	await field.fill("");
	await page.keyboard.press("Escape");

	// The bar completes a term and marks one that is at fault. capture_read says the same of it.
	await page.keyboard.press("Control+/");
	const command = page.getByRole("combobox", { name: "Command" });
	await command.fill("capture icmp mid:");
	await expect(bar(page).getByRole("option").first()).toContainText("r1:eth1");
	await command.press("Tab");
	await expect(command).toHaveValue("capture icmp mid:1 ");
	await page.keyboard.press("Escape");
	for (const [filter, at, sentence] of [
		["icmp mid:9", "mid:9", "mid:9 is no port, so use one from mid:1 to mid:8."],
		["icmp or mdi:2", "mdi:2", "No switch is called mdi, so use switch0, mid or far."],
		[
			"bogus",
			"bogus",
			"Capture cannot read bogus, so use a protocol, a machine, a NIC (node2:eth1), a switch (lan), a cable (lan:3), an address, a MAC, vlan N or port:N.",
		],
	] as const) {
		expect(await call(page, "capture_read", { filter })).toEqual({ error: sentence });
		await typed(page, `capture ${filter}`);
		const alert = bar(page).getByRole("alert");
		await expect(alert).toContainText(sentence.replace(/^Capture/, "capture"));
		await expect(alert).toContainText("Nothing was changed.");
		await expect(alert.locator(".bad")).toHaveText(at);
		await page.keyboard.press("Escape");
	}

	// One text for both.
	const help = (await call(page, "lab_help", { verb: "capture" })) as { data: { arguments: { about: string }[] } };
	const described = await page.evaluate(async () => {
		const tools = (await document.modelContext.getTools()) as unknown as {
			name: string;
			inputSchema: string | { properties: { filter: { description: string } } };
		}[];
		const schema = tools.find(({ name }) => name === "capture_read")?.inputSchema;
		const read = typeof schema === "string" ? JSON.parse(schema) : schema;
		return read.properties.filter.description as string;
	});
	expect(described).toBe(help.data.arguments[0].about);
	for (const term of ["switch (lan)", "cable (lan:3)", "port:N"]) expect(described).toContain(term);

	// A switch that is gone keeps its name for what it carried.
	const carried = (await read(page, "far icmp")).length;
	await typed(page, "rmswitch far");
	await page.keyboard.press("Enter");
	await expect(dock(page)).toContainText("far port 1 link down. Cable to r2:eth1 unplugged by you.");
	expect((await read(page, "far icmp")).length).toBe(carried);
	expect((await read(page, "far:2 icmp")).length).toBe(carried);
});

interface Saved {
	readonly name: string;
	readonly bytes: Buffer;
	readonly frames: readonly { readonly at: number; readonly bytes: Buffer }[];
}

/** Saves the capture as a person does, with save .pcap or else with a line, and reads the file. */
async function saved(page: Page, line?: string): Promise<Saved> {
	const [file] = await Promise.all([
		page.waitForEvent("download"),
		line === undefined ? full(page).getByRole("button", { name: "save .pcap" }).click() : typed(page, line),
	]);
	const bytes = readFileSync(await file.path());
	expect([bytes.readUInt32LE(0), bytes.readUInt32LE(20)]).toEqual([0xa1b2c3d4, 1]);
	const frames: { at: number; bytes: Buffer }[] = [];
	for (let o = 24; o < bytes.length; o += 16 + bytes.readUInt32LE(o + 8)) {
		const at = bytes.readUInt32LE(o) * 1e6 + bytes.readUInt32LE(o + 4);
		frames.push({ at, bytes: bytes.subarray(o + 16, o + 16 + bytes.readUInt32LE(o + 8)) });
	}
	return { name: file.suggestedFilename(), bytes, frames };
}

/** The file that capture_save gives an agent for the filter. */
async function given(page: Page, filter: string): Promise<Pick<Saved, "name" | "bytes">> {
	const reply = (await call(page, "capture_save", { filter })) as { data?: { name: string; bytes: string } };
	if (!reply.data) throw new Error(`capture_save ${filter}: ${JSON.stringify(reply)}`);
	return { name: reply.data.name, bytes: Buffer.from(reply.data.bytes, "base64") };
}

/** `request 2`, for each ping in the file. */
const echoes = ({ frames }: Saved) =>
	frames.flatMap(({ bytes }) =>
		bytes.readUInt16BE(12) === 0x0800 && bytes[23] === 1
			? [`${bytes[34] === 8 ? "request" : "reply"} ${bytes.readUInt16BE(40)}`]
			: [],
	);

test("a capture narrowed to one cable saves each of its frames once, and any other saves everything", async ({
	page,
}) => {
	await routed(page);
	await full(page).or(dock(page)).first().getByRole("button", { name: "Clear" }).click();
	expect(await pinged(page, 5)).toBe(true);
	// Nothing more comes in, so each way of saving it saves the same frames.
	await full(page).or(dock(page)).first().getByRole("button", { name: "Pause" }).click();
	const each = [0, 1, 2, 3, 4].flatMap((seq) => [`request ${seq}`, `reply ${seq}`]);

	for (const cable of ["mid:1", "mid:2", "switch0:1", "far:2"]) {
		await typed(page, `capture ${cable}`);
		const file = await saved(page);
		expect(file.name, cable).toBe(`unlab-${cable.replace(":", "-port")}.pcap`);
		expect(echoes(file), cable).toEqual(each);
		// No frame is there twice, and they are those that the cable carried, which an agent reads by the same filter.
		expect(new Set(file.frames.map(({ bytes }) => bytes.toString("hex"))).size, cable).toBe(file.frames.length);
		expect(
			file.frames.map(({ bytes }) => bytes.length),
			cable,
		).toEqual((await read(page, cable)).slice(0, file.frames.length).map(({ len }) => len));
		const times = file.frames.map(({ at }) => at);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(Math.abs(times[0] / 1000 - Date.now())).toBeLessThan(120_000);
		// An agent is given the same file, and so is a person who types it.
		expect(await given(page, cable), cable).toEqual({ name: file.name, bytes: file.bytes });
		await page.keyboard.press("Escape");
		if (cable === "mid:1") expect((await saved(page, `pcap ${cable}`)).bytes.equals(file.bytes)).toBe(true);
	}

	// Narrowed further, or to more than a cable, the file has what is shown.
	await typed(page, "capture mid:1 icmp or far:2 icmp");
	const two = await saved(page);
	expect(two.name).toBe("unlab-filtered.pcap");
	expect(echoes(two)).toHaveLength(20);
	expect(two.frames).toHaveLength(20);
	expect(await given(page, "mid:1 icmp or far:2 icmp")).toEqual({ name: two.name, bytes: two.bytes });
	await page.keyboard.press("Escape");

	// A filter for reading, as before: the whole capture, on every switch, whatever it shows.
	await typed(page, "capture arp");
	const whole = await saved(page);
	expect(whole.name).toBe("unlab.pcap");
	expect(await given(page, "arp")).toEqual({ name: whole.name, bytes: whole.bytes });
	expect(echoes(whole)).toEqual(
		[0, 1, 2, 3, 4].flatMap((seq) => [...Array(3).fill(`request ${seq}`), ...Array(3).fill(`reply ${seq}`)]),
	);
});

test("the capture says when a cable that is down is moved or unplugged, and why it is down", async ({ page }) => {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await typed(page, "spawn 2 alpine --no-gateway");
	await status(page, "2 of 2 ready");
	await typed(page, "poweroff node2");
	await status(page, "1 of 2 ready");
	await expect(dock(page)).toContainText("port 2 link down. node2 stopped.");

	// In a lab of one switch, the ports are named as they are anywhere in it.
	await typed(page, "link down node1");
	await typed(page, "plug node1 switch0:5");
	await expect(dock(page)).toContainText("port 1 link down. Cut cable to node1 unplugged by you.");
	await expect(dock(page)).toContainText("port 5 link down. Cut cable to node1 plugged in by you.");
	await typed(page, "mkswitch lan");
	expect(await call(page, "cable_plug", { nic: "node2", to: "lan" })).toMatchObject({ data: { link: "off" } });
	await expect(dock(page)).toContainText(
		"switch0 port 2 link down. Cable to node2, which is off, unplugged by the agent.",
	);
	await expect(dock(page)).toContainText(
		"lan port 1 link down. Cable to node2, which is off, plugged in by the agent.",
	);
	expect(await call(page, "cable_unplug", { nic: "node1" })).toMatchObject({ data: { link: "unplugged" } });
	await expect(dock(page)).toContainText("switch0 port 5 link down. Cut cable to node1 unplugged by the agent.");
	await typed(page, "rmswitch lan");
	await page.keyboard.press("Enter");
	await expect(dock(page)).toContainText("lan port 1 link down. Cable to node2, which is off, unplugged by you.");

	// A filter keeps the rows of its cable.
	await typed(page, "capture switch0:5 arp");
	await expect(full(page).locator(".row.event")).toHaveCount(2);
});
