import "./confirm.ts";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { lab, mount, named, ready, spawn, spawnNamed, tokenColor, unmountAll } from "../base/testing.ts";

afterEach(unmountAll);

const QUESTION = "Remove node3?";
const DETAIL = "Its console closes and everything on its 4 GiB disk is gone. There is no undo.";

function mountConfirm(keys = false) {
	return mount("unlab-confirm", {
		state: lab(spawn(3), ready()),
		prepare: (element) => {
			element.heading = QUESTION;
			element.detail = DETAIL;
			element.actionLabel = "Remove node3";
			element.keys = keys;
		},
	});
}

describe("<unlab-confirm>", () => {
	it("is the yellow-bordered block on --base with the machine in its hue", async () => {
		const { element } = await mountConfirm();
		const block = getComputedStyle(element.querySelector(".block") ?? element);
		expect([block.borderTopColor, block.borderTopWidth, block.borderTopLeftRadius]).toEqual([
			tokenColor("warn"),
			"1px",
			"4px",
		]);
		expect(block.backgroundColor).toBe(tokenColor("base"));
		expect(element.querySelector(".heading")?.textContent).toBe(QUESTION);
		const machine = element.querySelector(".heading .machine");
		expect(machine && getComputedStyle(machine).color).toBe(tokenColor("hue-3"));
		expect(element.querySelector(".detail")?.textContent).toBe(DETAIL);
		expect(page.getByRole("group", { name: QUESTION }).element()).toBeTruthy();
	});

	it("gives each machine its own hue when one name starts with another", async () => {
		const { element } = await mount("unlab-confirm", {
			state: lab(spawnNamed(named("web")), spawnNamed(named("web-1")), ready()),
			prepare: (el) => {
				el.heading = "Remove web-1, web and web-2?";
			},
		});
		const painted = [...element.querySelectorAll<HTMLElement>(".heading .machine")];
		expect(painted.map((span) => [span.textContent, span.dataset.hue])).toEqual([
			["web-1", "2"],
			["web", "1"],
		]);
	});

	it("names the primary button for the action and fires approve or keep", async () => {
		const { element } = await mountConfirm();
		const heard: string[] = [];
		element.addEventListener("unlab-approve", () => heard.push("approve"));
		element.addEventListener("unlab-keep", () => heard.push("keep"));
		await userEvent.click(page.getByRole("button", { name: "Remove node3", exact: true }));
		await userEvent.click(page.getByRole("button", { name: "Keep it", exact: true }));
		expect(heard).toEqual(["approve", "keep"]);
		expect(element.querySelector(".key")).toBeNull();
	});

	it("shows the keys beside the buttons where Enter and Esc answer, outside their names", async () => {
		const { element } = await mountConfirm(true);
		expect([...element.querySelectorAll("button")].map((b) => b.textContent?.replace(/\s+/g, ""))).toEqual([
			"Removenode3↵",
			"Keepitesc",
		]);
		expect(page.getByRole("button", { name: "Remove node3", exact: true }).element()).toBeTruthy();
		const { violations } = await axe.run(element);
		expect(violations).toEqual([]);
	});
});
