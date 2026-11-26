import { describe, expect, test } from "vitest";
import { arpRequest, NAMES, ping } from "../../test/support/frames.ts";
import { type PortRef, parseSwitchName, type SwitchName } from "../model/index.ts";
import { compileFilter } from "../net/index.ts";
import { createCaptureLog } from "./log.ts";

const lan = parseSwitchName("lan") as SwitchName;
const wan = parseSwitchName("wan") as SwitchName;
const BOOK = { ...NAMES, switches: new Set(["switch0", "lan", "wan"]) };
const cable: readonly [PortRef, PortRef] = [
	{ switch: lan, port: 8 },
	{ switch: wan, port: 7 },
];

function log(several = true) {
	let now = 0;
	const made = createCaptureLog({
		schedule: (fn) => fn(),
		now: () => now,
		names: () => BOOK,
		rowNames: { switchLabel: (on) => (several ? on : null) },
	});
	return {
		made,
		at(ms: number) {
			now = ms;
		},
		filtered(source: string) {
			const compiled = compileFilter(source, BOOK);
			if (!compiled.ok) throw new Error(compiled.error.message);
			made.setFilter(compiled.filter);
			return made.tail(100).map((row) => (row.kind === "frame" ? `frame ${row.switch}` : row.text));
		},
	};
}

describe("the rows of a cable between switches", () => {
	test("name both its ends, and say what was done to it and by whom", () => {
		const { made, at } = log();
		at(1500);
		made.appendCable({ ends: cable, up: true, cause: "bar", plug: true });
		made.appendCable({ ends: cable, up: false, cause: "agent" });
		made.appendCable({ ends: cable, up: true, cause: "cli" });
		made.appendCable({ ends: cable, up: false, cause: "button", plug: true });
		made.appendCable({ ends: cable, up: true, cause: "runtime", plug: true });
		made.appendCable({ ends: cable, up: false, cause: "bar", plug: true, cut: true });
		expect(made.tail(6)).toEqual([
			{
				kind: "cable",
				seq: 1,
				time: "1.50",
				ends: cable,
				up: true,
				text: "lan port 8 and wan port 7 link up",
				cause: "Cable between them plugged in by you.",
			},
			expect.objectContaining({
				up: false,
				text: "lan port 8 and wan port 7 link down",
				cause: "Cable between them cut by the agent.",
			}),
			expect.objectContaining({ up: true, cause: "Cable between them reconnected by the CLI." }),
			expect.objectContaining({ up: false, cause: "Cable between them unplugged by you." }),
			expect.objectContaining({ up: true, cause: "Cable between them plugged in by the lab." }),
			expect.objectContaining({ up: false, cause: "Cut cable between them unplugged by you." }),
		]);
	});

	test("name the ports alone in a lab of one switch", () => {
		const { made } = log(false);
		made.appendCable({
			ends: [
				{ switch: "switch0", port: 7 },
				{ switch: "switch0", port: 8 },
			],
			up: true,
			cause: "bar",
			plug: true,
		});
		expect(made.tail(1)).toMatchObject([{ text: "port 7 and port 8 link up" }]);
	});

	test("are kept by a filter that names either end, its switch or its port's number, and by one that names a protocol", () => {
		const t = log();
		t.made.appendCable({ ends: cable, up: false, cause: "bar" });
		const down = "lan port 8 and wan port 7 link down";
		for (const filter of ["", "lan", "wan", "lan:8", "wan:7", "port:8", "port:7", "arp", "lan:8 arp", "icmp or wan"]) {
			expect(t.filtered(filter), filter).toEqual([down]);
		}
		for (const filter of ["switch0", "lan:7", "wan:8", "port:1", "node1", "node1:eth0", "10.88.0.11", "lan node1"]) {
			expect(t.filtered(filter), filter).toEqual([]);
		}
	});
});

describe("the rows of a storm", () => {
	test("say when it began and what it came to", () => {
		const { made, at } = log();
		at(2000);
		made.appendStorm({ switch: lan, over: false, looped: 0, dropped: 0, ms: 0 });
		at(10_250);
		made.appendStorm({ switch: lan, over: true, looped: 16_400, dropped: 0, ms: 8250 });
		made.appendStorm({ switch: wan, over: true, looped: 24_000, dropped: 9312, ms: 8249 });
		expect(made.tail(3)).toEqual([
			{
				kind: "storm",
				seq: 1,
				time: "2.00",
				switch: "lan",
				over: false,
				text: "lan is storming",
				cause: "Frames that go round a loop of cables keep coming into it, until a cable of the loop is cut.",
			},
			{
				kind: "storm",
				seq: 2,
				time: "10.25",
				switch: "lan",
				over: true,
				text: "lan storm over",
				cause: "It took 16400 looped frames in 8.3 s. It has forgotten its MAC table.",
			},
			expect.objectContaining({
				cause:
					"It took 24000 looped frames in 8.2 s, and did not send on 9312 more that the lab had no room for. It has forgotten its MAC table.",
			}),
		]);
	});

	test("are kept by a filter that names the switch, and not by one that names another or a machine", () => {
		const t = log();
		t.made.appendStorm({ switch: lan, over: false, looped: 0, dropped: 0, ms: 0 });
		for (const filter of ["", "lan", "arp", "lan arp"]) expect(t.filtered(filter), filter).toEqual(["lan is storming"]);
		for (const filter of ["wan", "lan:8", "port:8", "node1"]) expect(t.filtered(filter), filter).toEqual([]);
	});
});

describe("a frame that has looped", () => {
	test("says so in its row, before what the switch did with it, and one that has not says nothing of it", () => {
		const { made } = log();
		made.appendFrame({ switch: lan, from: 8, to: 0b1000001, flood: "group", frame: arpRequest(1, 9), looped: true });
		made.appendFrame({ switch: lan, from: 8, to: 0b1, flood: null, frame: ping(1, 2), looped: true });
		made.appendFrame({ switch: lan, from: 1, to: 0b10000000, flood: "group", frame: arpRequest(1, 9) });
		const [flooded, forwarded, first] = made.tail(3);
		expect(flooded).toMatchObject({ looped: true, note: "looped · flooded to lan ports 1 and 7" });
		expect(forwarded).toMatchObject({ looped: true, note: "looped" });
		expect(first).toMatchObject({ note: "flooded to lan port 8" });
		expect(first).not.toHaveProperty("looped");
	});
});
