// An agent outside the browser, through `npx unlab.run mcp`, on the built lab
// in a browser without WebMCP: what a person has who added the server to their
// agent and opened the lab.

import { expect, type Page, test } from "@playwright/test";
import { buildCli, freePort, type McpSession, TestCli } from "../test/support/cli.ts";
import { agentPanel, linkSaid, openWithTwoMachines } from "./lab.ts";

const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 4173}`;

test.beforeAll(buildCli);

let cli: TestCli;
test.beforeEach(async () => {
	cli = new TestCli(await freePort(), { origin: ORIGIN });
});
test.afterEach(() => cli.close());

type Answer = Record<string, unknown>;
const text = (answer: Answer) => (answer.result as { content: { text: string }[] }).content[0].text;
const isError = (answer: Answer) => (answer.result as { isError?: boolean }).isError === true;

async function linked(page: Page): Promise<McpSession> {
	const mcp = cli.mcp();
	await mcp.begin();
	expect(await mcp.tools()).toEqual([]);
	await expect.poll(() => cli.answers()).toBe(true);
	await openWithTwoMachines(page);
	expect(await page.evaluate(() => "modelContext" in document || "modelContext" in navigator)).toBe(false);
	await page.evaluate((hash) => {
		location.hash = hash;
	}, `cli=${cli.port}`);
	await expect.poll(() => mcp.tools()).toContain("machines_list");
	return mcp;
}

test("an agent that started before the lab linked gets its tools, and calls them through the panel", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const mcp = await linked(page);
	expect(mcp.count("notifications/tools/list_changed")).toBeGreaterThan(0);
	const { tools } = (await mcp.request("tools/list")).result as { tools: Record<string, unknown>[] };
	expect(tools.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["machines_list", "machines_spawn", "machines_remove", "shell_exec", "shell_read"]),
	);
	expect(tools.find((tool) => tool.name === "shell_read")).toMatchObject({
		title: expect.any(String),
		inputSchema: { type: "object" },
		annotations: { untrustedContentHint: true },
	});

	const listed = await mcp.request("tools/call", { name: "machines_list", arguments: {} });
	expect(isError(listed)).toBe(false);
	expect((JSON.parse(text(listed)) as { data: { name: string }[] }).data.map((m) => m.name)).toEqual([
		"node1",
		"node2",
	]);

	await expect(await linkSaid(page)).toHaveText("cli: linked, agent active");
	const panel = await agentPanel(page);
	await expect(panel.locator(".call").last()).toContainText("ls via cli");
	const block = panel.locator("unlab-confirm");

	const denying = mcp.ask("tools/call", { name: "machines_remove", arguments: { names: "node2" } });
	await expect(block).toContainText("rm node2");
	await panel.getByRole("button", { name: "Deny", exact: true }).click();
	const denied = await mcp.answer(denying);
	expect(isError(denied)).toBe(true);
	expect(text(denied)).toBe("Denied by the user.");
	await expect(block).toHaveCount(0);

	const spawning = mcp.ask("tools/call", {
		name: "machines_spawn",
		arguments: { count: 1, image: "alpine" },
		_meta: { progressToken: "spawn" },
	});
	await expect(block).toContainText("Boot node3");
	await expect.poll(() => mcp.count("notifications/progress"), { timeout: 15_000 }).toBeGreaterThan(0);
	mcp.send({ method: "notifications/cancelled", params: { requestId: spawning, reason: "Esc" } });
	await expect(block).toHaveCount(0);
	await expect(panel.locator(".call").last()).toContainText("withdrawn by the agent");

	const removing = mcp.ask("tools/call", { name: "machines_remove", arguments: { names: "node2" } });
	await panel.getByRole("button", { name: "Remove node2", exact: true }).click();
	const removed = await mcp.answer(removing);
	expect(isError(removed)).toBe(false);
	expect(text(removed)).toContain("removed node2");

	const changes = mcp.count("notifications/tools/list_changed");
	await panel.getByRole("combobox", { name: "Policy for machines_list" }).selectOption("off");
	await expect.poll(() => mcp.count("notifications/tools/list_changed")).toBe(changes + 1);
	expect(await mcp.tools()).not.toContain("machines_list");
	await panel.getByRole("button", { name: "pause tools" }).click();
	await expect.poll(() => mcp.tools()).toEqual([]);

	expect(mcp.stderr).toBe("");
	expect(errors).toEqual([]);
});

test("a tab that closes takes the tools away, and the call that ran is told so", async ({ page }) => {
	const mcp = await linked(page);
	const waiting = mcp.ask("tools/call", { name: "machines_remove", arguments: { names: "node1" } });
	await expect(page.locator("unlab-agent-panel unlab-confirm")).toContainText("rm node1");
	const changes = mcp.count("notifications/tools/list_changed");
	await page.close();
	expect(text(await mcp.answer(waiting))).toBe("The lab closed while this ran. Whether it finished is not known.");
	await expect.poll(() => mcp.count("notifications/tools/list_changed")).toBe(changes + 1);
	expect(await mcp.tools()).toEqual([]);
	const after = await mcp.request("tools/call", { name: "machines_list", arguments: {} });
	expect(text(after)).toContain("The lab is not linked.");
});
