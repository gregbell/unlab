import type { SessionId } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";

export const sh = defineVerb({
	name: "sh",
	about: "open another shell on a machine",
	danger: false,
	grammar: { machine: slots.machine() },
	plan(a, lab) {
		const m = lab.machines[a.machine];
		if (m?.life.phase !== "ready") return refuse(`${a.machine} is no longer ready.`, "machine");
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
