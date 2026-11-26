import { expect, type Page, test } from "@playwright/test";

/** When set, the test also saves the empty lab and the form there, for comparing with the artboards. */
const shots = process.env.UI_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
	if (!shots) return;
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: `${shots}/${name}.png` });
}

for (const image of ["alpine", "debian"]) {
	test(`a first visit boots two ${image} machines, pings the peer and restores the lab on reload`, async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto("/");

		const form = page.locator("unlab-spawn-form");
		await expect(form.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
		await expect(form.getByRole("button", { name: /alpine/i })).toHaveAttribute("aria-pressed", "true");
		await expect(form.getByText("node1", { exact: true })).toBeVisible();
		await expect(form.getByText("node2", { exact: true })).toBeVisible();
		if (image === "debian") await form.getByRole("button", { name: /debian/i }).click();
		else await shoot(page, "first-run-empty");
		await form.getByRole("button", { name: "Boot 2 machines" }).click();

		await expect(form).toHaveCount(0);
		const rack = page.getByRole("region", { name: "Rack manager" });
		await expect(rack.getByText("2 links up")).toBeVisible({ timeout: 60000 });
		await rack.getByRole("button", { name: "Configure node1" }).click();
		await page.getByRole("button", { name: "Ping node2", exact: true }).click();
		const terminal = page.getByRole("region", { name: "node1 · terminal", exact: true });
		await expect(terminal.locator(".wterm")).toContainText(/(?:^|[ ,])0% packet loss/);
		await rack.getByRole("button", { name: "Open capture" }).click();
		await expect(
			page.locator("unlab-capture[on-switch=switch0]").getByRole("listitem").filter({ hasText: "echo reply" }).first(),
		).toBeVisible();
		await page.reload();
		await expect(form).toHaveCount(0);
		await expect(rack.getByText("2 links up")).toBeVisible({ timeout: 60000 });
		expect(errors).toEqual([]);
	});
}
