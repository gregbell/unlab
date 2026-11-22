import { expect, test } from "@playwright/test";
import { openWithTwoMachines } from "./lab.ts";

test("the bar cuts a real cable, then removes a machine after asking", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);

	const rail = page.getByRole("complementary", { name: "Machines" });
	const node2 = rail.getByRole("button", { name: /^node2\b/ });
	const command = page.getByRole("combobox", { name: "Command" });

	const console1 = page.locator("#panel-node1-console");
	await console1.click();
	await page.keyboard.press("Control+/");
	await expect(command).toBeFocused();
	await page.keyboard.type("link down node2");
	await expect(page.getByRole("status").filter({ hasText: "will" })).toContainText("cut the cable to node2");
	await page.keyboard.press("Enter");
	await expect(node2).toContainText("cut");
	await expect(command).not.toBeFocused();
	await expect(console1).not.toContainText("link down node2");

	await page.keyboard.press("Control+/");
	await expect(command).toBeFocused();
	await page.keyboard.type("rm node2");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-confirm")).toContainText("Remove node2?");
	await expect(page.getByRole("button", { name: "Remove node2" })).toBeVisible();
	await expect(node2).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(node2).toHaveCount(0, { timeout: 30_000 });
	await expect(page.locator("unlab-command-bar")).not.toHaveAttribute("open");
	expect(errors).toEqual([]);
});
