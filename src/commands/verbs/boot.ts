import { isPlanError, planBootAgain } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { imageLabel, planErrorSentence } from "./words.ts";

/** Boot again: same name, hue, image and memory, on the lowest free port. In the bar and on the button; no agent tool. */
export const boot = defineVerb({
	name: "boot",
	about: "boot a failed machine again",
	danger: false,
	phases: ["failed"],
	grammar: { machine: slots.machine() },
	plan(a, lab) {
		const m = lab.machines[a.machine];
		const plan = planBootAgain(lab, a.machine);
		if (!m || plan === null) return refuse(`${a.machine} has not failed, so it has nothing to boot again.`, "machine");
		if (isPlanError(plan)) return refuse(planErrorSentence(plan), "machine");
		return { ...plan, attempt: m.life.attempt, spec: m.spec };
	},
	describe(plan, lab) {
		const where = plan.port === null ? "unplugged" : `plugged into switch0 on port ${plan.port}`;
		const { image, memMiB } = plan.spec;
		return [`boot ${plan.machine} again`, imageLabel(lab, image), `${memMiB} MiB`, where].join(" · ");
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/boot-again", machine: plan.machine, port: plan.port, at: deps.now() });
		await deps.until((s) => (s.machines[plan.machine]?.life.attempt ?? 0) > plan.attempt, ctx.signal);
		return { kind: "visible", text: `booting ${plan.machine} again`, data: null };
	},
});
