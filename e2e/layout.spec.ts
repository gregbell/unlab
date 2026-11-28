import { expect, type Locator, test } from "@playwright/test";
import { openWithTwoMachines, screen, terminal } from "./lab.ts";

/** The newest output must stay in view: a terminal whose window changes size keeps following its tail. */
async function expectInside(inner: Locator, outer: Locator): Promise<void> {
	const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
	expect(a, "the line is laid out").not.toBeNull();
	expect(b, "the terminal is laid out").not.toBeNull();
	if (!a || !b) return;
	expect(a.y).toBeGreaterThanOrEqual(b.y);
	expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height);
}

test("a console keeps its newest line in view when its window is maximized and restored", async ({ page }) => {
	await openWithTwoMachines(page);
	const window = terminal(page, "node1");
	const shown = screen(page, "node1");
	await shown.click();
	await page.keyboard.type("seq 1 80; echo tail-$((40+2))\n");
	const tail = shown.getByText("tail-42", { exact: true });
	await expect(tail).toBeVisible();
	await expectInside(tail, shown);

	for (const button of ["Maximize node1 · terminal", "Restore node1 · terminal"]) {
		await window.getByRole("button", { name: button }).click();
		await page.waitForTimeout(500);
		await expectInside(tail, shown);
	}
});
