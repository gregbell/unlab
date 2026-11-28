import { expect, test } from "@playwright/test";
import { fromMenu, openWithTwoMachines, rackRow, screen, terminal } from "./lab.ts";

test("a console runs what is typed into it, keeps it through minimize and maximize, and New terminal opens a shell", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);

	const node1 = terminal(page, "node1");
	const console1 = screen(page, "node1");
	await console1.click();
	await page.keyboard.type("echo unlab-$((40+2))");
	await page.keyboard.press("Enter");
	await expect(console1).toContainText("unlab-42");

	await node1.getByRole("button", { name: "Minimize node1 · terminal" }).click();
	await expect(node1).toBeHidden();
	await page.getByRole("button", { name: "Restore node1 · terminal from dock" }).click();
	await expect(node1).toBeVisible();
	await expect(console1).toContainText("unlab-42");

	const node2 = terminal(page, "node2");
	await node1.getByRole("button", { name: "Maximize node1 · terminal" }).click();
	await expect(node1).toHaveAttribute("data-max", "true");
	await expect(node2).toHaveAttribute("data-max", "false");
	await node1.getByRole("button", { name: "Restore node1 · terminal" }).click();
	await expect(node1).toHaveAttribute("data-max", "false");
	await expect(console1).toContainText("unlab-42");

	await fromMenu(page, "Rack manager");
	await rackRow(page, "node1").locator(".dt-device").click({ button: "right" });
	await page.getByRole("menuitem", { name: "New terminal" }).click();
	const sh1 = terminal(page, "node1", "sh1");
	await expect(sh1).toHaveAttribute("data-active", "true");
	const shell = screen(page, "node1", "sh1");
	await expect(shell.getByRole("textbox")).toBeFocused({ timeout: 60_000 });
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
	const console1 = screen(page, "node1");
	const exec = async (command: string) => {
		await page.keyboard.press("Control+/");
		await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
		await page.keyboard.type(`exec node1 -- ${command}`);
		await page.keyboard.press("Enter");
	};

	await console1.click();
	await page.keyboard.type("cat\n");
	// busybox's shell reads what is typed at its prompt sixteen bytes at a time, and would take cat's lines with it.
	await expect(console1).toContainText("⇒ cat");
	await page.waitForTimeout(500);
	await page.keyboard.type("read by cat\n");
	await expect(console1).toContainText(/read by cat\s+read by cat/);
	await page.keyboard.press("Enter");
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
