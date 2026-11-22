import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LabState } from "../../model/index.ts";
import { lab, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";
import { barStep, barView, RESTING } from "../command-bar/model.ts";
import type { AppServices } from "../services.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

const IMAGES = [
	{ name: "alpine", label: "alpine 3.24" },
	{ name: "debian", label: "debian 13" },
] as const;

/** The Add machines view open over a lab that offers alpine and debian. */
const opened = (state: LabState = lab()): LabState => ({ ...state, images: IMAGES, view: "spawn" });

function mountForm(state = opened()) {
	return mount("unlab-spawn-form", { state });
}

function the(selector: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(`unlab-spawn-form ${selector}`);
	if (!found) throw new Error(`no ${selector} in the form`);
	return found;
}

const text = (selector: string): string => the(selector).textContent?.replace(/\s+/g, " ").trim() ?? "";
const shownLine = (): string => text(".code.line").replace(/^: /, "");
const rows = (): string[][] =>
	[...document.querySelectorAll("unlab-spawn-form .you-get li")].map((li) =>
		[...li.children].map((cell) => cell.textContent ?? ""),
	);
const button = (name: string) => page.getByRole("button", { name, exact: true });

/** What the bar's panel would say under the same line, from the bar's own model. */
function barSays(services: AppServices, state: LabState, line: string): string {
	const { registry } = services.commands;
	const opened = barStep(RESTING, { kind: "open" }, state, registry).bar;
	const typed = barStep(opened, { kind: "edit", text: line, caret: line.length }, state, registry).bar;
	if (!typed.open) throw new Error("the bar closed");
	const { block } = barView(typed, state, registry);
	if (block.kind !== "preview") throw new Error(`the bar shows ${block.kind} for ${line}`);
	return [block.preview.will, block.preview.assumed].filter((part) => part !== null).join(" ");
}

describe("<unlab-spawn-form> choices", () => {
	it("starts at three alpine machines, 256 MiB each, plugged into switch0", async () => {
		await mountForm();
		expect(text("h1")).toBe("Add machines");
		expect(text(".count")).toBe("3");
		expect(text(".stepper .note")).toBe("768 MiB of memory in total");
		expect(shownLine()).toBe("spawn 3 alpine");
		expect(text(".code.call")).toBe('machines_spawn({"count": 3, "image": "alpine", "mem": 256, "net": "switch0"})');
		expect(rows()).toEqual([
			["node1", "10.88.0.11/24", "port 1"],
			["node2", "10.88.0.12/24", "port 2"],
			["node3", "10.88.0.13/24", "port 3"],
		]);
		expect(page.getByText("5 of 8 ports left on switch0 afterwards.").query()).not.toBeNull();
		await expect.element(button("Boot 3 machines")).toBeEnabled();
	});

	it.each([
		["debian 13", "spawn 3 debian", '"image": "debian"'],
		["128 MiB", "spawn 3 alpine --mem 128", '"mem": 128'],
		["512 MiB", "spawn 3 alpine --mem 512", '"mem": 512'],
		["1 GiB", "spawn 3 alpine --mem 1024", '"mem": 1024'],
		["leave unplugged", "spawn 3 alpine --no-net", '"net": "none"'],
	])("choosing %s shows %s and the same call for an agent", async (choice, line, field) => {
		const { settle } = await mountForm();
		await button(choice).click();
		await settle();
		expect(shownLine()).toBe(line);
		expect(text(".code.call")).toContain(field);
		await expect.element(button(choice)).toHaveAttribute("aria-pressed", "true");
	});

	it("presses exactly one button in each group", async () => {
		const { settle } = await mountForm();
		await button("debian 13").click();
		await button("1 GiB").click();
		await button("leave unplugged").click();
		await settle();
		const groups = [...document.querySelectorAll("unlab-spawn-form .choices[role=group]")];
		expect(groups.map((g) => g.getAttribute("aria-labelledby"))).toEqual([
			"spawn-image",
			"spawn-memory",
			"spawn-network",
		]);
		for (const group of groups) {
			const pressed = [...group.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent);
			expect(pressed).toHaveLength(1);
		}
		expect(shownLine()).toBe("spawn 3 debian --mem 1024 --no-net");
		expect(text(".stepper .note")).toBe("3 GiB of memory in total");
	});

	it("totals memory in GiB from 1024 MiB up", async () => {
		const { settle } = await mountForm();
		await button("512 MiB").click();
		await settle();
		expect(text(".stepper .note")).toBe("1.5 GiB of memory in total");
	});

	it("shows unplugged machines with their address and no port, and says how to plug them in", async () => {
		const { settle } = await mountForm();
		await button("leave unplugged").click();
		await settle();
		expect(rows().map((row) => row[2])).toEqual(["unplugged", "unplugged", "unplugged"]);
		expect(rows()[0]?.[1]).toBe("10.88.0.11/24");
		expect(page.getByText("They boot with no cable. Plug them in later from the switch.").query()).not.toBeNull();
		await button("One fewer").click();
		await button("One fewer").click();
		await settle();
		expect(page.getByText("It boots with no cable. Plug it in later from the switch.").query()).not.toBeNull();
	});

	it("names each new machine in its hue, after the machines the lab already has", async () => {
		await mountForm(opened(lab(spawn(3), ready())));
		expect(rows()).toEqual([
			["node4", "10.88.0.14/24", "port 4"],
			["node5", "10.88.0.15/24", "port 5"],
			["node6", "10.88.0.16/24", "port 6"],
		]);
		const name = the(".you-get li .name");
		expect(name.closest("li")?.dataset.hue).toBe("4");
		expect(getComputedStyle(name).color).toBe(tokenColor("hue-4"));
		expect(page.getByText("2 of 8 ports left on switch0 afterwards.").query()).not.toBeNull();
	});
});

describe("<unlab-spawn-form> stepper", () => {
	it("goes no lower than one", async () => {
		const { settle } = await mountForm();
		await button("One fewer").click();
		await button("One fewer").click();
		await settle();
		expect(text(".count")).toBe("1");
		await expect.element(button("One fewer")).toBeDisabled();
		await expect.element(button("Boot 1 machine")).toBeEnabled();
		expect(text(".stepper .note")).toBe("256 MiB of memory in total");
	});

	it("goes no higher than the room the lab has left", async () => {
		const { settle } = await mountForm(opened(lab(spawn(5), ready())));
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

	it("counts up to eight in an empty lab", async () => {
		const { settle } = await mountForm();
		for (let i = 0; i < 5; i++) await button("One more").click();
		await settle();
		expect(text(".count")).toBe("8");
		await expect.element(button("One more")).toBeDisabled();
		expect(page.getByText("0 of 8 ports left on switch0 afterwards.").query()).not.toBeNull();
	});
});

describe("<unlab-spawn-form> preview", () => {
	it.each([
		["the defaults", []],
		["debian, 512 MiB, unplugged", ["debian 13", "512 MiB", "leave unplugged"]],
		["one machine at 1 GiB", ["One fewer", "One fewer", "1 GiB"]],
	])("says what the bar would say for the same line, with %s", async (_, clicks) => {
		const { services, store, settle } = await mountForm(opened(lab(spawn(2), ready())));
		for (const name of clicks) await button(name).click();
		await settle();
		const assumed = document.querySelector("unlab-spawn-form .preview .assumed")?.textContent ?? "";
		const shown = [text(".preview .will"), assumed].filter((part) => part !== "").join(" ");
		expect(shown).toBe(barSays(services, store.state, shownLine()));
		expect(text(".preview .will-label")).toBe("will");
	});

	it("shows the bar's refusal and will not boot when the lab is full", async () => {
		await mountForm(opened(lab(spawn(8), ready())));
		expect(text(".count")).toBe("1");
		await expect.element(button("One fewer")).toBeDisabled();
		await expect.element(button("One more")).toBeDisabled();
		await expect.element(button("Boot 1 machine")).toBeDisabled();
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("The lab has no room for another machine. Remove one with rm first. Nothing was changed.");
		expect(rows()).toEqual([]);
	});
});

describe("<unlab-spawn-form> leaving", () => {
	it("boots exactly the line it shows, as a button, then returns to the lab", async () => {
		const { runs, store, settle } = await mountForm();
		await button("debian 13").click();
		await button("One fewer").click();
		await settle();
		const line = shownLine();
		await button("Boot 2 machines").click();
		await settle();
		expect(runs).toEqual([{ line, source: "button" }]);
		expect(line).toBe("spawn 2 debian");
		expect(store.state.view).toBe("lab");
	});

	it.each(["Cancel", "← back to the lab"])("returns to the lab on %s without running anything", async (name) => {
		const { runs, store } = await mountForm();
		await button(name).click();
		expect(store.state.view).toBe("lab");
		expect(runs).toEqual([]);
	});
});

describe("<unlab-spawn-form> in the app", () => {
	function mountApp(state: LabState) {
		return mount("unlab-app", {
			state,
			prepare: (element, services) => {
				element.services = services;
			},
		});
	}

	it("opens from Add machine over the whole body, fresh each time", async () => {
		const { settle } = await mountApp({ ...lab(), images: IMAGES });
		expect(document.querySelector("unlab-spawn-form")).toBeNull();
		await button("Add machine").click();
		await settle();
		expect(document.querySelector<HTMLElement>("unlab-app .body")?.hidden).toBe(true);
		await button("debian 13").click();
		await button("Cancel").click();
		await settle();
		expect(document.querySelector("unlab-spawn-form")).toBeNull();
		await button("Add machine").click();
		await settle();
		await expect.element(button("alpine 3.24")).toHaveAttribute("aria-pressed", "true");
	});

	it("returns to the lab on Esc", async () => {
		const { store, settle } = await mountApp(opened());
		await button("One more").click();
		await userEvent.keyboard("{Escape}");
		await settle();
		expect(store.state.view).toBe("lab");
		expect(document.querySelector("unlab-spawn-form")).toBeNull();
	});

	it("passes axe", async () => {
		const { element } = await mountApp(opened(lab(spawn(2), ready())));
		const results = await axe.run(element);
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
		for (const name of ["One fewer", "One more", "alpine 3.24", "1 GiB", "leave unplugged"]) {
			expect(button(name).element().getBoundingClientRect().height, name).toBe(44);
		}
	});
});

const shots: string | undefined = import.meta.env.VITE_UI_SHOTS;

describe.skipIf(!shots)("screenshots for comparing with the artboards", () => {
	it("Add machines over a lab with three machines", async () => {
		await mount("unlab-app", {
			state: opened(lab(spawn(3), ready())),
			prepare: (element, services) => {
				element.services = services;
			},
		});
		await document.fonts.ready;
		await page.screenshot({ path: `${shots}/spawn-form.png` });
	});
});
