import { expect, test } from "@playwright/test";

test("a new lab boots two real machines to ready and plugs them into switch0", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");

	const rail = page.getByRole("complementary", { name: "Machines" });
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible({ timeout: 60_000 });
	for (const name of ["node1", "node2"]) {
		await expect(rail.getByRole("button", { name: new RegExp(`^${name}\\b`) })).toContainText("up");
	}
	await expect(page.getByText("switch0: 2 of 2 links up")).toBeVisible();
	expect(errors).toEqual([]);
});
