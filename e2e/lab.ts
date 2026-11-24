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
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible({ timeout: 60_000 });
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

/** A line an agent runs in the machine's console. */
export async function shell(page: Page, node: number, script: string): Promise<Ran> {
	const reply = (await call(page, "shell_exec", { targets: `node${node}`, command: script })) as {
		data: { ran: Ran[] };
	};
	return reply.data.ran[0];
}

/** One that must succeed, as root. */
export async function root(page: Page, node: number, script: string): Promise<string> {
	const ran = await shell(page, node, `sudo sh -c '${script}'`);
	expect(ran, script).toMatchObject({ exitCode: 0 });
	return ran.output;
}
