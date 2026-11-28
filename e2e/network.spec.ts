import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import {
	consoleOf,
	inspector,
	macTable,
	openWithTwoMachines,
	portRow,
	rack,
	switchCapture,
	switchDetails,
} from "./lab.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

/** When set, the test also saves screenshots of the windows there, for comparing with the artboards. */
const shots = process.env.UI_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
	if (!shots) return;
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: `${shots}/${name}.png` });
}

test("pings show in the switch's capture; cutting a cable by its port floods, flushes and reconnects", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);

	const dock = await switchCapture(page, "switch0");
	/** Port 2 in switch0's details, brought in front of the capture windows. */
	const port2 = async () => portRow(await switchDetails(page, "switch0"), 2);
	const strip = rack(page).locator('[data-switch="switch0"] .dt-port-block').nth(1);

	const console1 = (await consoleOf(page, "node1")).locator(".wterm");
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
	await shoot(page, "capture-pinging");

	const cut = (await port2()).getByRole("button", { name: "Cut cable" });
	await expect(cut).toHaveAttribute("title", "Cut the cable from node2 to port 2");
	await cut.click();
	await expect(dock.getByRole("listitem").filter({ hasText: "port 2 link down" })).toContainText(
		"Cable to node2 cut by you.",
	);
	await expect(strip).toHaveAttribute("data-state", "cut");
	await expect((await port2()).locator("td[data-state]")).toHaveText("cut");
	await expect(rack(page).locator(".dt-rackfoot")).toContainText("1 link up");

	// The console takes the line once its shell is back at a prompt; until then exec refuses it.
	await expect(async () => {
		await page.keyboard.press("Control+/");
		await page.keyboard.type("exec node1 -- ping -c 1 -W 1 10.88.0.12");
		await page.keyboard.press("Enter");
		await expect(dock.getByText(/unknown destination, flooded/).first()).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	await shoot(page, "capture-cut");

	const table = await macTable(page, "switch0");
	await expect(table.getByRole("row", { name: /node2/ })).toContainText("flushed, link down");
	await expect(table.getByRole("row", { name: /node1/ })).toContainText("s ago");
	await shoot(page, "switch-details");

	await page.keyboard.press("Control+/");
	await page.keyboard.type("capture");
	await page.keyboard.press("Enter");
	const full = await inspector(page);
	await full.getByRole("textbox", { name: "filter" }).fill("icmp");
	const list = full.getByRole("listbox", { name: "Captured frames" });
	await list.focus();
	await page.keyboard.press("ArrowUp");
	await expect(full.locator("unlab-frame-detail")).toContainText("icmp echo request");
	await expect(full.locator("unlab-frame-detail .did")).toContainText("did not know where node2 is");
	await shoot(page, "packet-inspector");

	const reconnect = (await port2()).getByRole("button", { name: "Reconnect" });
	await expect(reconnect).toHaveAttribute("title", "Reconnect the cable from node2 to port 2");
	await reconnect.click();
	await expect(dock.getByRole("listitem").filter({ hasText: "port 2 link up" }).last()).toContainText(
		"Cable to node2 reconnected by you.",
	);
	await expect(strip).toHaveAttribute("data-state", "up");
	await expect((await port2()).locator("td[data-state]")).toHaveText("up");
	expect(errors).toEqual([]);
});
