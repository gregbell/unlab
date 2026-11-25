import "../app/app.ts";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { CliLink } from "../../model/index.ts";
import { agentCall, lab, mount, ready, spawn, tokenColor, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(unmountAll);

const mountApp = (cli: CliLink = { kind: "off" }) =>
	mount("unlab-app", {
		state: lab(spawn(1), ready(), { type: "cli/link", cli }),
		prepare: (element, services) => {
			element.services = services;
		},
	});

const opener = page.getByRole("contentinfo").getByRole("button", { name: /^cli:/ });
const dialog = page.getByRole("dialog", { name: "Reach the lab from your terminal" });

describe("<unlab-cli-link>", () => {
	it.each([
		[{ kind: "off" }, "cli: off", "The link is off.", "Turn the link on", "text-2"],
		[{ kind: "waiting" }, "cli: waiting", "Waiting for the CLI.", "Turn the link off", "text-2"],
		[{ kind: "blocked" }, "cli: blocked", "Select the icon left of the address", "Turn the link off", "warn"],
		[{ kind: "refused", message: "Reload the lab." }, "cli: refused", "Reload the lab.", "Turn the link off", "warn"],
		[{ kind: "linked" }, "cli: linked", "Linked to the CLI", "Turn the link off", "text-2"],
	] as const)("%j shows as %s, and opens what to do about it", async (cli, text, says, action, colour) => {
		const { element } = await mountApp(cli);
		await expect.element(opener).toHaveTextContent(text);
		expect(getComputedStyle(opener.element()).color).toBe(tokenColor(colour));
		await opener.click();
		await expect.element(dialog.getByRole("button", { name: action })).toBeVisible();
		for (const text of [says, "npx unlab.run"]) expect(dialog.element().textContent).toContain(text);
		const { violations } = await axe.run(element);
		expect(violations.map(({ id, nodes }) => [id, nodes.map((node) => node.failureSummary)])).toEqual([]);
	});

	it("turns the link on and off by keyboard, and closes with Escape", async () => {
		const { links, store, settle } = await mountApp();
		(opener.element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(dialog).toBeVisible();
		(dialog.getByRole("button", { name: "Turn the link on" }).element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");
		expect(links).toEqual([true]);
		store.dispatchLink({ type: "cli/link", cli: { kind: "linked" } });
		await settle();
		await userEvent.keyboard("{Enter}");
		expect(links).toEqual([true, false]);
		await userEvent.keyboard("{Escape}");
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("gets out of the way of a call that waits for a yes", async () => {
		const { store, settle } = await mountApp();
		await opener.click();
		await expect.element(dialog).toBeVisible();
		store.dispatchAgent(agentCall(1, "waiting"));
		await settle();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});
