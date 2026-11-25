import type { SessionId } from "../../model/index.ts";
import { defineVerb, machineNow, Refusal } from "../define.ts";
import * as slots from "../grammar/slots.ts";

export const sh = defineVerb({
	name: "sh",
	about: "open another shell on a machine",
	description:
		"Open another shell on a machine and move the keyboard to it. It is a session, such as node2:sh1, that exec can name.",
	danger: false,
	grammar: { machine: slots.machine() },
	example: { machine: "node2" },
	plan(a, _lab, ctx) {
		const m = machineNow(a.machine, ctx, "machine");
		if (m instanceof Refusal) return m;
		const session: SessionId = `${m.name}:sh${m.nextShell}`;
		return { machine: m.name, session };
	},
	describe: (plan) => `open ${plan.session}, another shell on ${plan.machine}, and move the keyboard to it`,
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/shell", machine: plan.machine });
		deps.dispatch({ type: "cmd/focus", target: plan.session, mode: "plain" });
		await deps.until((s) => s.sessions[plan.session] !== undefined, ctx.signal);
		return { kind: "visible", text: `opened ${plan.session}`, data: { session: plan.session } };
	},
});
