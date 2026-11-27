import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { shell, typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const status = (page: Page, text: string, timeout = 60_000) => expect(page.getByText(text)).toBeVisible({ timeout });
const bar = (page: Page) => page.locator("unlab-command-bar");
const workers = (page: Page) => page.workers().filter((worker) => worker.url().includes("vm-worker")).length;
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

interface Listed {
	readonly name: string;
	readonly state: string;
	readonly address: string;
	readonly memoryMiB: number;
	readonly reason?: string;
	readonly nics: readonly { readonly switch?: string }[];
}

const list = async (page: Page) => (await call(page, "machines_list", {})) as { result: string; data: Listed[] };

interface Row {
	readonly kind: string;
	readonly from?: { readonly name?: string };
}

/** What a line in the bar is refused with. */
async function refused(page: Page, line: string): Promise<string> {
	await typed(page, line);
	const error = bar(page).getByRole("alert");
	await expect(error).toBeVisible();
	const said = (await error.locator("p").allTextContents()).join(" ");
	await page.keyboard.press("Escape");
	return said;
}

const meminfo = (field: string): number =>
	Math.round(
		Number(new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) / 1024,
	);

/** The memory that the browser's processes hold, in MiB, where Linux says: each page once, and each page they map. */
async function held(browser: Browser): Promise<{ readonly pss: number; readonly rss: number } | null> {
	if (!existsSync("/proc/self/smaps_rollup")) return null;
	const session = await browser.newBrowserCDPSession();
	const { processInfo } = await session.send("SystemInfo.getProcessInfo");
	await session.detach();
	let pss = 0;
	let rss = 0;
	for (const { id } of processInfo) {
		let rollup = "";
		try {
			rollup = readFileSync(`/proc/${id}/smaps_rollup`, "utf8");
		} catch {
			// It has ended since the browser listed it.
		}
		pss += Number(/^Pss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0);
		rss += Number(/^Rss:\s+(\d+) kB/m.exec(rollup)?.[1] ?? 0);
	}
	return { pss: Math.round(pss / 1024), rss: Math.round(rss / 1024) };
}

const MACHINES = 16;
const NAMES = Array.from({ length: MACHINES }, (_, i) => `node${i + 1}`);
const LIMIT = "The lab has all 16 machines that it can, so remove one with rm first.";

test("sixteen machines on two switches boot and each pings the others in its subnet, a seventeenth is refused, the lab says the memory they were given, and each is told apart", async ({
	page,
	browser,
}, testInfo) => {
	test.setTimeout(420_000);
	await openLab(page);
	const empty = await held(browser);

	const started = Date.now();
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 8 alpine");
	for (let n = 1; n <= 8; n++) await typed(page, `spawn 1 alpine --net lan --addr 10.2.0.${10 + n}/24`);
	await expect(page.locator("unlab-machine-row")).toHaveCount(MACHINES);
	await status(page, "16 of 16 ready", 300_000);
	const readySeconds = (Date.now() - started) / 1000;
	const ready = await held(browser);

	const { result, data: machines } = await list(page);
	expect(machines.map(({ name, state, memoryMiB, nics }) => [name, state, memoryMiB, nics[0]?.switch])).toEqual(
		NAMES.map((name, i) => [name, "ready", 256, i < 8 ? "switch0" : "lan"]),
	);
	expect(result).toBe("16 machines · 16 ready · 4096 MiB of memory");
	await expect(heading(page, "machines 16 4096 MiB of memory")).toBeVisible();
	expect(workers(page)).toBe(MACHINES);

	const pinging = Date.now();
	// All at once, each call under its machine's name.
	for (const [i, machine] of machines.entries()) {
		const peers = machines.filter((other, at) => other !== machine && at < 8 === i < 8).map((peer) => peer.address);
		expect(peers).toHaveLength(7);
		const command = `for peer in ${peers.join(" ")}; do ping -c 1 -W 5 $peer >/dev/null || echo $peer; done`;
		await start(page, machine.name, "shell_exec", { targets: machine.name, command });
	}
	const unanswered: unknown[] = [];
	for (const { name } of machines) {
		const reply = (await finish(page, name)) as { data: { ran: { exitCode: number | null; output: string }[] } };
		unanswered.push([name, reply.data.ran[0]?.exitCode, reply.data.ran[0]?.output]);
	}
	expect(unanswered).toEqual(NAMES.map((name) => [name, 0, ""]));
	const pingSeconds = (Date.now() - pinging) / 1000;
	// No cable joins the two switches, so the other subnet does not answer.
	expect(await shell(page, "node1", "ping -c 1 -W 1 10.2.0.11")).toMatchObject({ exitCode: 1 });

	for (const line of ["spawn 1 alpine", "spawn 1 alpine --no-net"]) expect(await refused(page, line)).toContain(LIMIT);
	expect(await call(page, "machines_spawn", { count: 1, image: "alpine", net: "none" })).toEqual({
		error: `${LIMIT} Nothing was changed.`,
	});
	expect((await list(page)).data).toHaveLength(MACHINES);

	// The rail names every machine, and each row can be brought into view.
	const rows = page.locator("unlab-machine-row");
	await expect(rows.locator(".name")).toHaveText(NAMES);
	for (const row of await rows.all()) {
		await row.scrollIntoViewIfNeeded();
		await expect(row).toBeInViewport({ ratio: 1 });
	}
	// Every machine has a pane under its name or a chip under its name, and a chip brings its pane back.
	const panes = await page
		.locator("unlab-pane:visible")
		.evaluateAll((all) => all.map((pane) => pane.getAttribute("machine")));
	const chips = await page.locator("unlab-parked-strip .chip").allTextContents();
	expect([...panes, ...chips.map((chip) => chip.trim())].sort()).toEqual([...NAMES].sort());
	expect(panes.length).toBeGreaterThan(0);
	for (const name of panes)
		await expect(page.locator(`unlab-pane[machine=${name}] .name`).first()).toHaveText(String(name));
	const parked = chips.at(-1)?.trim() ?? "";
	await page.locator("unlab-parked-strip .chip", { hasText: new RegExp(`^\\s*${parked}\\s*$`) }).click();
	await expect(page.locator(`unlab-pane[machine=${parked}]`)).toBeVisible();

	// The capture has frames from each, under its name. Two that share a hue are told apart by it.
	const captured = (await call(page, "capture_read", { filter: "icmp", limit: 1000 })) as { rows: Row[] };
	expect([...new Set(captured.rows.flatMap((row) => row.from?.name ?? []))].sort()).toEqual([...NAMES].sort());
	const hueOf = (name: string) =>
		page.locator("unlab-machine-row .row", { hasText: name }).first().getAttribute("data-hue");
	expect(await hueOf("node9")).toBe(await hueOf("node1"));
	for (const name of ["node1", "node9"]) {
		await typed(page, `capture icmp ${name}`);
		const routes = page.locator("unlab-capture .row.frame .route");
		await expect(routes.first()).toBeVisible();
		for (const route of await routes.allTextContents()) expect(route).toMatch(new RegExp(`\\b${name}\\b`));
	}

	const record = [
		`sixteen machines of 256 MiB on two switches: ready ${readySeconds.toFixed(1)} s after the first command`,
		`each pinged the 7 others in its subnet, 112 pings in ${pingSeconds.toFixed(1)} s`,
		ready && empty
			? `the browser's processes hold ${ready.pss} MiB (PSS, ${ready.rss} RSS), and held ${empty.pss} MiB with the lab empty`
			: "the browser's memory is not read on this system",
		existsSync("/proc/meminfo")
			? `the host has ${availableParallelism()} CPUs and ${meminfo("MemTotal")} MiB of memory, ${meminfo("MemAvailable")} MiB of it available now`
			: `the host has ${availableParallelism()} CPUs`,
	].join("\n");
	process.stdout.write(`${record}\n`);
	await testInfo.attach("sixteen-machines.txt", { body: record, contentType: "text/plain" });
	mkdirSync(testInfo.project.outputDir, { recursive: true });
	writeFileSync(join(testInfo.project.outputDir, "sixteen-machines.txt"), `${record}\n`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Sixteen machines\n\n${record.replaceAll("\n", "  \n")}\n`);
});

/**
 * Put before a machine's worker: the browser has no memory for a machine of 320 MiB, and says so as it does
 * when its address space or the system's memory is used up.
 */
const NO_MEMORY_FOR_320_MIB = `WebAssembly.Memory = new Proxy(WebAssembly.Memory, {
	construct(Memory, [descriptor]) {
		if (descriptor.initial === 320 * 16) throw new RangeError("WebAssembly.Memory(): could not allocate memory");
		return new Memory(descriptor);
	},
});`;

test("a machine that the browser has no memory for fails and says so, the others keep running, and it boots once there is memory", async ({
	page,
}) => {
	const refuse = async (route: Route) => {
		const response = await route.fetch();
		await route.fulfill({ response, body: `${NO_MEMORY_FOR_320_MIB}\n${await response.text()}` });
	};
	await page.route("**/assets/vm-worker-*.js", refuse);
	let started = 0;
	page.on("worker", (worker) => {
		if (worker.url().includes("vm-worker")) started++;
	});
	await openLab(page);
	await typed(page, "spawn 2 alpine");
	await typed(page, "spawn 1 alpine --mem 320");
	await status(page, "2 of 3 ready, 1 failed");

	const said =
		"The browser could not give node3 320 MiB of memory, so remove a machine or close other tabs, then boot it again.";
	expect((await list(page)).data).toMatchObject([
		{ name: "node1", state: "ready" },
		{ name: "node2", state: "ready" },
		{ name: "node3", state: "failed", reason: said },
	]);
	await expect(page.locator("unlab-pane[machine=node3]")).toContainText(said);
	// It was given none, and its worker has gone.
	await expect(heading(page, "machines 3 512 MiB of memory")).toBeVisible();
	await expect.poll(() => workers(page)).toBe(2);
	expect(await shell(page, "node1", "ping -c 1 -W 2 node2")).toMatchObject({ exitCode: 0 });

	await typed(page, "boot node3");
	await expect.poll(() => started).toBe(4);
	await status(page, "2 of 3 ready, 1 failed");
	await expect.poll(() => workers(page)).toBe(2);
	expect(await shell(page, "node2", "ping -c 1 -W 2 node1")).toMatchObject({ exitCode: 0 });

	await page.unroute("**/assets/vm-worker-*.js", refuse);
	await typed(page, "boot node3");
	await status(page, "3 of 3 ready");
	await expect(heading(page, "machines 3 832 MiB of memory")).toBeVisible();
	expect(await shell(page, "node3", "ping -c 1 -W 2 node1")).toMatchObject({ exitCode: 0 });
});

test("the desktop's status bar says the memory given to the machines that run", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Welcome to unLAB" })).toBeVisible();
	const lab = page.getByLabel("Lab status");
	const memory = lab.getByTitle("Memory given to the machines that are running");
	await expect(memory).toHaveText("0 MiB");
	await typed(page, "spawn 1 alpine --no-net --mem 384");
	await typed(page, "spawn 1 alpine --no-net");
	await expect(memory).toHaveText("640 MiB");
	await expect(lab.getByTitle("2 of 2 machines ready")).toBeVisible({ timeout: 60_000 });
	await typed(page, "poweroff node2");
	await expect(memory).toHaveText("384 MiB", { timeout: 30_000 });
});
