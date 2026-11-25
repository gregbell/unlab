import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";

const filter = slots.frameFilter();

export const capture = defineVerb({
	name: "capture",
	about: "filter the packet capture",
	description:
		"Maximise the capture on the frames that match a filter. lan is what that switch carried, lan:3 is what crossed the cable in its port 3, and port:3 is that port of every switch. A machine or a NIC is matched wherever its frames went. With a switch or a cable in the filter, save .pcap saves only the frames shown. An agent reads them with capture_read.",
	danger: false,
	grammar: { filter },
	example: { filter: "arp or node2" },
	plan(a, _lab, ctx) {
		const fault = filter.check?.(a.filter, ctx);
		return fault ? refuse(fault.message, "filter") : { filter: a.filter };
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
