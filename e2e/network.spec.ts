import { expect, type Page, test } from "@playwright/test";

/** When set, the test also saves screenshots of the dock and of Wire there, for comparing with the artboards. */
const shots = process.env.UI_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
	if (!shots) return;
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: `${shots}/${name}.png` });
}

test("pings show in the dock; cutting a cable by its port floods, flushes and reconnects", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible({ timeout: 60_000 });

	const dock = page.locator("unlab-capture[mode=dock]");
	const faceplate = page.locator("unlab-switch[compact]");
	const rail = page.getByRole("complementary", { name: "Machines" });
	const node2 = rail.getByRole("button", { name: /^node2\b/ });

	const console1 = page.locator("#panel-node1-console");
	await console1.click();
	await page.keyboard.press("Control+/");
	await page.keyboard.type("exec node1 -- ping -c 2 10.88.0.12");
	await page.keyboard.press("Enter");
	await expect(
		dock.getByRole("listitem").filter({ hasText: "ICMP" }).filter({ hasText: "echo reply" }),
	).not.toHaveCount(0, {
		timeout: 30_000,
	});
	await expect(dock.getByRole("listitem").filter({ hasText: "node1 → node2" }).first()).toBeVisible();
	await expect(console1).toContainText("packet loss", { timeout: 30_000 });
	await shoot(page, "dock-pinging");

	await faceplate.getByRole("button", { name: "Cut the cable from node2 to port 2" }).click();
	await expect(dock.getByRole("listitem").filter({ hasText: "port 2 link down" })).toContainText(
		"Cable to node2 cut by you.",
	);
	await expect(node2).toContainText("cut");
	await expect(faceplate.locator('[data-port="2"] .word')).toHaveText("cut");
	await expect(page.getByText("switch0: 1 of 2 links up")).toBeVisible();

	// The console takes the line once its shell is back at a prompt; until then exec refuses it.
	await expect(async () => {
		await page.keyboard.press("Control+/");
		await page.keyboard.type("exec node1 -- ping -c 1 -W 1 10.88.0.12");
		await page.keyboard.press("Enter");
		await expect(dock.getByText(/unknown destination, flooded/).first()).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	await shoot(page, "dock-cut");

	await dock.getByRole("link", { name: "expand" }).click();
	const wire = page.locator("unlab-wire");
	await expect(wire).toBeVisible();
	const macTable = wire.locator("unlab-mac-table");
	await expect(macTable.locator("tr", { hasText: "node2" })).toContainText("flushed, link down");
	await expect(macTable.locator("tr", { hasText: "node1" })).toContainText("s ago");

	await wire.getByRole("textbox", { name: "filter" }).fill("icmp");
	const list = wire.getByRole("listbox", { name: "Captured frames" });
	await list.focus();
	await page.keyboard.press("ArrowUp");
	await expect(wire.locator("unlab-frame-detail")).toContainText("icmp echo request");
	await expect(wire.locator("unlab-frame-detail .did")).toContainText("did not know where node2 is");
	await shoot(page, "wire-cut");

	await page.keyboard.press("Escape");
	await expect(wire).toHaveCount(0);
	await expect(rail).toBeVisible();

	await faceplate.getByRole("button", { name: "Reconnect the cable from node2 to port 2" }).click();
	await expect(dock.getByRole("listitem").filter({ hasText: "port 2 link up" }).last()).toContainText(
		"Cable to node2 reconnected by you.",
	);
	await expect(node2).toContainText("up");
	await expect(faceplate.locator('[data-port="2"] .word')).toHaveText("up");
	expect(errors).toEqual([]);
});
