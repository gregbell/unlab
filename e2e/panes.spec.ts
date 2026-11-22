import { expect, test } from "@playwright/test";
import { openWithTwoMachines } from "./lab.ts";

test("a console runs what is typed into it, keeps it through park and maximise, and + opens a shell tab", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);

	const node1 = page.locator('unlab-pane[machine="node1"]');
	const console1 = node1.locator("#panel-node1-console");
	await console1.click();
	await page.keyboard.type("echo unlab-$((40+2))");
	await page.keyboard.press("Enter");
	await expect(console1).toContainText("unlab-42");

	await node1.getByRole("button", { name: "Park node1" }).click();
	await expect(node1).toBeHidden();
	const chip = page.locator("unlab-parked-strip").getByRole("button", { name: "node1" });
	await chip.click();
	await expect(node1).toBeVisible();
	await expect(console1).toContainText("unlab-42");

	const node2 = page.locator('unlab-pane[machine="node2"]');
	await node1.getByRole("button", { name: "Maximise node1" }).click();
	await expect(node2).toBeHidden();
	await node1.getByRole("button", { name: "Maximise node1" }).click();
	await expect(node2).toBeVisible();
	await expect(console1).toContainText("unlab-42");

	await node1.getByRole("button", { name: "New shell on node1" }).click();
	const shellTab = node1.getByRole("tab", { name: "sh1" });
	await expect(shellTab).toHaveAttribute("aria-selected", "true");
	await expect(console1).toBeHidden();
	const shell = node1.getByRole("tabpanel", { name: "sh1" });
	await expect(shell).toBeVisible();
	await expect(shell).toHaveAttribute("aria-busy", "false");
	// A new shell drops keys for a moment after its prompt shows (a runtime gap, not the pane), so type until one line lands.
	await expect(async () => {
		await page.keyboard.type("echo sh-$((6*7))");
		await page.keyboard.press("Enter");
		await expect(shell).toContainText("sh-42", { timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await expect(console1).not.toContainText("sh-42");
	expect(errors).toEqual([]);
});
