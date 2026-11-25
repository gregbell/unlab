import { selectNames } from "../../model/index.ts";
import { compileFilter } from "../../net/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";

export const capture = defineVerb({
	name: "capture",
	about: "filter the packet capture",
	description: "Maximise the capture on the frames that match a filter. An agent reads them with capture_read.",
	danger: false,
	grammar: { filter: slots.frameFilter() },
	example: { filter: "arp or node2" },
	plan(a, lab) {
		const compiled = compileFilter(a.filter, selectNames(lab));
		if (compiled.ok) return { filter: a.filter };
		return refuse(compiled.error.message.replace(/^Capture /, "capture "), "filter");
	},
	describe: (plan) =>
		plan.filter === "" ? "show every captured frame" : `show captured frames matching ${plan.filter}`,
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/capture", filter: plan.filter });
		await deps.until((s) => s.capture.filter === plan.filter, ctx.signal);
		const text = plan.filter === "" ? "showing every frame" : `showing frames matching ${plan.filter}`;
		return { kind: "visible", text, data: null };
	},
});
