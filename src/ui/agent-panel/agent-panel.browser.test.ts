import "./agent-panel.ts";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { AgentCall, AgentEvent, LabEvent } from "../../model/index.ts";
import { lab, mount, ready, spawn, tick, tokenColor, unmountAll, webmcp } from "../base/testing.ts";

afterEach(() => {
	unmountAll();
	vi.restoreAllMocks();
});

function called(id: number, fields: Partial<AgentCall> & Pick<AgentCall, "tool" | "line" | "status">): AgentEvent {
	return { type: "agent/call", call: { id, preview: null, actionLabel: null, result: null, at: 0, ...fields } };
}

const ACTIVE: readonly LabEvent[] = [
	called(1, { tool: "machines_list", line: "ls", status: "done", result: "3 machines · 3 ready" }),
	called(2, { tool: "shell_exec", line: "exec node2 -- cat /tmp/in", status: "done", result: "exit 0 · hello" }),
	called(3, { tool: "link_set", line: "link down node3", status: "done", result: "node3 cut" }),
	tick(4 * 60_000 + 5_000),
];

const WAITING: LabEvent = called(4, {
	tool: "machines_remove",
	line: "rm node3",
	status: "waiting",
	preview: "Its console closes and everything on its 4 GiB disk is gone. There is no undo.",
	actionLabel: "Remove node3",
});

const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("<unlab-agent-panel>", () => {
	it("before any call: every tool with its arguments and policy, and no log", async () => {
		const { element } = await mount("unlab-agent-panel", { state: lab(spawn(3), ready()) });
		expect(text(element.querySelector(".head"))).toBe("webmcp pause tools");
		expect(text(element.querySelector(".about"))).toBe(
			"An agent in this browser gets the same verbs as the command bar. You decide which ones run without asking. To start, connect an agent.",
		);
		await expect
			.element(page.getByRole("link", { name: "connect an agent" }))
			.toHaveAttribute("href", "https://github.com/gregbell/unlab#use-the-lab-with-an-ai-agent");
		const rows = [...element.querySelectorAll(".tool .name")].map(text);
		expect(rows).toEqual([
			"lab_help(verb)",
			"machines_list()",
			"machines_spawn(count, image, mem, cpus, disk, extraDisk, name, nics, net, addr, gateway)",
			"machines_boot(names)",
			"machines_reboot(names)",
			"machines_poweroff(names)",
			"machines_remove(names)",
			"checkpoint_save(machine, checkpoint)",
			"checkpoint_restore(machine, checkpoint)",
			"checkpoint_remove(machine, checkpoint)",
			"shell_exec(targets, command)",
			"shell_read(machine, lines)",
			"file_write(machine, path, owner, mode, text)",
			"link_set(link, machines)",
			"capture_read(filter, limit)",
		]);
		const spawnPolicy = page.getByRole("combobox", { name: "Policy for machines_spawn" }).element();
		expect(spawnPolicy instanceof HTMLSelectElement && spawnPolicy.selectedOptions[0]?.textContent).toBe("ask me");
		expect(text(element.querySelector(".calls-head span:last-child"))).toBe("none yet");
		expect(element.querySelector(".log")).toBeNull();
		expect(element.querySelector("unlab-confirm")).toBeNull();
		const tool = element.querySelector(".tool");
		expect(tool && getComputedStyle(tool).minHeight).toBe("30px");
		const head = element.querySelector(".head");
		expect(head && getComputedStyle(head).minHeight).toBe("34px");
	});

	it("active: the state in --agent, when the first call came, and the log oldest first with names in hues", async () => {
		const { element } = await mount("unlab-agent-panel", { state: lab(spawn(3), ready(), ...ACTIVE) });
		const state = element.querySelector(".state");
		expect(text(state)).toBe("agent active");
		expect(state && getComputedStyle(state).color).toBe(tokenColor("agent"));
		expect(text(element.querySelector(".since"))).toBe("first call 4 min ago");
		expect(text(element.querySelector(".calls-head span:last-child"))).toBe("3 run");
		const calls = [...element.querySelectorAll(".call")].map((call) =>
			[".n", ".line", ".result"].map((part) => text(call.querySelector(part))),
		);
		expect(calls).toEqual([
			["1", "ls", "→ 3 machines · 3 ready"],
			["2", "exec node2 -- cat /tmp/in", "→ exit 0 · hello"],
			["3", "link down node3", "→ node3 cut"],
		]);
		const node2 = element.querySelector(".call .machine");
		expect(node2 && getComputedStyle(node2).color).toBe(tokenColor("hue-2"));
		const result = element.querySelector(".call .result");
		expect(result && getComputedStyle(result).color).toBe(tokenColor("text-2"));
	});

	it("changes a policy through the store, and an off tool's row turns --text-3", async () => {
		const { element, store, settle } = await mount("unlab-agent-panel", { state: lab(spawn(1), ready()) });
		await userEvent.selectOptions(page.getByRole("combobox", { name: "Policy for link_set" }), "off");
		await settle();
		expect(store.state.agent.policies.link_set).toBe("off");
		const rows = [...element.querySelectorAll(".tool")];
		const off = rows.find((row) => text(row).startsWith("link_set"))?.querySelector(".name");
		const on = rows.find((row) => text(row).startsWith("machines_list"))?.querySelector(".name");
		expect(off && getComputedStyle(off).color).toBe(tokenColor("text-3"));
		expect(on && getComputedStyle(on).color).toBe(tokenColor("text"));
	});

	it("paused: every row in --text-3, the button reads resume tools, and pressing it resumes", async () => {
		const { element, store, settle } = await mount("unlab-agent-panel", {
			state: lab(spawn(1), ready(), ...ACTIVE, { type: "ui/tools-paused", paused: true }),
		});
		expect(text(element.querySelector(".state"))).toBe("tools paused");
		expect(text(element.querySelector(".about"))).toContain("Tools are paused");
		for (const name of element.querySelectorAll(".tool .name")) {
			expect(getComputedStyle(name).color).toBe(tokenColor("text-3"));
		}
		await userEvent.click(page.getByRole("button", { name: "resume tools" }));
		await settle();
		expect(store.state.agent.paused).toBe(false);
		expect(page.getByRole("button", { name: "pause tools" }).element()).toBeTruthy();
	});

	it("calls waiting: an approval block pinned to the bottom, named for the action, answered only by its buttons", async () => {
		const { element, answers, settle } = await mount("unlab-agent-panel", {
			state: lab(spawn(3), ready(), ...ACTIVE, WAITING),
		});
		expect(text(element.querySelector(".calls-head span:last-child"))).toBe("3 run · 1 waiting");
		expect(element.querySelectorAll(".call")).toHaveLength(3);
		const block = element.querySelector("unlab-confirm");
		expect(text(block?.querySelector(".note") ?? null)).toBe("4 · waiting for you");
		const note = block?.querySelector(".note");
		expect(note && getComputedStyle(note).color).toBe(tokenColor("warn"));
		expect(text(block?.querySelector(".heading") ?? null)).toBe("rm node3");
		expect(text(block?.querySelector(".detail") ?? null)).toContain("There is no undo.");

		const panel = element.getBoundingClientRect();
		const approvals = element.querySelector(".approvals")?.getBoundingClientRect();
		const bottom = Math.min(panel.bottom, window.innerHeight);
		expect(approvals && bottom - approvals.bottom).toBeLessThanOrEqual(14.5);

		await userEvent.keyboard("{Enter}");
		await settle();
		expect(answers).toEqual([]);

		const remove = page.getByRole("button", { name: "Remove node3", exact: true });
		const button = remove.element();
		await expect.poll(() => button instanceof HTMLButtonElement && !button.disabled, { timeout: 2_000 }).toBe(true);
		if (button instanceof HTMLElement) button.focus();
		await userEvent.keyboard("{Enter}");
		expect(answers).toEqual([{ call: 4, allow: true }]);
		await userEvent.click(page.getByRole("button", { name: "Deny", exact: true }));
		expect(answers).toEqual([
			{ call: 4, allow: true },
			{ call: 4, allow: false },
		]);
		const { violations } = await axe.run(element);
		expect(violations).toEqual([]);
	});

	it("disarms every approve button for a moment whenever the waiting calls change", async () => {
		const { store, settle } = await mount("unlab-agent-panel", { state: lab(spawn(3), ready(), ...ACTIVE, WAITING) });
		const approve = () => {
			const button = page.getByRole("button", { name: "Remove node3", exact: true }).element();
			if (!(button instanceof HTMLButtonElement)) throw new Error("no approve button");
			return button;
		};
		expect(approve().disabled, "a block that just appeared is not armed").toBe(true);
		await expect.poll(() => approve().disabled, { timeout: 2_000 }).toBe(false);

		store.dispatchAgent(
			called(5, { tool: "machines_spawn", line: "spawn 1 alpine", status: "waiting", actionLabel: "Boot node4" }),
		);
		await settle();
		expect(approve().disabled, "a new call shifts the stack, so every block re-arms").toBe(true);
		const deny = page.getByRole("button", { name: "Deny", exact: true }).first().element();
		expect(deny instanceof HTMLButtonElement && deny.disabled).toBe(false);
		await expect.poll(() => approve().disabled, { timeout: 2_000 }).toBe(false);
	});

	it("stacks waiting calls oldest first", async () => {
		const { element } = await mount("unlab-agent-panel", {
			state: lab(
				spawn(3),
				ready(),
				WAITING,
				called(5, {
					tool: "machines_remove",
					line: "rm node1",
					status: "waiting",
					preview: "x",
					actionLabel: "Remove node1",
				}),
			),
		});
		expect([...element.querySelectorAll("unlab-confirm .note")].map(text)).toEqual([
			"4 · waiting for you",
			"5 · waiting for you",
		]);
	});

	it("without WebMCP: how to turn it on, with the flag's address to select or copy", async () => {
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		const { element, settle } = await mount("unlab-agent-panel", {
			state: lab(webmcp({ kind: "absent" })),
			tryCall: async () => {},
		});
		expect(text(element.querySelector(".about"))).toBe(
			"This tab has no WebMCP, so no agent can call these yet. In Chrome or Edge 150 or later, open chrome://flags/#enable-webmcp-testing, choose Enabled and relaunch. Or let an agent open the lab in its own Chrome: connect an agent.",
		);
		expect(element.querySelectorAll(".tool")).toHaveLength(15);
		expect(page.getByRole("button", { name: "try a call" }).elements()).toEqual([]);

		const copy = page.getByRole("button", { name: "copy address" }).element();
		if (copy instanceof HTMLElement) copy.focus();
		await userEvent.keyboard("{Enter}");
		await settle();
		expect(writeText).toHaveBeenCalledWith("chrome://flags/#enable-webmcp-testing");
		await expect.element(page.getByRole("status")).toHaveTextContent("Copied.");
		expect((await axe.run(element)).violations).toEqual([]);

		writeText.mockRejectedValue(new Error("no permission"));
		await userEvent.keyboard("{Enter}");
		await expect
			.element(page.getByRole("status"))
			.toHaveTextContent("Not copied. Select the address to copy it yourself.");
	});

	it("refused: the browser's own message, paused or not, and no call to try", async () => {
		const { element } = await mount("unlab-agent-panel", {
			state: lab(webmcp({ kind: "refused", message: "Tools are not allowed in this frame." }), {
				type: "ui/tools-paused",
				paused: true,
			}),
			tryCall: async () => {},
		});
		expect(text(element.querySelector(".about"))).toBe(
			"This browser refused the tools, so an agent may not be able to call them. It said: Tools are not allowed in this frame.",
		);
		expect(page.getByRole("button", { name: "try a call" }).elements()).toEqual([]);
		expect((await axe.run(element)).violations).toEqual([]);
	});

	it("offers a call to try until one is made, and hands the keyboard on to the log", async () => {
		const { element, store, settle } = await mount("unlab-agent-panel", {
			state: lab(),
			tryCall: async (): Promise<void> =>
				store.dispatchAgent(called(1, { tool: "machines_list", line: "ls", status: "done" })),
		});
		const attempt = page.getByRole("button", { name: "try a call" });
		expect((await axe.run(element)).violations).toEqual([]);

		store.dispatchUi({ type: "ui/tools-paused", paused: true });
		await settle();
		await expect.element(attempt).toBeDisabled();
		store.dispatchUi({ type: "ui/tools-paused", paused: false });
		store.dispatchUi({ type: "ui/policy", tool: "machines_list", policy: "off" });
		await settle();
		await expect.element(attempt).toBeDisabled();
		store.dispatchUi({ type: "ui/policy", tool: "machines_list", policy: "run" });
		await settle();

		const button = attempt.element();
		if (button instanceof HTMLElement) button.focus();
		await userEvent.keyboard("{Enter}");
		await expect.poll(() => element.querySelectorAll(".call").length).toBe(1);
		expect(attempt.elements()).toEqual([]);
		expect(page.getByRole("link", { name: "connect an agent" }).elements()).toEqual([]);
		expect(document.activeElement).toBe(element.querySelector(".calls-head"));
	});

	it("says why a tried call did not go through, and leaves it to try again", async () => {
		const { element } = await mount("unlab-agent-panel", {
			state: lab(),
			tryCall: () => Promise.reject(new Error("The browser does not list machines_list.")),
		});
		await userEvent.click(page.getByRole("button", { name: "try a call" }));
		await expect
			.element(page.getByRole("status"))
			.toHaveTextContent("The call did not go through. The browser does not list machines_list.");
		await expect.element(page.getByRole("button", { name: "try a call" })).toBeEnabled();
		expect((await axe.run(element)).violations).toEqual([]);
	});

	it("offers no call where a page cannot make one", async () => {
		await mount("unlab-agent-panel", { state: lab() });
		expect(page.getByRole("button", { name: "try a call" }).elements()).toEqual([]);
	});
});
