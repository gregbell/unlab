import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { openWithTwoMachines, root, typed } from "./lab.ts";
import { call, finish, registered, start } from "./webmcp.ts";

/** When set, the test also saves the panel with a call waiting there, for comparing with the Agent artboard. */
const shots = process.env.UI_SHOTS;

/** The browser's own WebMCP, so every call here goes through it as an agent's would. */
test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openPanel(page: Page) {
	await page
		.getByRole("contentinfo")
		.getByRole("button", { name: /^webmcp:/ })
		.click();
	return page.locator("unlab-agent-panel");
}

test("an agent lists, asks to remove node2, and node2 goes once the person clicks Remove node2", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);

	expect(await registered(page)).toEqual([
		"capture_read",
		"checkpoint_remove",
		"checkpoint_restore",
		"checkpoint_save",
		"file_write",
		"link_set",
		"machines_boot",
		"machines_list",
		"machines_poweroff",
		"machines_reboot",
		"machines_remove",
		"machines_spawn",
		"shell_exec",
		"shell_read",
	]);
	const shellRead = await page.evaluate(async () => {
		const tool = (await document.modelContext.getTools()).find((tool) => tool.name === "shell_read");
		return tool && { title: tool.title, annotations: tool.annotations };
	});
	expect(shellRead).toMatchObject({
		title: "Read a terminal",
		annotations: { consequentialHint: false, readOnlyHint: true, untrustedContentHint: true },
	});

	const panel = await openPanel(page);
	await expect(panel.getByRole("heading", { name: "webmcp" })).toBeVisible();

	const listed = await call(page, "machines_list", {});
	expect(listed).toMatchObject({ result: "2 machines · 2 ready" });
	await expect(panel.locator(".call").first()).toContainText("ls");
	await expect(panel.locator(".call").first()).toContainText("→ 2 machines · 2 ready");
	await expect(page.getByRole("contentinfo").getByRole("button", { name: /agent active/ })).toBeVisible();

	const echoed = await call(page, "shell_exec", { targets: "node1", command: "echo hello" });
	expect(echoed).toMatchObject({ data: { ran: [{ exitCode: 0, output: "hello", truncated: false }] } });
	await expect(panel.locator(".call").nth(1)).toContainText("→ exit 0 · hello");
	const read = await call(page, "shell_read", { machine: "node1", lines: 5 });
	expect(read).toMatchObject({ session: "node1:console" });
	expect(JSON.stringify(read)).toContain("hello");

	await start(page, "remove", "machines_remove", { names: "node2" });
	const block = panel.locator("unlab-confirm");
	await expect(block).toContainText("waiting for you");
	await expect(block).toContainText("rm node2");
	await expect(block).toContainText("There is no undo.");
	await expect(page.getByText("webmcp: 1 call waiting for you")).toBeVisible();
	if (shots) {
		await page.evaluate(() => document.fonts.ready);
		await page.screenshot({ path: `${shots}/agent-waiting.png` });
	}

	const rail = page.getByRole("complementary", { name: "Machines" });
	await expect(rail.getByRole("button", { name: /^node2\b/ })).toBeVisible();
	await panel.getByRole("button", { name: "Remove node2", exact: true }).click();
	expect(await finish(page, "remove")).toMatchObject({ result: "removed node2", data: { removed: ["node2"] } });
	await expect(rail.getByRole("button", { name: /^node2\b/ })).toHaveCount(0);
	await expect(block).toHaveCount(0);
	await expect(panel.locator(".call").last()).toContainText("→ removed node2");

	await page.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("deny, abort, off and pause, each as the handoff says", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await openWithTwoMachines(page);
	const panel = await openPanel(page);
	const block = panel.locator("unlab-confirm");

	await start(page, "deny", "machines_remove", { names: "node1" });
	await expect(block).toContainText("rm node1");
	await panel.getByRole("button", { name: "Deny", exact: true }).click();
	expect(await finish(page, "deny")).toEqual({ error: "Denied by the user." });
	await expect(block).toHaveCount(0);
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible();

	await start(page, "abort", "machines_spawn", { count: 1, image: "alpine" });
	await expect(block).toContainText("Boot node3");
	await page.evaluate(() => window.running?.get("abort")?.controller.abort());
	await expect(finish(page, "abort")).rejects.toThrow("AbortError");
	await expect(block).toHaveCount(0);
	await expect(panel.locator(".call").last()).toContainText("withdrawn by the agent");

	expect(await call(page, "machines_remove", { names: "node9" })).toEqual({
		error: expect.stringContaining("No machine called node9."),
	});

	await panel.getByRole("combobox", { name: "Policy for machines_list" }).selectOption("off");
	await expect.poll(() => registered(page)).not.toContain("machines_list");
	await panel.getByRole("button", { name: "pause tools" }).click();
	await expect.poll(() => registered(page)).toEqual([]);
	await expect(page.getByText("webmcp: paused")).toBeVisible();
	await panel.getByRole("button", { name: "resume tools" }).click();
	await expect.poll(() => registered(page)).toHaveLength(13);
	expect(errors).toEqual([]);
});

test("a yes removes only what it was asked about: not a machine that took the name, nor one that gained a shell", async ({
	page,
}) => {
	const changed = { error: "What this does to web has changed since it was asked. Nothing was changed." };
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	const ready = expect(page.getByText("1 of 1 machine ready"));
	await typed(page, "spawn 1 alpine --name web");
	await ready.toBeVisible({ timeout: 60_000 });
	const approve = page.locator("unlab-agent-panel").getByRole("button", { name: "Remove web", exact: true });

	await start(page, "first", "machines_remove", { names: "web" });
	await expect(approve).toBeVisible();
	await typed(page, "rm web");
	await expect(page.locator("unlab-command-bar unlab-confirm")).toContainText("Remove web?");
	await page.keyboard.press("Enter");
	await expect(page.locator("unlab-pane[machine=web]")).toHaveCount(0);
	await typed(page, "spawn 1 alpine --name web");
	await ready.toBeVisible({ timeout: 60_000 });
	await root(page, "web", "echo kept > /root/kept");
	await approve.click();
	expect(await finish(page, "first")).toEqual(changed);
	await expect(page.locator("unlab-agent-panel .call", { hasText: "rm web" })).toContainText(changed.error);
	expect(await root(page, "web", "cat /root/kept")).toBe("kept");

	await start(page, "second", "machines_remove", { names: "web" });
	await expect(approve).toBeVisible();
	await typed(page, "sh web");
	await expect(page.getByRole("tab", { name: /sh1/ })).toBeVisible();
	await approve.click();
	expect(await finish(page, "second")).toEqual(changed);
	expect(await root(page, "web", "cat /root/kept")).toBe("kept");

	await start(page, "third", "machines_remove", { names: "web" });
	await expect(page.locator("unlab-agent-panel unlab-confirm")).toContainText("Its console and 1 shell close");
	await approve.click();
	expect(await finish(page, "third")).toMatchObject({ data: { removed: ["web"] } });
});

test("output longer than the terminal keeps comes back as its end, flagged", async ({ page }) => {
	await openWithTwoMachines(page);
	const reply = await call(page, "shell_exec", { targets: "node1", command: "seq 1 20000" });
	expect(reply).toMatchObject({
		data: { ran: [{ exitCode: 0, truncated: true, output: expect.stringMatching(/^1\d{4}\n[\d\n]*\n20000$/) }] },
	});
});

test("try a call makes a person's first call through the browser", async ({ page }) => {
	await page.goto("/");
	const panel = await openPanel(page);
	await panel.getByRole("button", { name: "try a call" }).click();
	await expect(panel.locator(".call")).toHaveCount(1);
	await expect(panel.locator(".call")).toContainText("ls");
	await expect(panel.locator(".call")).toContainText("→ no machines yet");
	await expect(panel.getByRole("button", { name: "try a call" })).toHaveCount(0);
	await expect(page.getByRole("contentinfo").getByRole("button", { name: /agent active/ })).toBeVisible();
});

for (const [where, width, height] of [
	["beside the form", 1440, 900],
	["beside a form taller than the window", 1100, 600],
	["under the form in a narrow window", 700, 700],
] as const) {
	test(`an agent's first boot asks in view on the empty lab: ${where}`, async ({ page }) => {
		await page.setViewportSize({ width, height });
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
		await expect.poll(() => registered(page)).toHaveLength(14);

		await start(page, "spawn", "machines_spawn", { count: 1, image: "alpine" });
		const boot = page.locator("unlab-agent-panel").getByRole("button", { name: "Boot node1", exact: true });
		await expect(boot).toBeInViewport({ ratio: 1 });
		await boot.click();
		expect(await finish(page, "spawn")).toMatchObject({ data: { names: ["node1"] } });
		await expect(page.getByText("1 of 1 machine ready")).toBeVisible({ timeout: 60_000 });
	});
}

test("an approval stays in view below a long list of calls", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 500 });
	await openWithTwoMachines(page);
	for (let i = 0; i < 12; i++) await call(page, "machines_list", {});
	await start(page, "remove", "machines_remove", { names: "node2" });
	await expect(
		page.locator("unlab-agent-panel").getByRole("button", { name: "Remove node2", exact: true }),
	).toBeInViewport({ ratio: 1 });
});
