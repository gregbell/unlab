import "./machine-details.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { fail, focus, lab, link, mount, ready, remove, spawn, tick, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

function facts(): [string, string][] {
	return [...document.querySelectorAll("unlab-machine-details .fact")].map((fact) => [
		fact.querySelector("dt")?.textContent ?? "",
		fact.querySelector("dd")?.textContent ?? "",
	]);
}

function value(label: string): HTMLElement {
	const fact = [...document.querySelectorAll("unlab-machine-details .fact")].find(
		(candidate) => candidate.querySelector("dt")?.textContent === label,
	);
	const dd = fact?.querySelector("dd");
	if (!(dd instanceof HTMLElement)) throw new Error(`no ${label} row`);
	return dd;
}

const action = (name: string | RegExp) => page.getByRole("button", { name });

function enabledActions(): string[] {
	return [...document.querySelectorAll<HTMLButtonElement>("unlab-machine-details .actions button")]
		.filter((button) => !button.disabled)
		.map((button) => button.textContent?.trim() ?? "");
}

describe("<unlab-machine-details>", () => {
	it("is absent while no machine has the keyboard", async () => {
		const { element } = await mount("unlab-machine-details");
		expect(element.hidden).toBe(true);
		expect(element.childElementCount).toBe(0);
	});

	it("names the focused machine at 16px in its hue", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(3), ready(), focus("node2")) });
		const heading = page.getByRole("heading", { name: "node2" });
		await expect.element(heading).toBeVisible();
		const style = getComputedStyle(heading.element());
		expect(style.fontSize).toBe("16px");
		expect(style.lineHeight).toBe("22px");
		expect(style.color).toBe(tokenColor("hue-2"));
	});

	it("lists the facts in the handoff's order, with the switch's frame counts before shells", async () => {
		await mount("unlab-machine-details", {
			state: lab(spawn(3), ready(), focus("node2")),
			counters: [[2, { rxFrames: 91, txFrames: 90 }]],
		});
		expect(facts()).toEqual([
			["state", "ready · 3582 ms"],
			["image", "alpine 3.24"],
			["memory", "256 MiB"],
			["address", "10.88.0.12/24"],
			["mac", "52:54:00:88:00:0c"],
			["uplink", "lab only"],
			["link", "connected"],
			["frames", "90 in · 91 out"],
			["shells", "console"],
		]);
		expect(getComputedStyle(value("link")).color).toBe(tokenColor("ok"));
		const label = document.querySelector("unlab-machine-details dt");
		expect(label && getComputedStyle(label).color).toBe(tokenColor("text-3"));
	});

	it("runs each action's command as a button", async () => {
		const { runs } = await mount("unlab-machine-details", { state: lab(spawn(3), ready(), focus("node2")) });
		expect(enabledActions()).toEqual(["new shell", "ping peers", "cut cable", "remove"]);
		await action("new shell").click();
		await action("ping peers").click();
		await action("cut cable").click();
		expect(runs).toEqual([
			{ line: "sh node2", source: "button" },
			{ line: "exec node2 -- ping -c 3 10.88.0.11; ping -c 3 10.88.0.13", source: "button" },
			{ line: "link down node2", source: "button" },
		]);
	});

	it("asks in the bar before removing, and runs nothing itself", async () => {
		const { runs, confirms } = await mount("unlab-machine-details", {
			state: lab(spawn(2), ready(), focus("node1")),
		});
		await action("remove").click();
		expect(confirms).toEqual(["rm node1"]);
		expect(runs).toEqual([]);
		expect(getComputedStyle(action("remove").element()).color).toBe(tokenColor("down"));
	});

	it("offers reconnect for a cut cable", async () => {
		const { runs } = await mount("unlab-machine-details", {
			state: lab(spawn(2), ready(), link("down", "node1"), focus("node1")),
		});
		expect(value("link").textContent).toBe("cable cut");
		expect(getComputedStyle(value("link")).color).toBe(tokenColor("down"));
		await action("reconnect").click();
		expect(runs).toEqual([{ line: "link up node1", source: "button" }]);
	});

	it("offers to plug in a machine that has no cable, and counts no frames for it", async () => {
		const { runs } = await mount("unlab-machine-details", { state: lab(spawn(1, "none"), ready(), focus("node1")) });
		expect(value("link").textContent).toBe("unplugged");
		expect(facts().map(([label]) => label)).not.toContain("frames");
		await action("plug in").click();
		expect(runs).toEqual([{ line: "link up node1", source: "button" }]);
	});

	it("cannot ping without a ready peer", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(2), ready("node1"), focus("node1")) });
		expect(enabledActions()).toEqual(["new shell", "cut cable", "remove"]);
	});

	it("while booting, counts up and only offers remove", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(1), focus("node1"), tick(1400)) });
		expect(value("state").textContent).toBe("booting 1.4 s");
		expect(value("link").textContent).toBe("reserved");
		expect(enabledActions()).toEqual(["remove"]);
	});

	it("when failed, gives the runtime's reason and only offers remove", async () => {
		await mount("unlab-machine-details", {
			state: lab(spawn(1), focus("node1"), fail("node1", "No prompt after 120 s.")),
		});
		expect(value("state").textContent).toBe("failed");
		expect(getComputedStyle(value("state")).color).toBe(tokenColor("down"));
		await expect.element(page.getByText("No prompt after 120 s.")).toBeVisible();
		expect(enabledActions()).toEqual(["remove"]);
	});

	it("while removing, offers nothing", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(2), ready(), focus("node1"), remove("node1")) });
		expect(value("state").textContent).toBe("removing");
		expect(enabledActions()).toEqual([]);
	});

	it("follows the keyboard to another machine", async () => {
		const { store, settle } = await mount("unlab-machine-details", { state: lab(spawn(2), ready(), focus("node1")) });
		store.dispatchCommand({ type: "cmd/focus", target: "node2", mode: "plain" });
		await settle();
		await expect.element(page.getByRole("heading", { name: "node2" })).toBeVisible();
	});
});
