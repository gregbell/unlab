import { describe, expect, test } from "vitest";
import {
	machineLink,
	selectAgentIndicator,
	selectBarHistory,
	selectCliSegment,
	selectNames,
	selectPorts,
	selectRecent,
	selectSubnets,
} from "./selectors.ts";
import {
	agentCall,
	emptyLab,
	hasFailed,
	hasStopped,
	isReady,
	labWith,
	linkEvent,
	logged,
	machine,
	power,
	remove,
	run,
	spawnEvent,
	switchNamed,
	withSwitches,
} from "./testkit.ts";
import { AGENT_IDLE_MS, type LabEvent, type LabState, type MachineName, type SwitchName } from "./types.ts";

const tick = (now: number): LabEvent => ({ type: "tick", now });
const shell = (machine: MachineName): LabEvent => ({ type: "cmd/shell", machine });

describe("chosen addresses", () => {
	let s = emptyLab();
	s = run(s, spawnEvent(s, 1, { net: ["switch0", "switch0"], addr: ["10.1.0.1/16", null], gateway: false }));
	s = run(s, spawnEvent(s, 1, { addr: [null] }), isReady("node1"), isReady("node2"));

	test("name the switch's subnet, and how many once there are several", () => {
		expect(selectSubnets("switch0")(emptyLab())).toBe("10.88.0.0/24");
		expect(selectSubnets("switch0")(labWith(2))).toBe("10.88.0.0/24");
		expect(selectSubnets("switch0")(s)).toBe("10.1.0.0/16");
		expect(selectSubnets("switch0")(run(s, spawnEvent(s, 1)))).toBe("2 subnets");
	});
});

/** node1 up, node2 cut, node3 unplugged, node4 booting for 1.4 s, node5 failed, node6 removing. */
function oneOfEach(): LabState {
	let s = emptyLab();
	s = run(s, spawnEvent(s, 2));
	s = run(s, spawnEvent(s, 1, { net: "none" }), isReady("node1"), isReady("node2"), isReady("node3"));
	s = run(s, linkEvent(s, false, "node2"));
	s = run(s, tick(10_000));
	s = run(s, spawnEvent(s, 3, { at: 10_000 }));
	s = run(s, hasFailed("node5"), isReady("node6"), remove("node6"));
	return run(s, tick(11_400));
}

describe("machines that stop", () => {
	/** node1 powering off, node2 rebooting, node3 off, node4 off with its cable cut. */
	const stopping = () => {
		let s = labWith(4);
		s = run(s, linkEvent(s, false, "node4"));
		s = run(s, power("off", "node3", "node4"), hasStopped("node3"), hasStopped("node4"));
		return run(s, power("off", "node1"), power("reboot", "node2"));
	};

	test("say so on their ports, and an off machine's cable can be cut or plugged in", () => {
		expect(selectPorts("switch0")(stopping()).map((p) => [p.state, p.word, p.actionLabel])).toEqual([
			["stopping", "stop", null],
			["stopping", "stop", null],
			["off", "off", "Cut the cable from node3 to port 3"],
			["cut", "cut", "Reconnect the cable from node4 to port 4"],
			["empty", null, null],
			["empty", null, null],
			["empty", null, null],
			["empty", null, null],
		]);
	});

	test("a NIC that is gone from a running guest is marked until it reboots", () => {
		let s = labWith(1);
		s = run(s, { type: "vm/nic-lost", machine: "node1", attempt: 1, nic: 0, reason: "eth0 stopped: signal 9." });
		expect(machine(s, "node1").life).toMatchObject({ phase: "ready", lost: [0] });
		s = run(s, power("reboot", "node1"), hasStopped("node1"), isReady("node1", 2));
		expect(machine(s, "node1").life).not.toHaveProperty("lost");
	});
});

describe("the switch faceplate", () => {
	test("has eight ports, each in the state the handoff draws", () => {
		expect(selectPorts("switch0")(oneOfEach())).toEqual([
			{
				port: 1,
				state: "up",
				machine: { n: 1, name: "node1", hue: 1, label: "node1", nic: null },
				word: "up",
				actionLabel: "Cut the cable from node1 to port 1",
			},
			{
				port: 2,
				state: "cut",
				machine: { n: 2, name: "node2", hue: 2, label: "node2", nic: null },
				word: "cut",
				actionLabel: "Reconnect the cable from node2 to port 2",
			},
			{
				port: 3,
				state: "booting",
				machine: { n: 4, name: "node4", hue: 4, label: "node4", nic: null },
				word: "boot",
				actionLabel: null,
			},
			{ port: 4, state: "empty", machine: null, word: null, actionLabel: null },
			{
				port: 5,
				state: "removing",
				machine: { n: 6, name: "node6", hue: 6, label: "node6", nic: null },
				word: "down",
				actionLabel: null,
			},
			{ port: 6, state: "empty", machine: null, word: null, actionLabel: null },
			{ port: 7, state: "empty", machine: null, word: null, actionLabel: null },
			{ port: 8, state: "empty", machine: null, word: null, actionLabel: null },
		]);
	});
});

describe("a machine with several NICs", () => {
	/** node1 with eth0 on port 1, eth1 on port 2, and eth2 unplugged. */
	const three = () => {
		const s = emptyLab();
		return run(s, spawnEvent(s, 1, { net: ["switch0", "switch0", "none"] }), isReady("node1"));
	};

	test("each cable is its own port on the faceplate", () => {
		const s = run(three(), linkEvent(three(), false, { machine: "node1", nic: 1 }));
		const holder = (nic: string) => ({ n: 1, name: "node1", hue: 1, label: `node1:${nic}`, nic });
		expect(selectPorts("switch0")(s).slice(0, 3)).toEqual([
			{
				port: 1,
				state: "up",
				machine: holder("eth0"),
				word: "up",
				actionLabel: "Cut the cable from node1:eth0 to port 1",
			},
			{
				port: 2,
				state: "cut",
				machine: holder("eth1"),
				word: "cut",
				actionLabel: "Reconnect the cable from node1:eth1 to port 2",
			},
			{ port: 3, state: "empty", machine: null, word: null, actionLabel: null },
		]);
	});

	test("its link is cut while any cable is, up while any is up, and unplugged when none is there", () => {
		const word = (s: LabState) => machineLink(machine(s, "node1"));
		const s = three();
		expect(word(s)).toBe("up");
		expect(word(run(s, linkEvent(s, false, { machine: "node1", nic: 1 })))).toBe("cut");
		const loose = emptyLab();
		expect(word(run(loose, spawnEvent(loose, 1, { net: ["none", "none"] }), isReady("node1")))).toBe("unplugged");
	});

	test("keeps its cables apart while it is being removed", () => {
		const s = run(three(), remove("node1"));
		expect(selectPorts("switch0")(s)[1]).toMatchObject({
			state: "removing",
			machine: { label: "node1:eth1" },
			word: "down",
		});
	});
});

describe("the CLI's segment", () => {
	/** Three ready, one booting unplugged; one cut cable; a shell open on node2; an agent call just made. */
	function busy(): LabState {
		let s = labWith(3);
		s = run(s, linkEvent(s, false, "node3"), shell("node2"), { type: "session/opened", session: "node2:sh1" });
		s = run(s, spawnEvent(s, 1, { net: "none" }));
		return run(s, { type: "agent/call", call: agentCall(1, s.now) });
	}

	test("an agent that calls through the CLI is said on the CLI's segment while it is active", () => {
		let s = run(busy(), { type: "cli/link", cli: { kind: "linked" } });
		expect(selectCliSegment(s).text).toBe("cli: linked");
		s = run(s, { type: "agent/call", call: agentCall(9, s.now, { via: "cli" }) });
		expect(selectCliSegment(s).text).toBe("cli: linked, agent active");
		expect(selectCliSegment(s)).toBe(selectCliSegment(s));
		s = run(s, tick(s.now + AGENT_IDLE_MS));
		expect(selectCliSegment(s).text).toBe("cli: linked");
		s = run(s, { type: "agent/call", call: agentCall(10, s.now, { via: "webmcp" }) });
		expect(selectCliSegment(s).text).toBe("cli: linked");
	});
});

describe("the agent indicator", () => {
	test("reads no agent calls yet until the first tool call", () => {
		expect(selectAgentIndicator(run(emptyLab(), tick(900_000)))).toBe("no agent calls yet");
	});

	test("then agent active until five minutes pass without a call", () => {
		let s = run(emptyLab(), { type: "agent/call", call: agentCall(1, 1000) });
		expect(selectAgentIndicator(s)).toBe("agent active");
		s = run(s, tick(1000 + AGENT_IDLE_MS - 1));
		expect(selectAgentIndicator(s)).toBe("agent active");
		s = run(s, tick(1000 + AGENT_IDLE_MS));
		expect(selectAgentIndicator(s)).toBe("agent idle");
		s = run(s, { type: "agent/call", call: agentCall(2, s.now + 5) });
		expect(selectAgentIndicator(s)).toBe("agent active");
	});
});

describe("recent and history", () => {
	const s = run(
		emptyLab(),
		logged("spawn 3 alpine --net switch0", "bar", 1),
		logged("focus node2", "button", 2),
		logged("exec node1 -- ping -c 2 -W 1 10.88.0.13", "agent", 3),
		logged("ls", "bar", 4),
		logged("focus node1", "button", 5),
		logged("link down node3", "bar", 6),
	);

	test("recent is the last three lines run from the bar or by the agent, newest first", () => {
		expect(selectRecent(s).map((entry) => [entry.line, entry.source])).toEqual([
			["link down node3", "bar"],
			["ls", "bar"],
			["exec node1 -- ping -c 2 -W 1 10.88.0.13", "agent"],
		]);
		expect(selectRecent(emptyLab())).toEqual([]);
	});

	test("bar history is the lines typed in the bar, newest first", () => {
		expect(selectBarHistory(s)).toEqual(["link down node3", "ls", "spawn 3 alpine --net switch0"]);
	});
});

describe("a lab with several switches", () => {
	const lan = switchNamed("lan");
	let s = withSwitches(labWith(1), lan);
	s = run(s, spawnEvent(s, 1, { net: [lan, "switch0"] }), isReady("node2"));
	s = run(s, linkEvent(s, false, { machine: "node2", nic: 0 }));

	test("shows each switch its own ports", () => {
		const shown = (on: SwitchName) =>
			selectPorts(on)(s).flatMap((p) => (p.machine ? [[p.port, p.machine.label, p.word]] : []));
		expect(shown("switch0")).toEqual([
			[1, "node1", "up"],
			[2, "node2:eth1", "up"],
		]);
		expect(shown(lan)).toEqual([[1, "node2:eth0", "cut"]]);
	});

	test("names the switch beside each port, and a lab with one does not", () => {
		const label = (state: LabState) => selectPorts(lan)(state)[0].actionLabel;
		expect(label(s)).toBe("Reconnect the cable from node2:eth0 to lan port 1");
		expect(selectPorts("switch0")(s)[0].actionLabel).toBe("Cut the cable from node1 to switch0 port 1");
	});

	test("has the subnets of the NICs in each", () => {
		expect(selectSubnets(lan)(s)).toBe("10.88.0.0/24");
		const routed = run(s, spawnEvent(s, 1, { net: [lan, "none"], addr: ["10.1.0.1/24", "10.2.0.1/24"] }));
		expect(selectSubnets(lan)(routed)).toBe("2 subnets");
		expect(selectSubnets("switch0")(routed)).toBe("10.88.0.0/24");
		const empty = withSwitches(labWith(1), lan);
		expect(selectSubnets(lan)(empty)).toBe("no addresses");
	});

	test("remembers each switch by itself", () => {
		const [first, second] = [selectPorts("switch0")(s), selectPorts(lan)(s)];
		expect(selectPorts("switch0")(s)).toBe(first);
		expect(selectPorts(lan)(s)).toBe(second);
	});
});

describe("memoisation", () => {
	test("a selector returns the same object until something it reads changes", () => {
		const s = labWith(3);
		const elsewhere = run(s, tick(s.now + 1000), { type: "ui/view", view: "spawn" }, logged("ls", "bar", s.now + 1000));
		expect(elsewhere).not.toBe(s);
		for (const select of [selectPorts("switch0"), selectSubnets("switch0"), selectNames]) {
			expect(select(elsewhere)).toBe(select(s));
		}
		expect(selectRecent(elsewhere)).not.toBe(selectRecent(s));
		const cut = run(elsewhere, linkEvent(elsewhere, false, "node2"));
		expect(selectPorts("switch0")(cut)).not.toBe(selectPorts("switch0")(elsewhere));
	});
});
