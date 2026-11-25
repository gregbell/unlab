import { describe, expect, test } from "vitest";
import {
	selectAgentIndicator,
	selectBarHistory,
	selectDetails,
	selectFocused,
	selectLinks,
	selectParkedChips,
	selectPorts,
	selectRail,
	selectRecent,
	selectStatus,
	selectSubnets,
	selectTiling,
} from "./selectors.ts";
import {
	agentCall,
	emptyLab,
	hasFailed,
	isReady,
	labWith,
	linkEvent,
	logged,
	remove,
	run,
	spawnEvent,
} from "./testkit.ts";
import { AGENT_IDLE_MS, type LabEvent, type LabState, type MachineName } from "./types.ts";

const tick = (now: number): LabEvent => ({ type: "tick", now });
const shell = (machine: MachineName): LabEvent => ({ type: "cmd/shell", machine });
const focus = (target: MachineName): LabEvent => ({ type: "cmd/focus", target, mode: "plain" });
const row = (s: LabState, name: MachineName) => selectRail(s).find((r) => r.name === name);
const texts = (s: LabState) => ({
	left: selectStatus(s).left.map((segment) => segment.text),
	right: selectStatus(s).right.map((segment) => segment.text),
});
const tone = (s: LabState, key: string) =>
	[...selectStatus(s).left, ...selectStatus(s).right].find((segment) => segment.key === key)?.tone;

describe("chosen addresses", () => {
	let s = emptyLab();
	s = run(s, spawnEvent(s, 1, { net: ["switch0", "switch0"], addr: ["10.1.0.1/16", null], gateway: false }));
	s = run(s, spawnEvent(s, 1, { addr: [null] }), isReady("node1"), isReady("node2"));
	const values = (name: MachineName) =>
		selectDetails(run(s, focus(name)))?.rows.flatMap((r) =>
			["address", "gateway"].includes(r.label) ? [r.value] : [],
		);

	test("show in the rail and the details, or that there is none", () => {
		expect(selectRail(s).map((r) => r.line2)).toEqual(["10.1.0.1", "no address"]);
		expect(values("node1")).toEqual(["off", "10.1.0.1/16", "none"]);
		expect(values("node2")).toEqual(["none"]);
	});

	test("name the switch's subnet, and how many once there are several", () => {
		expect(selectSubnets(emptyLab())).toBe("10.88.0.0/24");
		expect(selectSubnets(labWith(2))).toBe("10.88.0.0/24");
		expect(selectSubnets(s)).toBe("10.1.0.0/16");
		expect(selectSubnets(run(s, spawnEvent(s, 1)))).toBe("2 subnets");
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

describe("the rail", () => {
	test("has one row per machine, in spawn order, with the machine's hue", () => {
		const rows = selectRail(labWith(3));
		expect(rows.map((r) => [r.name, r.hue])).toEqual([
			["node1", 1],
			["node2", 2],
			["node3", 3],
		]);
	});

	test("a ready machine shows its address, and its word is the link state", () => {
		const s = oneOfEach();
		expect(row(s, "node1")).toEqual({
			name: "node1",
			hue: 1,
			phase: "ready",
			line2: "10.88.0.11",
			word: "up",
			focused: true,
			parked: false,
		});
		expect(row(s, "node2")).toMatchObject({ line2: "10.88.0.12", word: "cut" });
		expect(row(s, "node3")).toMatchObject({ line2: "10.88.0.13", word: "unplugged" });
	});

	test("a booting machine shows its address and counts its boot time in tenths on the right", () => {
		const s = oneOfEach();
		expect(row(s, "node4")).toMatchObject({ phase: "booting", line2: "10.88.0.14", word: "booting 1.4 s" });
		expect(row(run(s, tick(11_499)), "node4")?.word).toBe("booting 1.4 s");
		expect(row(run(s, tick(11_500)), "node4")?.word).toBe("booting 1.5 s");
		expect(row(run(s, tick(72_000)), "node4")?.word).toBe("booting 62.0 s");
	});

	test("a boot that has only just begun reads 0.0 s", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { at: 500 }));
		expect(row(s, "node1")?.word).toBe("booting 0.0 s");
	});

	test("a failed machine reads did not boot", () => {
		expect(row(oneOfEach(), "node5")).toMatchObject({ phase: "failed", line2: "did not boot", word: "failed" });
	});

	test("a removing machine keeps its address and says so", () => {
		expect(row(oneOfEach(), "node6")).toMatchObject({ phase: "removing", line2: "10.88.0.16", word: "removing" });
	});

	test("a parked machine adds · parked after the address", () => {
		const s = run(labWith(2), { type: "ui/park", machine: "node2" });
		expect(row(s, "node2")).toMatchObject({ line2: "10.88.0.12 · parked", word: "up", parked: true });
		expect(row(s, "node1")).toMatchObject({ line2: "10.88.0.11", parked: false });
	});

	test("the focused row is the machine with the keyboard, and stays so while the bar is open", () => {
		let s = run(labWith(3), focus("node2"));
		expect(selectRail(s).map((r) => r.focused)).toEqual([false, true, false]);
		expect(selectFocused(s)).toBe("node2");
		s = run(s, { type: "ui/bar", open: true });
		expect(selectRail(s).map((r) => r.focused)).toEqual([false, true, false]);
		expect(selectFocused(s)).toBe("node2");
		expect(selectFocused(emptyLab())).toBeNull();
	});
});

describe("machine details", () => {
	test("nothing is shown while no machine has the keyboard", () => {
		expect(selectDetails(emptyLab())).toBeNull();
	});

	test("a ready machine: label and value rows in the handoff's order", () => {
		let s = run(labWith(2), focus("node2"), shell("node2"));
		s = run(s, { type: "session/opened", session: "node2:sh1" });
		expect(selectDetails(s)).toEqual({
			name: "node2",
			hue: 2,
			phase: "ready",
			ports: [2],
			cables: [{ label: "node2", nic: null, link: "up" }],
			reason: null,
			accepts: { commands: true, bootAgain: false, remove: true },
			rows: [
				{ label: "state", value: "ready · 3582 ms" },
				{ label: "image", value: "alpine 3.24" },
				{ label: "CPUs", value: "1" },
				{ label: "disk", value: "4 GiB" },
				{ label: "memory", value: "256 MiB" },
				{ label: "address", value: "10.88.0.12/24" },
				{ label: "mac", value: "52:54:00:88:00:0c" },
				{ label: "uplink", value: "lab only" },
				{ label: "link", value: "connected on port 2", tone: "ok" },
				{ label: "shells", value: "console, sh1" },
			],
		});
	});

	const value = (s: LabState, label: string) => selectDetails(s)?.rows.find((r) => r.label === label)?.value;

	test("a machine with extra disks has a row for each disk, by its device", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { extra: [1, 64] }), focus("node1"));
		const rows = selectDetails(s)?.rows.filter((r) => r.value.endsWith("GiB"));
		expect(rows).toEqual([
			{ label: "/dev/wdb", value: "4 GiB" },
			{ label: "/dev/wdc", value: "1 GiB" },
			{ label: "/dev/wdd", value: "64 GiB" },
		]);
	});

	test("the link row reads connected, cable cut or unplugged", () => {
		const s = oneOfEach();
		expect(value(run(s, focus("node1")), "link")).toBe("connected on port 1");
		expect(value(run(s, focus("node2")), "link")).toBe("cable cut on port 2");
		expect(value(run(s, focus("node3")), "link")).toBe("unplugged");
		expect(selectDetails(run(s, focus("node2")))).toMatchObject({ cables: [{ link: "cut" }], ports: [2] });
		expect(selectDetails(run(s, focus("node3")))).toMatchObject({ cables: [{ link: "unplugged" }], ports: [] });
	});

	test("the state row follows the lifecycle, and a frozen boot time is a whole number of ms", () => {
		const s = oneOfEach();
		expect(value(run(s, focus("node4")), "state")).toBe("booting 1.4 s");
		expect(value(run(s, focus("node5")), "state")).toBe("failed");
		expect(value(run(s, focus("node6")), "state")).toBe("removing");
		let fractional = emptyLab();
		fractional = run(fractional, spawnEvent(fractional, 1), isReady("node1", 1, 3411.6));
		expect(value(fractional, "state")).toBe("ready · 3412 ms");
	});

	test("a machine that is not ready has no cable to act on, and says what it accepts", () => {
		const s = oneOfEach();
		expect(selectDetails(run(s, focus("node4")))).toMatchObject({
			phase: "booting",
			cables: [],
			ports: [3],
			accepts: { commands: false, bootAgain: false, remove: true },
		});
		expect(value(run(s, focus("node4")), "link")).toBe("port 3 reserved");
		expect(selectDetails(run(s, focus("node5")))).toMatchObject({
			phase: "failed",
			cables: [],
			ports: [],
			reason: "Kernel panic.",
			accepts: { commands: false, bootAgain: true, remove: true },
		});
		expect(value(run(s, focus("node5")), "link")).toBe("unplugged");
		expect(selectDetails(run(s, focus("node6")))).toMatchObject({
			phase: "removing",
			cables: [],
			accepts: { commands: false, bootAgain: false, remove: false },
		});
		expect(value(run(s, focus("node6")), "link")).toBe("port 5 down");
	});

	test("image and memory are what the machine was spawned with", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { image: "debian", memMiB: 512 }));
		expect(value(s, "image")).toBe("debian");
		expect(value(s, "memory")).toBe("512 MiB");
	});
});

describe("the switch faceplate", () => {
	test("has eight ports, each in the state the handoff draws", () => {
		expect(selectPorts(oneOfEach())).toEqual([
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

	test("counts the links for the header", () => {
		expect(selectLinks(oneOfEach())).toEqual({ up: 1, total: 3, cut: 1 });
		expect(selectLinks(labWith(3))).toEqual({ up: 3, total: 3, cut: 0 });
		expect(selectLinks(emptyLab())).toEqual({ up: 0, total: 0, cut: 0 });
	});
});

describe("a machine with several NICs", () => {
	/** node1 with eth0 on port 1, eth1 on port 2, and eth2 unplugged. */
	const three = () => {
		const s = emptyLab();
		return run(s, spawnEvent(s, 1, { net: ["switch0", "switch0", "none"] }), isReady("node1"));
	};

	test("its details tell each NIC apart, with its MAC, address and port", () => {
		const s = run(three(), linkEvent(three(), false, { machine: "node1", nic: 1 }));
		const details = selectDetails(s);
		expect(details?.rows.slice(5)).toEqual([
			{ label: "uplink", value: "lab only" },
			{ label: "eth0", value: "connected on port 1", tone: "ok" },
			{ label: "address", value: "10.88.0.11/24" },
			{ label: "mac", value: "52:54:00:88:00:0b" },
			{ label: "eth1", value: "cable cut on port 2", tone: "down" },
			{ label: "address", value: "none" },
			{ label: "mac", value: "52:54:00:88:01:0b" },
			{ label: "eth2", value: "unplugged" },
			{ label: "address", value: "none" },
			{ label: "mac", value: "52:54:00:88:02:0b" },
			{ label: "shells", value: "console" },
		]);
		expect(details).toMatchObject({
			ports: [1, 2],
			cables: [
				{ label: "node1:eth0", nic: "eth0", link: "up" },
				{ label: "node1:eth1", nic: "eth1", link: "cut" },
				{ label: "node1:eth2", nic: "eth2", link: "unplugged" },
			],
		});
	});

	test("each cable is its own port on the faceplate and its own link in the count", () => {
		const s = run(three(), linkEvent(three(), false, { machine: "node1", nic: 1 }));
		const holder = (nic: string) => ({ n: 1, name: "node1", hue: 1, label: `node1:${nic}`, nic });
		expect(selectPorts(s).slice(0, 3)).toEqual([
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
		expect(selectLinks(s)).toEqual({ up: 1, total: 2, cut: 1 });
	});

	test("the rail says cut while any cable is, up while any is up, and unplugged when none is there", () => {
		const word = (s: LabState) => selectRail(s)[0].word;
		const s = three();
		expect(word(s)).toBe("up");
		expect(word(run(s, linkEvent(s, false, { machine: "node1", nic: 1 })))).toBe("cut");
		const loose = emptyLab();
		expect(word(run(loose, spawnEvent(loose, 1, { net: ["none", "none"] }), isReady("node1")))).toBe("unplugged");
	});

	test("keeps its cables apart while it is being removed", () => {
		const s = run(three(), remove("node1"));
		expect(selectPorts(s)[1]).toMatchObject({ state: "removing", machine: { label: "node1:eth1" }, word: "down" });
		expect(
			selectDetails(s)
				?.rows.filter((r) => r.label.startsWith("eth"))
				.map((r) => r.value),
		).toEqual(["port 1 down", "port 2 down", "unplugged"]);
	});
});

describe("panes", () => {
	test("the tiling places the visible panes: three are a main pane and a stack", () => {
		const s = run(labWith(4), { type: "ui/park", machine: "node2" });
		const tiling = selectTiling(s);
		expect(tiling.tiles.map((t) => t.machine)).toEqual(["node1", "node3", "node4"]);
		expect(tiling.columns).toBe("minmax(0, 3fr) minmax(0, 2fr)");
	});

	test("focusing does not re-tile", () => {
		const s = labWith(3);
		expect(selectTiling(run(s, focus("node3")))).toBe(selectTiling(s));
	});

	test("the parked strip lists chips in pane order", () => {
		let s = labWith(4);
		expect(selectParkedChips(s)).toEqual([]);
		s = run(s, { type: "ui/park", machine: "node3" }, { type: "ui/park", machine: "node1" });
		expect(selectParkedChips(s)).toEqual(["node1", "node3"]);
	});
});

describe("the status line", () => {
	/** Three ready, one booting unplugged; one cut cable; a shell open on node2; an agent call just made. */
	function busy(): LabState {
		let s = labWith(3);
		s = run(s, linkEvent(s, false, "node3"), shell("node2"), { type: "session/opened", session: "node2:sh1" });
		s = run(s, spawnEvent(s, 1, { net: "none" }));
		return run(s, { type: "agent/call", call: agentCall(1, s.now) });
	}

	test("words its segments as the handoff does", () => {
		expect(texts(busy())).toEqual({
			left: ["3 of 4 machines ready, 1 booting", "5 open sessions", "switch0: 2 of 3 links up"],
			right: ["webmcp: 7 tools, agent active"],
		});
	});

	test("a segment is quiet when all is well", () => {
		const s = run(labWith(3), { type: "agent/call", call: agentCall(1, 0) });
		expect(texts(s).left).toEqual(["3 of 3 machines ready", "3 open sessions", "switch0: 3 of 3 links up"]);
		expect([...selectStatus(s).left, ...selectStatus(s).right].map((segment) => segment.tone)).toEqual([
			"quiet",
			"quiet",
			"quiet",
			"quiet",
		]);
	});

	test("the machines segment turns down while any machine has failed", () => {
		const s = run(labWith(4), hasFailed("node4"));
		expect(texts(s).left[0]).toBe("3 of 4 machines ready, 1 failed");
		expect(tone(s, "machines")).toBe("down");
		expect(tone(busy(), "machines")).toBe("quiet");
	});

	test("booting and failed are both counted", () => {
		let s = run(labWith(2), hasFailed("node2"));
		s = run(s, spawnEvent(s, 2));
		expect(texts(s).left[0]).toBe("1 of 4 machines ready, 2 booting, 1 failed");
	});

	test("the links segment turns down while any cable is cut", () => {
		expect(tone(busy(), "links")).toBe("down");
		expect(tone(labWith(2), "links")).toBe("quiet");
	});

	test("the WebMCP segment turns warn while a call waits for approval", () => {
		let s = run(busy(), { type: "agent/call", call: agentCall(2, 0, { status: "waiting" }) });
		expect(texts(s).right[0]).toBe("webmcp: 1 call waiting for you");
		expect(tone(s, "webmcp")).toBe("warn");
		s = run(s, { type: "agent/call", call: agentCall(3, 0, { status: "waiting" }) });
		expect(texts(s).right[0]).toBe("webmcp: 2 calls waiting for you");
		s = run(s, { type: "agent/settled", id: 2, status: "denied", result: "Denied by the user." });
		s = run(s, { type: "agent/settled", id: 3, status: "aborted", result: null });
		expect(texts(s).right[0]).toBe("webmcp: 7 tools, agent active");
		expect(tone(s, "webmcp")).toBe("quiet");
	});

	test("paused tools read webmcp: paused", () => {
		const s = run(busy(), { type: "ui/tools-paused", paused: true });
		expect(texts(s).right[0]).toBe("webmcp: paused");
		expect(tone(s, "webmcp")).toBe("quiet");
	});

	test("a browser without WebMCP, or one that refused the tools, is said before the pause but after a waiting call", () => {
		let s = run(
			busy(),
			{ type: "ui/tools-paused", paused: true },
			{ type: "agent/webmcp", webmcp: { kind: "absent" } },
		);
		expect(texts(s).right[0]).toBe("webmcp: not available");
		expect(tone(s, "webmcp")).toBe("quiet");
		s = run(s, { type: "agent/webmcp", webmcp: { kind: "refused", message: "Not allowed." } });
		expect(texts(s).right[0]).toBe("webmcp: blocked");
		expect(tone(s, "webmcp")).toBe("warn");
		s = run(s, { type: "agent/call", call: agentCall(2, 0, { status: "waiting" }) });
		expect(texts(s).right[0]).toBe("webmcp: 1 call waiting for you");
	});

	test("a tool switched off is not counted, and an idle agent is called idle", () => {
		let s = run(busy(), { type: "ui/policy", tool: "shell_exec", policy: "off" });
		expect(texts(s).right[0]).toBe("webmcp: 6 tools, agent active");
		s = run(s, tick(s.now + AGENT_IDLE_MS));
		expect(texts(s).right[0]).toBe("webmcp: 6 tools, agent idle");
	});

	test("an empty lab", () => {
		expect(texts(emptyLab())).toEqual({
			left: ["0 machines", "0 open sessions"],
			right: ["webmcp: 7 tools registered"],
		});
	});

	test("a machine being removed is no longer counted", () => {
		const s = run(labWith(4), remove("node4"));
		expect(texts(s).left).toEqual(["3 of 3 machines ready", "3 open sessions", "switch0: 3 of 3 links up"]);
	});

	test("one of anything is singular", () => {
		let s = run(labWith(1), { type: "ui/policy", tool: "capture_read", policy: "off" });
		for (const tool of ["machines_list", "machines_spawn", "machines_remove", "shell_exec", "shell_read"] as const) {
			s = run(s, { type: "ui/policy", tool, policy: "off" });
		}
		expect(texts(s)).toEqual({
			left: ["1 of 1 machine ready", "1 open session", "switch0: 1 of 1 link up"],
			right: ["webmcp: 1 tool registered"],
		});
	});

	test("a shell still opening and a failed machine's console are not open sessions", () => {
		let s = run(labWith(2), shell("node1"));
		expect(texts(s).left[1]).toBe("2 open sessions");
		s = run(s, { type: "session/opened", session: "node1:sh1" });
		expect(texts(s).left[1]).toBe("3 open sessions");
		s = run(s, hasFailed("node1"));
		expect(texts(s).left[1]).toBe("1 open session");
	});

	test("machines without a cable leave the links segment out", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 2, { net: "none" }));
		expect(texts(s).left).toEqual(["0 of 2 machines ready, 2 booting", "2 open sessions"]);
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

describe("memoisation", () => {
	test("a selector returns the same object until something it reads changes", () => {
		const s = labWith(3);
		const elsewhere = run(s, tick(s.now + 1000), { type: "ui/view", view: "wire" }, logged("ls", "bar", s.now + 1000));
		expect(elsewhere).not.toBe(s);
		for (const select of [
			selectRail,
			selectPorts,
			selectLinks,
			selectTiling,
			selectParkedChips,
			selectStatus,
			selectDetails,
		]) {
			expect(select(elsewhere)).toBe(select(s));
		}
		expect(selectRecent(elsewhere)).not.toBe(selectRecent(s));
		const cut = run(elsewhere, linkEvent(elsewhere, false, "node2"));
		for (const select of [selectRail, selectPorts, selectLinks, selectStatus]) {
			expect(select(cut)).not.toBe(select(elsewhere));
		}
		expect(selectTiling(cut)).toBe(selectTiling(elsewhere));
	});

	test("the rail follows the clock only while something boots", () => {
		let s = labWith(1);
		s = run(s, spawnEvent(s, 1));
		const booting = selectRail(s);
		expect(selectRail(run(s, tick(s.now + 100)))).not.toBe(booting);
		s = run(s, isReady("node2"));
		expect(selectRail(run(s, tick(s.now + 100)))).toBe(selectRail(s));
	});
});
