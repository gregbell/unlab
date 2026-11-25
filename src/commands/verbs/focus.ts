import { type LabState, type MachineName, machineList, parseSessionId } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";

/** Who gets the keyboard back: the pane holding it, or the one the open bar returns to. */
function holder(lab: LabState): MachineName | null {
	const { keyboard } = lab;
	if (keyboard.kind === "pane") return keyboard.machine;
	return keyboard.kind === "bar" ? keyboard.returnTo : null;
}

type Mode = "plain" | "main" | "max";

export const focus = defineVerb({
	name: "focus",
	about: "move the keyboard to a console",
	danger: false,
	phases: ["booting", "ready", "stopping", "off", "failed"],
	grammar: {
		target: slots.target(),
		mode: slots.exclusive<Mode>("plain", [slots.flag("--main", "main"), slots.flag("--max", "max")]),
	},
	plan(a, lab) {
		const address = parseSessionId(a.target);
		const m = machineList(lab).find((machine) => machine.name === (address?.machine ?? a.target));
		if (!m || m.life.phase === "removing") return refuse(`${a.target} is no longer there to focus.`, "target");
		return { target: a.target, machine: m.name, session: address?.session ?? null, mode: a.mode };
	},
	describe(plan) {
		switch (plan.mode) {
			case "plain":
				return `move the keyboard to ${plan.target}`;
			case "main":
				return `move ${plan.machine} to the front and the keyboard to ${plan.target}`;
			case "max":
				return `maximise ${plan.machine}, or restore it if it is maximised, and move the keyboard to ${plan.target}`;
		}
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/focus", target: plan.target, mode: plan.mode });
		const { machine, session } = plan;
		await deps.until(
			(s) => holder(s) === machine && (session === null || s.machines[machine]?.activeSession === session),
			ctx.signal,
		);
		return { kind: "visible", text: `focused ${plan.target}`, data: null };
	},
});
