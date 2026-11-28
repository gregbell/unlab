import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { LabState } from "../../model/index.ts";
import {
	addSwitch,
	lab,
	mount,
	ready,
	remove,
	spawn,
	stopped,
	switchNamed,
	tokenColor,
	unmountAll,
} from "../base/testing.ts";
import type { SpawnChoice } from "./form.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

const IMAGES = [
	{ name: "alpine", label: "alpine 3.24" },
	{ name: "debian", label: "debian 13" },
] as const;

/** A lab that offers alpine and debian. */
const offered = (state: LabState = lab()): LabState => ({ ...state, images: IMAGES });

/** The form as Welcome has it, handing what Customize is pressed with to `customized`. */
async function mountForm(state = offered()) {
	const customized: SpawnChoice[] = [];
	const mounted = await mount("unlab-spawn-form", {
		state,
		prepare: (form) => {
			form.customize = (choice) => customized.push(choice);
		},
	});
	return { ...mounted, customized };
}

function the(selector: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(`unlab-spawn-form ${selector}`);
	if (!found) throw new Error(`no ${selector} in the form`);
	return found;
}

const text = (selector: string): string => the(selector).textContent?.replace(/\s+/g, " ").trim() ?? "";
const rows = (): string[][] =>
	[...document.querySelectorAll("unlab-spawn-form .you-get li")].map((li) =>
		[...li.children].map((cell) => cell.textContent ?? ""),
	);
const button = (name: string) => page.getByRole("button", { name, exact: true });

describe("machine choices", () => {
	it("previews the default pair and its switch before the first boot", async () => {
		const { customized } = await mountForm();
		expect(text("h1")).toBe("Your Linux lab in a tab.");
		expect(rows()).toEqual([
			["node1", "10.88.0.11/24", "port 1"],
			["node2", "10.88.0.12/24", "port 2"],
		]);
		expect(text(".network-summary")).toBe("alpine 3.24 · switch0");
		await expect.element(button("Boot 2 machines")).toBeEnabled();
		await button("Customize machines").click();
		expect(customized).toEqual([expect.objectContaining({ count: 2, image: "alpine", mem: 256, net: "switch0" })]);
	});
	it("updates the distribution preview and boots the chosen settings", async () => {
		const { runs, customized } = await mountForm();
		await button("debian 13").click();
		await button("One fewer").click();
		expect(text(".network-summary")).toBe("debian 13 · switch0");
		expect(rows()).toEqual([["node1", "10.88.0.11/24", "port 1"]]);
		await button("Boot 1 machine").click();
		expect(runs).toEqual([{ line: "spawn 1 debian", source: "button" }]);
		await button("Customize machines").click();
		expect(customized).toEqual([expect.objectContaining({ count: 1, image: "debian" })]);
	});
	it("uses the next available identities and ports in a lab whose machines are gone", async () => {
		await mountForm(
			offered(
				lab(spawn(3), ready(), remove("node1", "node2", "node3"), stopped("node1"), stopped("node2"), stopped("node3")),
			),
		);
		expect(rows()).toEqual([
			["node4", "10.88.0.14/24", "port 1"],
			["node5", "10.88.0.15/24", "port 2"],
		]);
	});
});

describe("<unlab-spawn-form> stepper", () => {
	it("goes no lower than one", async () => {
		const { settle } = await mountForm();
		await button("One fewer").click();
		await settle();
		expect(text(".count")).toBe("1");
		await expect.element(button("One fewer")).toBeDisabled();
		await expect.element(button("Boot 1 machine")).toBeEnabled();
	});

	it("goes no higher than the room the lab has left", async () => {
		const { settle } = await mountForm(offered(lab(spawn(5), ready())));
		await button("One more").click();
		expect(text(".count")).toBe("3");
		await expect.element(button("One more")).toBeDisabled();
		await button("One fewer").click();
		await settle();
		await expect.element(button("One more")).toBeEnabled();
		await button("One more").click();
		await settle();
		expect(text(".count")).toBe("3");
		await expect.element(button("One more")).toBeDisabled();
	});

	it("goes no higher than the ports machines with several NICs have left", async () => {
		const three = ["switch0", "switch0", "switch0"] as const;
		await mountForm(offered(lab(spawn(2, ...three), spawn(1), ready())));
		expect(text(".count")).toBe("1");
		await expect.element(button("One more")).toBeDisabled();
		expect(rows()).toEqual([["node4", "10.88.0.14/24", "port 8"]]);
	});

	it("counts up to eight in an empty lab", async () => {
		const { settle } = await mountForm();
		for (let i = 0; i < 6; i++) await button("One more").click();
		await settle();
		expect(text(".count")).toBe("8");
		await expect.element(button("One more")).toBeDisabled();
	});
});

describe("<unlab-spawn-form> preview", () => {
	it("shows the bar's refusal and will not boot when the lab is full", async () => {
		await mountForm(offered(lab(spawn(8), spawn(8, "none"), ready())));
		expect(text(".count")).toBe("1");
		await expect.element(button("One fewer")).toBeDisabled();
		await expect.element(button("One more")).toBeDisabled();
		await expect.element(button("Boot 1 machine")).toBeDisabled();
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("The lab has all 16 machines that it can, so remove one with rm first. Nothing was changed.");
		expect(rows()).toEqual([]);
	});
});

describe("<unlab-spawn-form> with several switches", () => {
	it("names the switch that each port is on", async () => {
		const { element } = await mountForm(offered(lab(addSwitch(switchNamed("lan")), spawn(1), ready())));
		const ports = [...element.querySelectorAll(".you-get .port")].map((port) => port.textContent);
		expect(ports).toEqual(["switch0 port 2", "switch0 port 3"]);
	});
});

describe("<unlab-spawn-form> in Welcome", () => {
	it("passes axe", async () => {
		await mount("unlab-app", {
			state: offered(),
			prepare: (element, services) => {
				element.services = services;
			},
		});
		const form = document.querySelector("unlab-spawn-form");
		if (!form) throw new Error("Welcome has no form");
		const results = await axe.run(form);
		const failures = results.violations.flatMap((violation) =>
			violation.nodes.map((node) => `${violation.id} at ${node.target.join(" ")}: ${node.failureSummary}`),
		);
		expect(failures).toEqual([]);
	});
});

describe("<unlab-spawn-form> type and size", () => {
	it("sets the title at 28px on 36px, the count at 28px, and 44px controls", async () => {
		await mountForm();
		const title = getComputedStyle(the("h1"));
		expect([title.fontSize, title.lineHeight, title.letterSpacing, title.fontWeight]).toEqual([
			"28px",
			"36px",
			"-0.4px",
			"500",
		]);
		expect(getComputedStyle(the(".count")).fontSize).toBe("28px");
		const boot = the(".button.primary");
		expect(boot.getBoundingClientRect().height).toBe(44);
		expect(getComputedStyle(boot).backgroundColor).toBe(tokenColor("text"));
		for (const name of ["One fewer", "One more", "alpine 3.24"]) {
			expect(button(name).element().getBoundingClientRect().height, name).toBe(44);
		}
	});
});
