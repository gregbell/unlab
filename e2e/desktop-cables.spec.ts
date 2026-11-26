import { expect, type Locator, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, typed } from "./lab.ts";

/** When set, the test also saves a screenshot of the storm there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

/** The state of the line drawn from the centre of one node to the other's, or null when none is. */
async function wire(topology: Locator, a: string, b: string): Promise<string | null> {
	const centre = async (name: string) => {
		const box = await topology.locator(`.n-node[data-switch="${name}"], .n-node[data-machine="${name}"]`).boundingBox();
		if (!box) throw new Error(`${name} is not drawn`);
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	};
	const p = await centre(a),
		q = await centre(b);
	// A box takes in the stroke, which a selected line has wider.
	const near = (u: number, v: number) => Math.abs(u - v) < 10;
	for (const path of await topology.locator(".wire").all()) {
		const box = await path.boundingBox();
		if (
			box &&
			near(box.x, Math.min(p.x, q.x)) &&
			near(box.x + box.width, Math.max(p.x, q.x)) &&
			near(box.y, Math.min(p.y, q.y)) &&
			near(box.y + box.height, Math.max(p.y, q.y))
		)
			return path.getAttribute("data-state");
	}
	return null;
}

test("the desktop draws a cable between switches, cuts and removes it from the switch's ports, shows a storm until its loop is cut, and maps a VLAN and a moved cable", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Welcome to unLAB" })).toBeVisible();
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 lab --no-gateway");
	await typed(page, "spawn 1 lab --net lan --no-gateway");
	const rack = page.getByRole("region", { name: "Rack manager" });
	for (const on of ["switch0", "lan"])
		await expect(rack.locator(`[data-switch="${on}"] .dt-port-block`).first()).toHaveAttribute("data-state", "up", {
			timeout: 90_000,
		});

	await typed(page, "cable switch0 lan");
	const topology = page.getByRole("region", { name: "Topology" });
	await expect.poll(() => wire(topology, "switch0", "lan")).toBe("up");
	await expect(topology.locator('[data-switch="switch0"] small')).toHaveText("2 / 8 ports");

	await page.getByRole("button", { name: "Lab menu" }).click();
	await page.getByRole("menuitem", { name: "Patch cable…" }).click();
	const patch = page.getByRole("region", { name: "Patch cable" });
	await expect(patch.getByRole("combobox", { name: "Destination" })).toHaveValue("switch0:3");
	await patch.getByRole("button", { name: "Close Patch cable" }).click();

	const inspect = rack.getByRole("button", { name: "Inspect switch0" });
	await expect(inspect).toHaveAccessibleDescription(/Port 2 · to lan port 2 · up/);
	await expect(inspect).toContainText("2 / 8 ports");
	await inspect.click();
	const details = page.getByRole("region", { name: "switch0 · Switch details" });
	await expect(details.getByText("2 / 8 ports connected")).toBeVisible();
	const port = details.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "2", exact: true }) });
	await expect(port.getByRole("button", { name: "lan port 2" })).toBeVisible();
	await expect(port.getByRole("button", { name: "Patch" })).toHaveCount(0);
	await port.getByRole("button", { name: "Cut cable" }).click();
	await expect(port.getByRole("cell", { name: "cut", exact: true })).toBeVisible();
	await expect.poll(() => wire(topology, "switch0", "lan")).toBe("cut");

	await port.getByRole("button", { name: "lan port 2" }).click();
	const lan = page.getByRole("region", { name: "lan · Switch details" });
	await typed(page, "cable lan lan");
	await root(page, 2, "arping -c 1 -w 1 -I eth0 10.88.0.99; true");
	await expect(topology.locator('[data-switch="lan"] small')).toHaveText("4 / 8 ports · storming", { timeout: 5000 });
	await expect(lan.getByText("4 / 8 ports connected · storming")).toBeVisible();
	await expect(lan.getByText(/^\d+ looped frames a second · \d+ dropped$/)).toBeVisible();
	await expect(rack.getByRole("button", { name: "Inspect lan" })).toContainText("storming");
	if (shots) await page.screenshot({ path: `${shots}/desktop-storm.png` });

	const loop = lan.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "3", exact: true }) });
	await expect(loop.getByRole("button", { name: "lan port 4" })).toBeVisible();
	await loop.getByRole("button", { name: "Cut cable" }).click();
	await expect(topology.locator('[data-switch="lan"] small')).toHaveText("4 / 8 ports");
	await expect(lan.getByText(/looped frames a second/)).toHaveCount(0);
	await expect(rack.getByRole("button", { name: "Inspect lan" })).not.toContainText("storming");

	await lan.getByRole("button", { name: "Close lan · Switch details" }).click();
	await port.getByRole("button", { name: "Remove" }).click();
	await expect(port.getByRole("button", { name: "Patch" })).toBeVisible();
	await expect.poll(() => wire(topology, "switch0", "lan")).toBeNull();
	await expect(topology.locator('[data-switch="lan"] small')).toHaveText("3 / 8 ports");

	await typed(page, "vlan node2 10");
	await expect(topology.getByRole("button", { name: "Inspect machine node2" })).toHaveAccessibleDescription(
		"eth0 · to lan port 1 · up · vlan 10",
	);
	await expect(topology.locator('[data-switch="lan"]')).toHaveAttribute("title", /^Port 1 · node2 · up · vlan 10$/m);
	await expect(topology.locator('[data-machine="node2"] small')).toHaveText("lab");
	await typed(page, "plug node1 lan");
	await expect.poll(() => wire(topology, "lan", "node1")).toBe("up");
	await expect.poll(() => wire(topology, "switch0", "node1")).toBeNull();
	await expect(topology.getByRole("button", { name: "Inspect machine node1" })).toHaveAccessibleDescription(
		"eth0 · to lan port 2 · up",
	);
	expect(errors).toEqual([]);
});
