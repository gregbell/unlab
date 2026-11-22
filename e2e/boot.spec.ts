import { expect, test } from "@playwright/test";

test("a fresh lab boots a real machine that runs what you type", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	await expect(page.getByText("Welcome to Alpine Linux").first()).toBeVisible({ timeout: 60_000 });
	await page.keyboard.type("echo unlab-$((40+2))\n");
	await expect(page.getByText("unlab-42", { exact: true }).first()).toBeVisible();
	expect(errors).toEqual([]);
});
