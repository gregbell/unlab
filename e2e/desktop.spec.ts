import { expect, test } from "@playwright/test";

test("first boot opens real terminals, live switch ports and a restorable desktop", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	const welcome = page.getByRole("region", { name: "Welcome to unLAB" });
	await expect(welcome.getByText("node2", { exact: true })).toBeVisible();
	await expect(welcome.getByText("10.88.0.12/24")).toBeVisible();
	await expect(welcome.getByText("port 2", { exact: true })).toBeVisible();
	await welcome.getByRole("button", { name: "Boot 2 machines" }).click();
	await expect(welcome).toHaveCount(0);
	const rack = page.getByRole("region", { name: "Rack manager" });
	const ports = rack.locator('[data-switch="switch0"] .dt-port-block');
	await expect(ports).toHaveCount(8);
	await expect(ports.nth(1)).toHaveAttribute("data-state", "up", { timeout: 60000 });
	await rack.getByRole("button", { name: "Inspect switch0" }).click();
	const network = page.getByRole("region", { name: "switch0 · Switch details" });
	const port = network.getByRole("row").filter({ has: page.getByRole("button", { name: "node2", exact: true }) });
	await port.getByRole("button", { name: "Cut cable" }).click();
	await expect(ports.nth(1)).toHaveAttribute("data-state", "cut");
	await port.getByRole("button", { name: "Reconnect" }).click();
	await network.getByRole("button", { name: "Minimize switch0 · Switch details" }).click();
	const restore = page.getByRole("button", { name: "Restore switch0 · Switch details from dock" });
	await expect(restore).toBeVisible();
	await rack.getByRole("button", { name: "Configure node1" }).click();
	await page.getByRole("button", { name: "Ping node2" }).click();
	const term = page.getByRole("region", { name: "node1 · terminal", exact: true });
	await expect(term.locator(".wterm")).toContainText("bytes from 10.88.0.12", { timeout: 60000 });
	await page.reload();
	await expect(welcome).toHaveCount(0);
	await restore.click();
	await expect(network).toBeVisible();
	await expect(ports.nth(0)).toHaveAttribute("data-state", "up", { timeout: 60000 });
	expect(errors).toEqual([]);
});

test("Welcome passes its count and image to the wizard on a narrow screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	const welcome = page.getByRole("region", { name: "Welcome to unLAB" });
	await welcome.getByRole("button", { name: "One fewer" }).click();
	await welcome.getByRole("button", { name: /debian/i }).click();
	await welcome.getByRole("button", { name: "Customize machines" }).click();
	const wizard = page.getByRole("region", { name: "Add machines" });
	await expect(wizard.getByRole("radio", { name: /debian/i })).toBeChecked();
	await expect(wizard.getByRole("combobox", { name: "Machines", exact: true })).toHaveValue("1");
	await wizard.getByRole("button", { name: /Review$/, exact: false }).click();
	await expect(wizard.getByRole("button", { name: "Boot 1 machine" })).toBeEnabled();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a fresh widescreen lab opens with four separate windows and remembers a move", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Boot 2 machines" }).click();
	const windows = page.locator(".dt-work > section:visible");
	await expect(windows).toHaveCount(4);
	const boxes = await windows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
	for (const [index, a] of boxes.entries()) {
		expect(a.width).toBeGreaterThan(360);
		for (const b of boxes.slice(index + 1))
			expect(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom).toBe(true);
	}
	const rack = page.getByRole("region", { name: "Rack manager" });
	const title = rack.locator(".dt-title b");
	const from = await title.boundingBox();
	if (!from) throw new Error("Missing rack title");
	await page.mouse.move(from.x + 4, from.y + 4);
	await page.mouse.down();
	await page.mouse.move(from.x + 64, from.y + 44, { steps: 4 });
	await page.mouse.up();
	const moved = await rack.boundingBox();
	expect(moved?.x).toBeGreaterThan(boxes[0].x + 30);
	await page.reload();
	await expect(rack).toBeVisible();
	expect(await rack.boundingBox()).toEqual(moved);
});

test("on a phone, the first two machines share the screen with the rack through the dock", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await page.getByRole("button", { name: "Boot 2 machines" }).click();
	await expect(page.getByRole("region", { name: "Rack manager" })).toBeVisible();
	await expect(page.getByRole("region", { name: "node1 · terminal", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Restore node2 · terminal from dock" }).click();
	await expect(page.getByRole("region", { name: "node2 · terminal", exact: true })).toBeVisible();
});
