import { expect, type Page } from "@playwright/test";

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
