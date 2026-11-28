import { expect, type Locator, type Page, test } from "@playwright/test";

async function enter(page: Page, terminal: Locator, line: string) {
	await terminal.click();
	await expect(terminal.getByRole("textbox")).toBeFocused();
	await page.keyboard.type(line);
	await page.keyboard.press("Enter");
}

test("Getting started: boot, keep a file, install curl, and ping the second machine", async ({ page }) => {
	await page.goto("/");
	const welcome = page.getByRole("region", { name: "Welcome to unLAB" });
	await welcome.getByRole("button", { name: "Boot 2 machines" }).click();

	const rack = page.getByRole("region", { name: "Rack manager" });
	const openTerminal = rack.getByRole("button", { name: "Open terminal for node1" });
	const terminal = page.getByRole("region", { name: "node1 · terminal", exact: true });
	const rows = terminal.locator(".term-row");
	const prompt = () =>
		expect.poll(async () => (await rows.allTextContents()).join("\n").trimEnd(), { timeout: 60_000 }).toMatch(/~ ⇒$/);

	await expect(rack.getByText("2 links up")).toBeVisible({ timeout: 60_000 });
	await openTerminal.click();
	await prompt();
	await enter(page, terminal, "hostname");
	await expect(rows.filter({ hasText: /^\s*node1\s*$/ }).last()).toBeVisible();

	await enter(page, terminal, "hostname > ~/my-machine");
	await expect(rows.filter({ hasText: /hostname > ~\/my-machine/ }).last()).toBeVisible();
	await prompt();
	await page.reload();
	await expect(rack.getByText("2 links up")).toBeVisible({ timeout: 60_000 });
	await openTerminal.click();
	await prompt();
	await enter(page, terminal, "cat ~/my-machine");
	await expect(rows.filter({ hasText: /^\s*node1\s*$/ }).last()).toBeVisible();

	await enter(page, terminal, "sudo apk add curl");
	await expect(terminal.locator(".wterm")).toContainText(/OK:/, { timeout: 60_000 });
	await enter(page, terminal, "curl --version");
	await expect(terminal.locator(".wterm")).toContainText(/curl \d+\.\d+\.\d+/);

	await rack.getByRole("button", { name: "Configure node2" }).click();
	const config = page.getByRole("region", { name: "node2 · Configuration" });
	await expect(config.getByText("10.88.0.12/24", { exact: true })).toBeVisible();
	await openTerminal.click();
	await enter(page, terminal, "ping -c 1 10.88.0.12");
	await expect(terminal.locator(".wterm")).toContainText("1 packets received, 0% packet loss");
});
