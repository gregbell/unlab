import { compileFilter } from "../../net/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";

export const capture = defineVerb({
	name: "capture",
	about: "filter the packet capture",
	danger: false,
	grammar: { filter: slots.text("filter") },
	plan(a) {
		const compiled = compileFilter(a.filter);
		if (compiled.ok) return { filter: a.filter };
		const said = compiled.error.message.replace(/^Capture /, "capture ");
		return refuse(
			`${said} A term is a protocol, a machine, a NIC (node2:eth1), an address, a MAC or port:N.`,
			"filter",
		);
	},
	describe: (plan) => (plan.filter === "" ? "show every frame in Wire" : `show frames matching ${plan.filter} in Wire`),
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/capture", filter: plan.filter });
		await deps.until((s) => s.view === "wire" && s.capture.filter === plan.filter, ctx.signal);
		const text = plan.filter === "" ? "showing every frame" : `showing frames matching ${plan.filter}`;
		return { kind: "visible", text, data: null };
	},
});
