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
	await page.keyboard.type("echo sh-$((6*7))");
	await page.keyboard.press("Enter");
	await expect(shell).toContainText("sh-42");
	await expect(console1).not.toContainText("sh-42");
	expect(errors).toEqual([]);
});

test("a console whose program read Enter takes commands again, and a line typed ahead still holds it", async ({
	page,
}) => {
	await openWithTwoMachines(page);
	const node1 = page.locator('unlab-pane[machine="node1"]');
	const console1 = node1.locator("#panel-node1-console");
	const exec = async (command: string) => {
		await page.keyboard.press("Control+/");
		await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
		await page.keyboard.type(`exec node1 -- ${command}`);
		await page.keyboard.press("Enter");
	};

	await console1.click();
	for (const line of ["cat", "read by cat", ""]) {
		await page.keyboard.type(line);
		await page.keyboard.press("Enter");
	}
	await page.keyboard.press("Control+d");
	await page.waitForTimeout(3000);
	await exec("echo back-$((40+2))");
	await expect(console1).toContainText("back-42");

	await console1.click();
	for (const line of ["sleep 1", "sleep 6; echo ahead-$((6*7))"]) {
		await page.keyboard.type(line);
		await page.keyboard.press("Enter");
	}
	await page.waitForTimeout(4000);
	await exec("echo early-$((1+1))");
	await expect(console1).toContainText("ahead-42");
	await expect(console1).not.toContainText("early-2");
});
