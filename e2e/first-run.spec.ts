import { expect, type Page, test } from "@playwright/test";

/** When set, the test also saves the empty lab and the form there, for comparing with the artboards. */
const shots = process.env.UI_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
	if (!shots) return;
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: `${shots}/${name}.png` });
}

test("a new lab starts empty; Add machines boots two real alpine machines to up on switch0", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");

	const start = page.locator("unlab-start");
	await expect(page.getByRole("heading", { name: "Boot some Linux." })).toBeVisible();
	await expect(page.getByText("0 machines")).toBeVisible();
	await expect(page.locator("unlab-pane-area")).toBeHidden();
	await shoot(page, "first-run-empty");

	await page.getByRole("button", { name: "Add machine", exact: true }).click();
	const form = page.locator("unlab-spawn-form");
	await expect(form.getByRole("heading", { name: "Add machines" })).toBeVisible();
	await shoot(page, "first-run-form");
	await form.getByRole("button", { name: "One fewer" }).click();
	await form.getByRole("button", { name: /^alpine/ }).click();
	await expect(form.locator(".code.line")).toHaveText(": spawn 2 alpine");
	await form.getByRole("button", { name: "Boot 2 machines" }).click();

	await expect(form).toHaveCount(0);
	await expect(start).toBeHidden();
	const rail = page.getByRole("complementary", { name: "Machines" });
	for (const name of ["node1", "node2"]) {
		await expect(rail.getByRole("button", { name: new RegExp(`^${name}\\b`) })).toContainText("up", {
			timeout: 60_000,
		});
	}
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible();
	await expect(page.getByText("switch0: 2 of 2 links up")).toBeVisible();
	expect(errors).toEqual([]);
});
