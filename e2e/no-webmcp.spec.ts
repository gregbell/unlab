import { expect, test } from "@playwright/test";

test("a browser without WebMCP says so, and the panel says how to turn it on", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/");
	expect(await page.evaluate(() => "modelContext" in document || "modelContext" in navigator)).toBe(false);
	await page.getByRole("button", { name: "Lab menu" }).click();
	await page.getByRole("menuitem", { name: "WebMCP" }).click();
	const panel = page.locator("unlab-agent-panel");
	await expect(panel).toContainText("This tab has no WebMCP");
	await expect(panel).toContainText("chrome://flags/#enable-webmcp-testing");
	await panel.getByRole("button", { name: "copy address" }).click();
	await expect(panel.getByRole("status")).toHaveText("Copied.");
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("chrome://flags/#enable-webmcp-testing");
	await expect(panel.getByRole("button", { name: "try a call" })).toHaveCount(0);
});
