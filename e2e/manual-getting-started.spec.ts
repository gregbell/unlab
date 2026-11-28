import { expect, type Locator, type Page, test } from "@playwright/test";

async function enter(page: Page, terminal: Locator, line: string) {
	await terminal.click();
	await expect(terminal.getByRole("textbox")).toBeFocused();
	await page.keyboard.type(line);
	await page.keyboard.press("Enter");
}

test("Getting started: boot, keep a file, install curl, and test a cable with ping", async ({ page }) => {
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
	await rack.getByRole("button", { name: "Configure node2" }).click();
	const peer = page.getByRole("region", { name: "node2 · Configuration" });
	await expect(peer.getByText("10.88.0.12/24", { exact: true })).toBeVisible();
	await rack.getByRole("button", { name: "Configure node1" }).click();
	const config = page.getByRole("region", { name: "node1 · Configuration" });
	await config.getByRole("button", { name: "Ping node2" }).click();
	await expect(terminal.locator(".wterm")).toContainText("3 packets received, 0% packet loss");

	const inspectSwitch = rack.getByRole("button", { name: "Inspect switch0" });
	await inspectSwitch.click();
	const details = page.getByRole("region", { name: "switch0 · Switch details" });
	const port = details.getByRole("row").filter({ has: page.getByRole("button", { name: "node2", exact: true }) });
	await expect(port.getByRole("cell", { name: "up", exact: true })).toBeVisible();
	await port.getByRole("button", { name: "Cut cable" }).click();
	await expect(port.getByRole("cell", { name: "cut", exact: true })).toBeVisible();
	const ping = "ping -c 1 -W 2 10.88.0.12";
	await openTerminal.click();
	await enter(page, terminal, ping);
	await expect(terminal.locator(".wterm")).toContainText("0 packets received, 100% packet loss");
	await inspectSwitch.click();
	await port.getByRole("button", { name: "Reconnect" }).click();
	await expect(port.getByRole("cell", { name: "up", exact: true })).toBeVisible();
	await openTerminal.click();
	await enter(page, terminal, ping);
	await expect(terminal.locator(".wterm")).toContainText("1 packets received, 0% packet loss");
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
});
