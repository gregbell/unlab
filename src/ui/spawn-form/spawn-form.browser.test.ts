import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { LabState } from "../../model/index.ts";
import { lab, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

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
const rows = (): string[][] =>
	[...document.querySelectorAll("unlab-spawn-form .you-get li")].map((li) =>
		[...li.children].map((cell) => cell.textContent ?? ""),
	);
const button = (name: string) => page.getByRole("button", { name, exact: true });

const customize = () => page.getByText("Customize machines", { exact: true }).click();

describe("machine choices", () => {
	it("previews the default pair and its switch before the first boot", async () => {
		await mountForm();
		expect(text("h1")).toBe("Your Linux lab in a tab.");
		expect(rows()).toEqual([
			["node1", "10.88.0.11/24", "port 1"],
			["node2", "10.88.0.12/24", "port 2"],
		]);
		expect(text(".network-summary")).toBe("alpine 3.24 · switch0");
		await expect.element(button("Boot 2 machines")).toBeEnabled();
		expect(the(".customize").hasAttribute("open")).toBe(false);
		await customize();
		await expect.element(page.getByRole("combobox", { name: "CPUs each" })).toHaveValue("2");
		await expect.element(button("256 MiB")).toHaveAttribute("aria-pressed", "true");
	});
	it("updates the distribution and connection preview and boots the chosen settings", async () => {
		const { runs } = await mountForm();
		await button("debian 13").click();
		await customize();
		await button("512 MiB").click();
		await button("8 GiB").click();
		await button("leave unplugged").click();
		expect(text(".network-summary")).toBe("debian 13 · unplugged");
		expect(rows().map((row) => row[2])).toEqual(["unplugged", "unplugged"]);
		expect(text(".memory-note")).toBe("1 GiB of memory in total");
		await button("Boot 2 machines").click();
		expect(runs).toEqual([{ line: "spawn 2 debian --mem 512 --disk 8 --no-net", source: "button" }]);
	});
	it("uses the next available identities and ports when adding to a lab", async () => {
		await mountForm(opened(lab(spawn(3), ready())));
		expect(text("h1")).toBe("Add machines");
		expect(rows()).toEqual([
			["node4", "10.88.0.14/24", "port 4"],
			["node5", "10.88.0.15/24", "port 5"],
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
		expect(text(".memory-note")).toBe("256 MiB of memory in total");
	});

	it("goes no higher than the room the lab has left", async () => {
		const { settle } = await mountForm(opened(lab(spawn(5), ready())));
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

	it("goes no higher than the ports machines with several NICs have left, and boots unplugged past them", async () => {
		const three = ["switch0", "switch0", "switch0"] as const;
		const { settle, runs } = await mountForm(opened(lab(spawn(2, ...three), spawn(1), ready())));
		expect(text(".count")).toBe("1");
		await expect.element(button("One more")).toBeDisabled();
		expect(rows()).toEqual([["node4", "10.88.0.14/24", "port 8"]]);
		await customize();
		await button("leave unplugged").click();
		await settle();
		await expect.element(button("One more")).toBeEnabled();
		await button("Boot 1 machine").click();
		expect(runs.map((run) => run.line)).toEqual(["spawn 1 alpine --no-net"]);
	});

	it("counts up to eight in an empty lab", async () => {
		const { settle } = await mountForm();
		for (let i = 0; i < 6; i++) await button("One more").click();
		await settle();
		expect(text(".count")).toBe("8");
		await expect.element(button("One more")).toBeDisabled();
		await customize();
		expect(page.getByText("0 of 8 ports left on switch0 afterwards.").query()).not.toBeNull();
	});
});

describe("<unlab-spawn-form> preview", () => {
	it("shows the bar's refusal and will not boot when the lab is full", async () => {
		await mountForm(opened(lab(spawn(8), ready())));
		expect(text(".count")).toBe("1");
		await expect.element(button("One fewer")).toBeDisabled();
		await expect.element(button("One more")).toBeDisabled();
		await expect.element(button("Boot 1 machine")).toBeDisabled();
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("The lab has no room for another machine, so remove one with rm first. Nothing was changed.");
		expect(rows()).toEqual([]);
	});
});

describe("<unlab-spawn-form> leaving", () => {
	it("returns to an existing lab on Cancel", async () => {
		const { runs, store } = await mountForm(opened(lab(spawn(1), ready())));
		await button("Cancel").click();
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

	it("opens from the rail or header with fresh choices each time", async () => {
		const { settle } = await mountApp({ ...lab(spawn(1), ready()), images: IMAGES });
		expect(document.querySelector("unlab-spawn-form")).toBeNull();
		await page
			.getByRole("complementary", { name: "Machines" })
			.getByRole("button", { name: "Add machines", exact: true })
			.click();
		await settle();
		expect(document.querySelector<HTMLElement>("unlab-app .lab")?.hidden).toBe(true);
		await button("debian 13").click();
		await button("Cancel").click();
		await settle();
		expect(document.querySelector("unlab-spawn-form")).toBeNull();
		await page.getByRole("banner").getByRole("button", { name: "Add machines", exact: true }).click();
		await settle();
		await expect.element(button("alpine 3.24")).toHaveAttribute("aria-pressed", "true");
	});

	it("returns to the lab on Esc", async () => {
		const { store, settle } = await mountApp(opened(lab(spawn(1), ready())));
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
		await customize();
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
