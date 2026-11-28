import { expect, test } from "@playwright/test";
import { openWithTwoMachines, rack, rackRow, screen } from "./lab.ts";

test("the bar cuts a real cable, then removes a machine after asking", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);

	const node2 = rackRow(page, "node2");
	const port2 = rack(page).locator('[data-switch="switch0"] .dt-port-block').nth(1);
	const command = page.getByRole("combobox", { name: "Command" });

	const console1 = screen(page, "node1");
	await console1.click();
	await page.keyboard.press("Control+/");
	await expect(command).toBeFocused();
	await page.keyboard.type("link down node2");
	await expect(page.getByRole("status").filter({ hasText: "will" })).toContainText("cut the cable to node2");
	await page.keyboard.press("Enter");
	await expect(port2).toHaveAttribute("data-state", "cut");
	await expect(command).not.toBeFocused();
	await expect(console1).not.toContainText("link down node2");

	await page.keyboard.press("Control+/");
	await expect(command).toBeFocused();
	await page.keyboard.type("rm node2");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-confirm")).toContainText("Remove node2?");
	await expect(page.getByRole("button", { name: "Remove node2" })).toBeVisible();
	await expect(node2).toHaveCount(1);
	await page.keyboard.press("Enter");
	await expect(node2).toHaveCount(0, { timeout: 30_000 });
	await expect(page.locator("unlab-command-bar")).not.toHaveAttribute("open");
	expect(errors).toEqual([]);
});
