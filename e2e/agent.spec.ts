import { expect, type Page, test } from "@playwright/test";
import { openWithTwoMachines } from "./lab.ts";

/** When set, the test also saves the panel with a call waiting there, for comparing with the Agent artboard. */
const shots = process.env.UI_SHOTS;

interface FakeTool {
	readonly name: string;
	readonly annotations: Record<string, boolean>;
	execute(input: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

declare global {
	interface Window {
		/** What the fake `document.modelContext` holds, and calls left running between evaluates. */
		readonly webmcp: {
			readonly tools: Map<string, FakeTool>;
			readonly running: Map<string, { promise: Promise<unknown>; controller: AbortController }>;
		};
	}
}

/** A browser with WebMCP, as far as the page can tell: a modelContext that records what registers. */
async function fakeWebMcp(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const tools = new Map<string, FakeTool>();
		Object.defineProperty(window, "webmcp", { value: { tools, running: new Map() } });
		Object.defineProperty(document, "modelContext", {
			value: {
				registerTool(tool: FakeTool, { signal }: { signal: AbortSignal }) {
					tools.set(tool.name, tool);
					signal.addEventListener("abort", () => {
						if (tools.get(tool.name) === tool) tools.delete(tool.name);
					});
				},
			},
		});
	});
}

const registered = (page: Page) => page.evaluate(() => [...window.webmcp.tools.keys()].sort());

/** Calls a tool as an agent would and waits for its answer. */
const call = (page: Page, name: string, input: unknown) =>
	page.evaluate(
		([name, input]) => {
			const tool = window.webmcp.tools.get(name);
			if (!tool) throw new Error(`${name} is not registered`);
			return tool.execute(input, {});
		},
		[name, input] as const,
	);

/** Starts a call and leaves it running under `key`, as an agent waiting on a person would. */
const start = (page: Page, key: string, name: string, input: unknown) =>
	page.evaluate(
		([key, name, input]) => {
			const tool = window.webmcp.tools.get(name);
			if (!tool) throw new Error(`${name} is not registered`);
			const controller = new AbortController();
			const promise = tool.execute(input, { signal: controller.signal });
			promise.catch(() => {});
			window.webmcp.running.set(key, { promise, controller });
		},
		[key, name, input] as const,
	);

const finish = (page: Page, key: string) => page.evaluate((key) => window.webmcp.running.get(key)?.promise, key);

test("an agent lists, asks to remove node2, and node2 goes once the person clicks Remove node2", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await fakeWebMcp(page);
	await openWithTwoMachines(page);

	expect(await registered(page)).toEqual([
		"capture_read",
		"link_set",
		"machines_list",
		"machines_remove",
		"machines_spawn",
		"shell_exec",
		"shell_read",
	]);
	expect(await page.evaluate(() => window.webmcp.tools.get("shell_read")?.annotations)).toEqual({
		readOnlyHint: true,
		untrustedContentHint: true,
	});

	await page
		.getByRole("contentinfo")
		.getByRole("button", { name: /^webmcp:/ })
		.click();
	const panel = page.locator("unlab-agent-panel");
	await expect(panel.getByRole("heading", { name: "webmcp" })).toBeVisible();

	const listed = await call(page, "machines_list", {});
	expect(listed).toMatchObject({ result: "2 machines · 2 ready" });
	await expect(panel.locator(".call").first()).toContainText("ls");
	await expect(panel.locator(".call").first()).toContainText("→ 2 machines · 2 ready");
	await expect(page.getByRole("contentinfo").getByRole("button", { name: /agent active/ })).toBeVisible();

	const echoed = await call(page, "shell_exec", { targets: "node1", command: "echo hello" });
	expect(echoed).toMatchObject({ data: { ran: [{ exitCode: 0 }] } });
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
	await fakeWebMcp(page);
	await openWithTwoMachines(page);
	await page
		.getByRole("contentinfo")
		.getByRole("button", { name: /^webmcp:/ })
		.click();
	const panel = page.locator("unlab-agent-panel");
	const block = panel.locator("unlab-confirm");

	await start(page, "deny", "machines_remove", { names: "node1" });
	await expect(block).toContainText("rm node1");
	await panel.getByRole("button", { name: "Deny", exact: true }).click();
	expect(await finish(page, "deny")).toBe("Denied by the user.");
	await expect(block).toHaveCount(0);
	await expect(page.getByText("2 of 2 machines ready")).toBeVisible();

	await start(page, "abort", "machines_spawn", { count: 1, image: "alpine" });
	await expect(block).toContainText("Boot node3");
	await page.evaluate(() => window.webmcp.running.get("abort")?.controller.abort());
	await expect(block).toHaveCount(0);
	await expect(panel.locator(".call").last()).toContainText("withdrawn by the agent");

	await expect(call(page, "machines_remove", { names: "node9" })).rejects.toThrow("No machine called node9.");

	await panel.getByRole("combobox", { name: "Policy for machines_list" }).selectOption("off");
	await expect.poll(() => registered(page)).not.toContain("machines_list");
	await panel.getByRole("button", { name: "pause tools" }).click();
	await expect.poll(() => registered(page)).toEqual([]);
	await expect(page.getByText("webmcp: paused")).toBeVisible();
	await panel.getByRole("button", { name: "resume tools" }).click();
	await expect.poll(() => registered(page)).toHaveLength(6);
	expect(errors).toEqual([]);
});
