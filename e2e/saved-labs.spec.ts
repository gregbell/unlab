import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

const SAVED = readFileSync(new URL("../test/fixtures/saved-labs/version-6.json", import.meta.url), "utf8");

interface Nic {
	readonly port: number | null;
	readonly link: string | null;
}

/** `switch1 2 cut`, with each NIC's port and link after the machine's name. */
async function cables(page: Page): Promise<string[]> {
	const { data } = (await call(page, "machines_list", {})) as { data: { name: string; nics: Nic[] }[] };
	return data.map(({ name, nics }) => [name, ...nics.map(({ port, link }) => `${port ?? "-"} ${link}`)].join(", "));
}

const AS_SAVED = [
	"node1, 1 up",
	"node3, 3 off",
	"switch1, 2 cut",
	"node5, 4 up, - unplugged, 5 cut",
	"node6, - unplugged",
];

test("a lab saved before there were several switches opens on one, with a machine called switch1 as it was", async ({
	page,
}) => {
	await page.addInitScript((saved) => {
		if (!localStorage.getItem("unlab.workspace.v1")) localStorage.setItem("unlab.workspace.v1", saved);
	}, SAVED);
	await page.goto("/?layout=classic");
	const ready = page.getByText("4 of 5 ready, 1 off");
	await expect(ready).toBeVisible({ timeout: 90_000 });
	expect(await cables(page)).toEqual(AS_SAVED);
	await expect(page.locator("unlab-switch .title")).toHaveText(["switch0"]);
	expect(await shell(page, "node1", "ping -c 1 -W 2 switch1")).toMatchObject({ exitCode: 1 });

	await page.reload();
	await expect(ready).toBeVisible({ timeout: 90_000 });
	expect(await cables(page)).toEqual(AS_SAVED);
	await typed(page, "link up switch1");
	await expect(
		page.locator("unlab-switch").getByRole("button", { name: "Cut the cable from switch1 to port 2" }),
	).toBeVisible();
	expect(await shell(page, "node1", "ping -c 2 -W 2 switch1")).toMatchObject({ exitCode: 0 });
	expect(await shell(page, "switch1", "hostname; ping -c 1 -W 2 node1")).toMatchObject({
		exitCode: 0,
		output: expect.stringMatching(/^switch1\n/),
	});
});
