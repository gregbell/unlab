import { expect, type Locator, type Page } from "@playwright/test";
import { call } from "./webmcp.ts";

/** A fresh lab: empty, with Welcome open. */
export async function openLab(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

/** A fresh lab starts empty; most tests want two ready machines, typed into the bar as a person would. */
export async function openWithTwoMachines(page: Page): Promise<void> {
	await openLab(page);
	await page.keyboard.press("Control+/");
	await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
	await page.keyboard.type("spawn 2 alpine");
	await page.keyboard.press("Enter");
	await ready(page, 2, 2);
}

/** The desktop's panel says how many of the machines are ready. */
export async function ready(page: Page, count: number, of: number, timeout = 60_000): Promise<void> {
	await expect(page.getByTitle(`${count} of ${of} machines ready`, { exact: true })).toBeVisible({ timeout });
}

/**
 * `1 of 3 ready, 2 failed`, read from the desktop: its count of the machines
 * that are ready, and as many rows of the Rack manager in each other state.
 */
export async function status(page: Page, said: string, timeout = 60_000): Promise<void> {
	const counted = /^(\d+) of (\d+) ready(?:, (.+))?$/.exec(said);
	if (!counted) throw new Error(`${said} is no count of the machines`);
	const [, count, of, others = ""] = counted;
	await ready(page, Number(count), Number(of), timeout);
	for (const other of others.split(", ").filter(Boolean)) {
		const [, n, state] = /^(\d+) (\w+)$/.exec(other) ?? [];
		const rows = rack(page)
			.locator("[data-machine] small")
			.filter({ hasText: new RegExp(` · ${state}$`) });
		await expect(rows, said).toHaveCount(Number(n), { timeout });
	}
}

export const rack = (page: Page): Locator => page.getByRole("region", { name: "Rack manager" });

/** A machine's row in the Rack manager. Its summary ends in its state while it is not ready. */
export const rackRow = (page: Page, name: string): Locator => rack(page).locator(`[data-machine="${name}"]`);

/** A machine's terminal window, on its console or on one of its shells: `sh1` is `node1 · terminal 1`. */
export const terminal = (page: Page, name: string, shell?: string): Locator =>
	page.getByRole("region", {
		name: shell ? `${name} · terminal ${shell.replace(/^sh/, "")}` : `${name} · terminal`,
		exact: true,
	});

/** What a terminal window shows. */
export const screen = (page: Page, name: string, shell?: string): Locator =>
	terminal(page, name, shell).locator(".wterm");

/** One of the logo menu's items, and one of its submenu's when there is one. */
export async function fromMenu(page: Page, item: string, sub?: string): Promise<void> {
	await page.getByRole("button", { name: "Lab menu" }).click();
	await page.getByRole("menuitem", { name: item, exact: true }).click();
	if (sub) await page.getByRole("menuitem", { name: sub, exact: true }).click();
}

/** A window that a button in the Rack manager opens, or brings to the front when it is open already. */
async function fromRack(page: Page, window: Locator, button: string): Promise<Locator> {
	await fromMenu(page, "Rack manager");
	await rack(page).getByRole("button", { name: button }).click();
	await expect(window).toBeVisible();
	return window;
}

/** A machine's Configuration window, opened from its row in the Rack manager. */
export const configuration = (page: Page, name: string): Promise<Locator> =>
	fromRack(page, page.getByRole("region", { name: `${name} · Configuration`, exact: true }), `Configure ${name}`);

/** A switch's details window, opened from its row in the Rack manager. */
export const switchDetails = (page: Page, name: string): Promise<Locator> =>
	fromRack(page, page.getByRole("region", { name: `${name} · Switch details`, exact: true }), `Inspect ${name}`);

/** A machine's console window, brought to the front from its row in the Rack manager. */
export const consoleOf = (page: Page, name: string): Promise<Locator> =>
	fromRack(page, terminal(page, name), `Open terminal for ${name}`);

/** One switch's capture, in the window that the logo menu opens for it. */
export async function switchCapture(page: Page, on: string): Promise<Locator> {
	const capture = page.locator(`unlab-capture[on-switch="${on}"]`);
	if (!(await capture.isVisible())) await fromMenu(page, "Packet capture", on);
	await expect(capture).toBeVisible();
	return capture;
}

/** The capture of every switch, in the Packet inspector that the logo menu opens. */
export async function inspector(page: Page): Promise<Locator> {
	const window = page.getByRole("region", { name: "Packet inspector", exact: true });
	if (!(await window.isVisible())) await fromMenu(page, "Packet capture", "Packet inspector");
	await expect(window).toBeVisible();
	return window.locator("unlab-capture");
}

/** Whose addresses a switch has learned, in its MAC table's order: `node1`, or `r1:eth0` for a machine of several NICs. */
export async function learned(page: Page, on: string): Promise<string[]> {
	const reply = (await call(page, "switch_macs", { switches: on })) as {
		data: { macs: { machine?: string; nic?: string }[] }[];
	};
	const listed = (await call(page, "machines_list", {})) as { data: { name: string; nics: unknown[] }[] };
	const several = new Set(listed.data.flatMap(({ name, nics }) => (nics.length > 1 ? [name] : [])));
	return reply.data.flatMap(({ macs }) =>
		macs.flatMap(({ machine, nic }) => (machine ? [several.has(machine) && nic ? `${machine}:${nic}` : machine] : [])),
	);
}

/** The frames a switch took in, the copies it delivered and those it flooded, since it was added. */
export async function counters(page: Page, on: string): Promise<{ in: number; delivered: number; flooded: number }> {
	const reply = (await call(page, "switch_macs", { switches: on })) as {
		data: { counters: { in: number; delivered: number; flooded: number } }[];
	};
	return reply.data[0].counters;
}

/** What SSH access, opened from the logo menu, says of the link with the CLI. */
export async function linkSaid(page: Page): Promise<Locator> {
	const access = page.getByRole("region", { name: "SSH access", exact: true });
	if (!(await access.isVisible())) await fromMenu(page, "SSH access");
	return access.locator(".dt-guide-status b");
}

/** The agent panel, in the WebMCP window that the logo menu opens or brings to the front. */
export async function agentPanel(page: Page): Promise<Locator> {
	const panel = page.locator("unlab-agent-panel");
	await fromMenu(page, "WebMCP");
	await expect(panel).toBeVisible();
	return panel;
}

/** The switches in the Rack manager, in its order. */
export const switchesListed = (page: Page): Locator => rack(page).locator("[data-switch] .dt-device-name b");

/** A port's row in a switch's details window. */
export const portRow = (details: Locator, port: number): Locator =>
	details.getByRole("row").filter({ has: details.page().getByRole("rowheader", { name: String(port), exact: true }) });

/** A line run from the command bar, as a person would. */
export async function typed(page: Page, line: string): Promise<void> {
	await page.keyboard.press("Control+/");
	await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
	await page.keyboard.type(line);
	await page.keyboard.press("Enter");
}

interface Ran {
	readonly exitCode: number | null;
	readonly output: string;
}

/** A line an agent runs in the machine's console. A number is the machine that goes by it. */
export async function shell(page: Page, machine: number | string, script: string): Promise<Ran> {
	const targets = typeof machine === "number" ? `node${machine}` : machine;
	const reply = (await call(page, "shell_exec", { targets, command: script })) as {
		data?: { ran: Ran[] };
		error?: string;
	};
	if (!reply.data) throw new Error(`${targets}: ${script}: ${reply.error}`);
	return reply.data.ran[0];
}

/** One that must succeed, as root. */
export async function root(page: Page, machine: number | string, script: string): Promise<string> {
	const ran = await shell(page, machine, `sudo sh -c '${script}'`);
	expect(ran, script).toMatchObject({ exitCode: 0 });
	return ran.output;
}

/** Crashes an Alpine machine: init runs a program that ends, and a kernel with no init panics. */
export async function crash(page: Page, machine: number | string): Promise<void> {
	const script = "echo ::restart:/bin/false >> /etc/inittab; kill -HUP 1; sleep 1; kill -QUIT 1; sleep 9";
	await shell(page, machine, `sudo sh -c '${script}'`);
}
