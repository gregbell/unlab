import { expect, type Locator, test } from "@playwright/test";
import { openWithTwoMachines } from "./lab.ts";

/** The newest output must stay in view: a terminal that re-tiles keeps following its tail. */
async function expectInside(inner: Locator, outer: Locator): Promise<void> {
	const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
	expect(a, "the line is laid out").not.toBeNull();
	expect(b, "the pane is laid out").not.toBeNull();
	if (!a || !b) return;
	expect(a.y).toBeGreaterThanOrEqual(b.y);
	expect(a.y + a.height).toBeLessThanOrEqual(b.y + b.height);
}

test("a console keeps its newest line in view when the agent panel re-tiles the panes", async ({ page }) => {
	await openWithTwoMachines(page);
	const pane = page.locator('unlab-pane[machine="node1"]');
	await pane.locator("unlab-terminal").first().click();
	await page.keyboard.type("seq 1 80; echo tail-$((40+2))\n");
	const tail = pane.getByText("tail-42", { exact: true });
	await expect(tail).toBeVisible();
	await expectInside(tail, pane);

	await page
		.getByRole("contentinfo")
		.getByRole("button", { name: /^webmcp:/ })
		.click();
	await expect(page.locator("unlab-agent-panel")).toBeVisible();
	await page.waitForTimeout(500);
	await expectInside(tail, pane);
});
