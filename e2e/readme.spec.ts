import { expect, test } from "@playwright/test";

// The README's "Follow your first ping", step by step, as a person who reads it does.
test("the README's first ping works as it is written: boot two machines, ping, find it in the capture, cut the cable, ping again, reconnect", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/");

	// 1. Keep the two Alpine machines, boot them, and wait for 2 links up.
	const welcome = page.getByRole("region", { name: "Welcome to unLAB" });
	await expect(welcome.getByRole("button", { name: /alpine/i })).toHaveAttribute("aria-pressed", "true");
	await welcome.getByRole("button", { name: "Boot 2 machines" }).click();
	const rack = page.getByRole("region", { name: "Rack manager" });
	await expect(rack.getByText("2 links up")).toBeVisible({ timeout: 60_000 });

	// 2. In node1's terminal, the README's ping.
	const terminal = page.getByRole("region", { name: "node1 · terminal", exact: true });
	// The share lost in each summary on the terminal's rows, and not in the copy that it reads out.
	const losses = async () =>
		(await terminal.locator(".term-row").allTextContents()).flatMap((row) => {
			const lost = /packets transmitted, \d+ packets received, (\d+)% packet loss/.exec(row);
			return lost ? [lost[1]] : [];
		});
	const ping = async (said: number) => {
		await terminal.click();
		await expect(terminal.getByRole("textbox")).toBeFocused();
		await page.keyboard.type("ping -c 1 -W 2 node2");
		await page.keyboard.press("Enter");
		await expect.poll(async () => (await losses()).length, { timeout: 30_000 }).toBe(said);
		return (await losses()).at(-1);
	};

	// 3. 0% packet loss, and the echo request and reply in switch0's capture.
	expect(await ping(1)).toBe("0");
	await rack.getByRole("button", { name: "Open capture" }).click();
	const capture = page.locator("unlab-capture[on-switch=switch0]");
	const echoes = (kind: string) => capture.getByRole("listitem").filter({ hasText: kind });
	await expect(echoes("echo request").first()).toContainText("node1");
	await expect(echoes("echo reply").first()).toContainText("node2");
	const replies = await echoes("echo reply").count();

	// 4. Cut node2's cable in switch0's port row, and the same ping is lost, with no new reply.
	await rack.getByRole("button", { name: "Inspect switch0" }).click();
	const details = page.getByRole("region", { name: "switch0 · Switch details" });
	const row = details.getByRole("row").filter({ has: page.getByRole("button", { name: "node2", exact: true }) });
	await row.getByRole("button", { name: "Cut cable" }).click();
	await expect(row).toContainText("cut");
	expect(await ping(2)).toBe("100");
	await expect(echoes("echo reply")).toHaveCount(replies);

	// 5. Reconnect, and the ping is answered again, with a new reply in the capture.
	await row.getByRole("button", { name: "Reconnect" }).click();
	await expect(row).toContainText("up");
	expect(await ping(3)).toBe("0");
	await expect(echoes("echo reply")).toHaveCount(replies + 1);
	expect(errors).toEqual([]);
});
