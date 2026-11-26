import { expect, test } from "@playwright/test";

test("a machine spawned after the page has sat open for minutes still boots", async ({ page }) => {
	await page.clock.install();
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	await page.clock.fastForward("02:30");
	await page.clock.resume();

	await page.keyboard.press("Control+/");
	await page.keyboard.type("spawn 1 alpine");
	await page.keyboard.press("Enter");
	await expect(page.getByRole("region", { name: "node1 · terminal", exact: true }).locator(".wterm")).toContainText(
		"Welcome to Alpine Linux",
		{ timeout: 60_000 },
	);
	await expect(page.getByText("did not boot")).toHaveCount(0);
});
