import { expect, test } from "vitest";
import { arpReply, arpRequest, ping } from "../../test/support/frames.ts";
import { port0 } from "../../test/support/ports.ts";
import { createCaptureLog } from "../capture/index.ts";
import { LabSwitch } from "./switch.ts";

test("a cut, as capture shows it: the event row, then frames to the cut machine flooded as unknown", () => {
	let clock = 0;
	const sw = new LabSwitch({ now: () => clock });
	const capture = createCaptureLog({ now: () => clock, schedule: () => {} });
	sw.onTap((e) => capture.appendFrame({ switch: "switch0", ...e }));
	for (const p of [1, 2, 3] as const) sw.attach(p, { deliver: () => {} });

	sw.receive(1, arpRequest(1, 2));
	sw.receive(2, arpReply(2, 1));
	clock = 4210;
	sw.setLink(2, false);
	capture.appendLink({ port: port0(2), machine: "node2", nic: 0, up: false, cause: "agent" });
	clock = 4500;
	sw.receive(1, ping(1, 2));

	const [request, reply, cut, lost] = capture.tail(4);
	expect(request).toMatchObject({ proto: "ARP", to: { kind: "everyone" }, note: "flooded to ports 2 and 3" });
	expect(reply).toMatchObject({ proto: "ARP", to: { kind: "machine", name: "node1" }, note: null });
	expect(cut).toEqual({
		kind: "link",
		seq: 3,
		time: "4.21",
		port: 2,
		up: false,
		text: "port 2 link down",
		cause: "Cable to node2 cut by the agent.",
	});
	expect(lost).toMatchObject({ time: "4.50", proto: "ICMP", note: "unknown destination, flooded to port 3" });
	expect(sw.macTable().find((e) => e.port === 2)).toMatchObject({ mac: "52:54:00:88:00:0c", flushed: true });
});
