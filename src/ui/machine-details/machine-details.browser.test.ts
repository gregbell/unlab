import "./machine-details.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import {
	addSwitch,
	fail,
	focus,
	lab,
	link,
	mount,
	power,
	ready,
	remove,
	spawn,
	spawnAt,
	stopped,
	switchNamed,
	tick,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";

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
			["CPUs", "1"],
			["disk", "4 GiB"],
			["memory", "256 MiB"],
			["address", "10.88.0.12/24"],
			["mac", "52:54:00:88:00:0c"],
			["uplink", "lab only"],
			["link", "connected on port 2"],
			["frames", "90 in · 91 out"],
			["shells", "console"],
		]);
		expect(getComputedStyle(value("link")).color).toBe(tokenColor("ok"));
		const label = document.querySelector("unlab-machine-details dt");
		expect(label && getComputedStyle(label).color).toBe(tokenColor("text-3"));
	});

	it("runs each action's command as a button", async () => {
		const { runs } = await mount("unlab-machine-details", { state: lab(spawn(3), ready(), focus("node2")) });
		expect(enabledActions()).toEqual(["new shell", "Ping peers", "cut cable", "reboot", "power off", "remove"]);
		await action("new shell").click();
		await action("Ping peers").click();
		await action("cut cable").click();
		await action("reboot").click();
		await action("power off").click();
		expect(runs).toEqual([
			{ line: "sh node2", source: "button" },
			{ line: "exec node2 -- ping -c 3 10.88.0.11; ping -c 3 10.88.0.13", source: "button" },
			{ line: "link down node2", source: "button" },
			{ line: "reboot node2", source: "button" },
			{ line: "poweroff node2", source: "button" },
		]);
	});

	it("pings each peer where it can be reached, and leaves out one with no address", async () => {
		const { runs } = await mount("unlab-machine-details", {
			state: lab(spawnAt("10.1.0.1/24", "10.2.0.1/24"), spawnAt("10.2.0.9/24"), spawnAt(null), ready(), focus("node2")),
		});
		await action("Ping node1").click();
		expect(runs).toEqual([{ line: "exec node2 -- ping -c 3 10.2.0.1", source: "button" }]);
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
		expect(value("link").textContent).toBe("cable cut on port 1");
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

	it("names the switch that it plugs a NIC into when the lab has several", async () => {
		const state = lab(
			addSwitch(switchNamed("lan")),
			spawn(1, "none"),
			spawn(1, "none", "none"),
			ready(),
			focus("node1"),
		);
		const { runs, store, settle } = await mount("unlab-machine-details", { state });
		await action("plug into switch0").click();
		store.dispatchCommand({ type: "cmd/focus", target: "node2", mode: "plain" });
		await settle();
		await action("plug eth1 into switch0").click();
		expect(runs.map((run) => run.line)).toEqual(["link up node1", "link up node2:eth1"]);
	});

	it("tells a machine's NICs apart, counts the frames of them all, and cuts, reconnects or plugs in each", async () => {
		const { runs } = await mount("unlab-machine-details", {
			state: lab(
				spawn(1, "switch0", "switch0", "none"),
				ready(),
				link("down", { machine: "node1", nic: 1 }),
				focus("node1"),
			),
			counters: [
				[1, { rxFrames: 10, txFrames: 20 }],
				[2, { rxFrames: 1, txFrames: 2 }],
			],
		});
		expect(facts().slice(5)).toEqual([
			["uplink", "lab only"],
			["eth0", "connected on port 1"],
			["address", "10.88.0.11/24"],
			["mac", "52:54:00:88:00:0b"],
			["eth1", "cable cut on port 2"],
			["address", "none"],
			["mac", "52:54:00:88:01:0b"],
			["eth2", "unplugged"],
			["address", "none"],
			["mac", "52:54:00:88:02:0b"],
			["frames", "22 in · 11 out"],
			["shells", "console"],
		]);
		expect(getComputedStyle(value("eth0")).color).toBe(tokenColor("ok"));
		expect(getComputedStyle(value("eth1")).color).toBe(tokenColor("down"));
		await action("cut eth0").click();
		await action("reconnect eth1").click();
		await action("plug in eth2").click();
		expect(runs.map((run) => run.line)).toEqual(["link down node1:eth0", "link up node1:eth1", "link up node1:eth2"]);
	});

	it("cannot ping without a ready peer", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(2), ready("node1"), focus("node1")) });
		expect(enabledActions()).toEqual(["new shell", "cut cable", "reboot", "power off", "remove"]);
	});

	it("while booting, counts up and only offers remove", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(1), focus("node1"), tick(1400)) });
		expect(value("state").textContent).toBe("booting 1.4 s");
		expect(value("link").textContent).toBe("port 1 reserved");
		expect(enabledActions()).toEqual(["remove"]);
	});

	it("when failed, gives the runtime's reason and offers boot and remove", async () => {
		await mount("unlab-machine-details", {
			state: lab(spawn(1), focus("node1"), fail("node1", "No prompt after 120 s.")),
		});
		expect(value("state").textContent).toBe("failed");
		expect(getComputedStyle(value("state")).color).toBe(tokenColor("down"));
		await expect.element(page.getByText("No prompt after 120 s.")).toBeVisible();
		expect(enabledActions()).toEqual(["boot", "remove"]);
	});

	it("when off, offers to boot it and to change its cable", async () => {
		const { runs } = await mount("unlab-machine-details", {
			state: lab(spawn(2), ready(), focus("node1"), power("off", "node1"), stopped("node1")),
		});
		expect(value("state").textContent).toBe("off");
		expect(value("link").textContent).toBe("plugged into port 1");
		expect(enabledActions()).toEqual(["cut cable", "boot", "remove"]);
		await action("boot").click();
		await action("cut cable").click();
		expect(runs.map((run) => run.line)).toEqual(["boot node1", "link down node1"]);
	});

	it("while stopping, only offers remove", async () => {
		await mount("unlab-machine-details", { state: lab(spawn(2), ready(), focus("node1"), power("off", "node1")) });
		expect(value("state").textContent).toBe("powering off");
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
