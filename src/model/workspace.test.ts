import { expect, test } from "vitest";
import { emptyLab, IMAGES, labWith, run, WIDE } from "./testkit.ts";
import { initialState } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

test("the agent's policies and pause come back, and what the last browser made of the tools does not", () => {
	const s = run(
		labWith(1),
		{ type: "ui/policy", tool: "link_set", policy: "off" },
		{ type: "ui/tools-paused", paused: true },
	);
	expect(s.agent.webmcp).toEqual(emptyLab().agent.webmcp);
	const { state } = restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));
	expect(state.agent.policies.link_set).toBe("off");
	expect(state.agent.paused).toBe(true);
	expect(state.agent.webmcp).toEqual({ kind: "absent" });
});
