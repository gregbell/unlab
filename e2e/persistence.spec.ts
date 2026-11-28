import { expect, type Page, test } from "@playwright/test";
import {
	configuration,
	openWithTwoMachines,
	portRow,
	rackRow,
	screen,
	status,
	switchDetails,
	terminal,
} from "./lab.ts";

async function shell(page: Page, node: number, command: string, result: string) {
	const shown = screen(page, `node${node}`);
	await shown.click();
	await page.keyboard.type(command);
	await page.keyboard.press("Enter");
	await expect(shown).toContainText(result);
}

test("reload restores distinct sized machines, private files and a cut cable", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Customize machines" }).click();
	const wizard = page.getByRole("region", { name: "Add machines" });
	await wizard.getByRole("button", { name: /Compute$/ }).click();
	await wizard.getByLabel("Virtual CPUs").fill("2");
	await wizard.getByLabel("Memory (MiB)").fill("512");
	await wizard.getByRole("button", { name: /Storage$/ }).click();
	await wizard.getByRole("combobox", { name: "Root disk · /dev/wdb" }).selectOption("8");
	await wizard.getByRole("button", { name: /Review$/ }).click();
	await wizard.getByRole("button", { name: "Boot 2 machines" }).click();
	await status(page, "2 of 2 ready", 90000);
	for (const n of [1, 2]) {
		await shell(
			page,
			n,
			`hostname > ~/identity; echo CPUs=$(getconf _NPROCESSORS_ONLN) node=$(cat ~/identity)`,
			`CPUs=2 node=node${n}`,
		);
	}
	const port = async () => portRow(await switchDetails(page, "switch0"), 2);
	const cut = (await port()).getByRole("button", { name: "Cut cable" });
	await expect(cut).toHaveAttribute("title", "Cut the cable from node2 to port 2");
	await cut.click();
	await page.reload();
	await status(page, "2 of 2 ready", 90000);
	await expect((await port()).getByRole("button", { name: "Reconnect" })).toHaveAttribute(
		"title",
		"Reconnect the cable from node2 to port 2",
	);
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
	await screen(page, "node1").click();
	await page.keyboard.press("Control+/");
	await page.keyboard.type("rm node1");
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "Remove node1", exact: true }).click();
	await expect(rackRow(page, "node1")).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name).sort()))
		.toEqual(["kwdisk:unlab-node2-v1"]);
	await page.reload();
	await expect(rackRow(page, "node1")).toHaveCount(0);
	await expect(await configuration(page, "node2")).toContainText("node2 · ready");
	await expect(terminal(page, "node2")).toBeVisible();
	await page.keyboard.press("Control+/");
	await page.keyboard.type("spawn 1 alpine");
	await page.keyboard.press("Enter");
	await expect(terminal(page, "node3")).toBeVisible();
});
