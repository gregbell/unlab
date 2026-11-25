import { expect, type Page, test } from "@playwright/test";
import { openWithTwoMachines } from "./lab.ts";

async function shell(page: Page, node: number, command: string, result: string) {
	const panel = page.locator(`#panel-node${node}-console`);
	await panel.click();
	await page.keyboard.type(command);
	await page.keyboard.press("Enter");
	await expect(panel).toContainText(result);
}

test("reload restores distinct sized machines, private files and a cut cable", async ({ page }) => {
	await page.goto("/");
	await page.getByText("Customize machines", { exact: true }).click();
	await page.getByLabel("CPUs each").selectOption("2");
	await page.getByRole("button", { name: "512 MiB" }).click();
	await page.getByRole("button", { name: "8 GiB" }).click();
	await page.getByRole("button", { name: "Boot 2 machines" }).click();
	await expect(page.getByText("2 of 2 ready")).toBeVisible({ timeout: 90000 });
	for (const n of [1, 2]) {
		await shell(
			page,
			n,
			`hostname > ~/identity; echo CPUs=$(getconf _NPROCESSORS_ONLN) node=$(cat ~/identity)`,
			`CPUs=2 node=node${n}`,
		);
	}
	await page.getByRole("button", { name: "Cut the cable from node2 to port 2" }).click();
	await page.reload();
	await expect(page.getByText("2 of 2 ready")).toBeVisible({ timeout: 90000 });
	await expect(page.getByRole("button", { name: "Reconnect the cable from node2 to port 2" })).toBeVisible();
	for (const n of [1, 2]) {
		await shell(
			page,
			n,
			"echo restored=$(cat ~/identity) capacity=$(df -P /data | tail -1 | awk '{print int($2/1000000)}')",
			`restored=node${n} capacity=8`,
		);
	}
});

test("removing one node releases its disk and preserves the other node's identity", async ({ page, context }) => {
	await openWithTwoMachines(page);
	const second = await context.newPage();
	await second.goto("/");
	await expect(second.getByText(/This lab is open in another tab/)).toBeVisible();
	await second.close();
	await page.locator("#panel-node1-console").click();
	await page.keyboard.press("Control+/");
	await page.keyboard.type("rm node1");
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "Remove node1", exact: true }).click();
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name).sort()))
		.toEqual(["kwdisk:unlab-node2-v1"]);
	await page.reload();
	await expect(page.locator("unlab-pane[machine=node1]")).toHaveCount(0);
	await expect(page.locator("unlab-machine-details")).toContainText("ready");
	await expect(page.locator("unlab-pane[machine=node2]")).toBeVisible();
	await page.keyboard.press("Control+/");
	await page.keyboard.type("spawn 1 alpine");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-pane[machine=node3]")).toBeVisible();
});
