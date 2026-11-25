import { expect, type Page } from "@playwright/test";
import { call } from "./webmcp.ts";

/** A fresh lab starts empty; most tests want two ready machines, typed into the bar as a person would. */
export async function openWithTwoMachines(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await page.keyboard.press("Control+/");
	await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
	await page.keyboard.type("spawn 2 alpine");
	await page.keyboard.press("Enter");
	await expect(page.getByText("2 of 2 ready")).toBeVisible({ timeout: 60_000 });
}

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
		data: { ran: Ran[] };
	};
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
