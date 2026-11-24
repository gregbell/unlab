import { describe, expect, test } from "vitest";
import { identity } from "./identity.ts";
import {
	ACCEPTS,
	firstFreeHues,
	hostsFor,
	isPlanError,
	lowestFreePorts,
	planBootAgain,
	planLink,
	planSpawn,
	takenPorts,
} from "./machines.ts";
import {
	bootAgainEvent,
	effectsOf,
	emptyLab,
	hasFailed,
	hasStopped,
	isReady,
	labWith,
	linkEvent,
	machine,
	remove,
	run,
	spawnEvent,
} from "./testkit.ts";
import {
	BOOT_TIMEOUT_MS,
	type CommandEvent,
	type LabEvent,
	type LabState,
	type MachineName,
	type MachineSpec,
	type Phase,
	type RuntimeEvent,
} from "./types.ts";
import { update } from "./update.ts";

const ALPINE: MachineSpec = { image: "alpine", memMiB: 256, nics: [{ net: "switch0" }] };
const UNPLUGGED: MachineSpec = { image: "alpine", memMiB: 256, nics: [{ net: "none" }] };

/** A lab whose node1 is in `phase` on boot attempt `attempt`, beside a ready node2. */
function labIn(phase: Phase, attempt: 1 | 2): LabState {
	let s = emptyLab();
	s = run(s, spawnEvent(s, 2, { at: 1000 }), isReady("node2"));
	if (attempt === 2) {
		s = run(s, hasFailed("node1", 1));
		s = run(s, bootAgainEvent(s, "node1", 2000));
	}
	if (phase === "booting") return s;
	if (phase === "failed") return run(s, hasFailed("node1", attempt));
	s = run(s, isReady("node1", attempt));
	return phase === "ready" ? s : run(s, remove("node1"));
}

type Column = (RuntimeEvent | CommandEvent)["type"] | "tick past the boot timeout";

/**
 * `ignored`: the same state object and no effects.
 * `untouched`: the machine's lifecycle is the same object, whatever else moved.
 * A phase: the machine is in it afterwards, by this event's doing.
 */
type Outcome = "ignored" | "untouched" | Phase | "gone";

const TABLE: Readonly<Record<Phase, Readonly<Record<Column, Outcome>>>> = {
	booting: {
		"vm/stage": "booting",
		"vm/ready": "ready",
		"vm/failed": "failed",
		"vm/stopped": "ignored",
		"session/opened": "ignored",
		"session/ended": "ignored",
		"session/shell": "untouched",
		"session/marked": "untouched",
		tick: "untouched",
		"tick past the boot timeout": "failed",
		"cmd/spawn": "untouched",
		"cmd/remove": "removing",
		"cmd/boot-again": "ignored",
		"cmd/link": "ignored",
		"cmd/shell": "ignored",
		"cmd/focus": "untouched",
		"cmd/capture": "untouched",
		"cmd/logged": "untouched",
	},
	ready: {
		"vm/stage": "ignored",
		"vm/ready": "ignored",
		"vm/failed": "failed",
		"vm/stopped": "ignored",
		"session/opened": "ignored",
		"session/ended": "ignored",
		"session/shell": "untouched",
		"session/marked": "untouched",
		tick: "untouched",
		"tick past the boot timeout": "untouched",
		"cmd/spawn": "untouched",
		"cmd/remove": "removing",
		"cmd/boot-again": "ignored",
		"cmd/link": "ready",
		"cmd/shell": "ready",
		"cmd/focus": "untouched",
		"cmd/capture": "untouched",
		"cmd/logged": "untouched",
	},
	failed: {
		"vm/stage": "ignored",
		"vm/ready": "ignored",
		"vm/failed": "ignored",
		"vm/stopped": "ignored",
		"session/opened": "ignored",
		"session/ended": "ignored",
		"session/shell": "untouched",
		"session/marked": "untouched",
		tick: "untouched",
		"tick past the boot timeout": "untouched",
		"cmd/spawn": "untouched",
		"cmd/remove": "removing",
		"cmd/boot-again": "booting",
		"cmd/link": "ignored",
		"cmd/shell": "ignored",
		"cmd/focus": "untouched",
		"cmd/capture": "untouched",
		"cmd/logged": "untouched",
	},
	removing: {
		"vm/stage": "ignored",
		"vm/ready": "ignored",
		"vm/failed": "ignored",
		"vm/stopped": "gone",
		"session/opened": "ignored",
		"session/ended": "ignored",
		"session/shell": "untouched",
		"session/marked": "untouched",
		tick: "untouched",
		"tick past the boot timeout": "untouched",
		"cmd/spawn": "untouched",
		"cmd/remove": "ignored",
		"cmd/boot-again": "ignored",
		"cmd/link": "ignored",
		"cmd/shell": "ignored",
		"cmd/focus": "untouched",
		"cmd/capture": "untouched",
		"cmd/logged": "untouched",
	},
};

/** One concrete event per column, aimed at `name` on boot attempt `attempt`. */
function eventFor(column: Column, s: LabState, name: MachineName, attempt: number): LabEvent {
	switch (column) {
		case "vm/stage":
			return { type: "vm/stage", machine: name, attempt, stage: "starting the kernel" };
		case "vm/ready":
			return isReady(name, attempt);
		case "vm/failed":
			return hasFailed(name, attempt);
		case "vm/stopped":
			return hasStopped(name, attempt);
		case "session/opened":
			return { type: "session/opened", session: `${name}:console` };
		case "session/ended":
			return { type: "session/ended", session: `${name}:console` };
		case "session/shell":
			return { type: "session/shell", session: `${name}:console`, shell: "running" };
		case "session/marked":
			return { type: "session/marked", session: `${name}:console`, source: "agent" };
		case "tick":
			return { type: "tick", now: s.now + 100 };
		case "tick past the boot timeout":
			return { type: "tick", now: s.now + BOOT_TIMEOUT_MS };
		case "cmd/spawn":
			return spawnEvent(s, 1, { net: "none" });
		case "cmd/remove":
			return remove(name);
		case "cmd/boot-again":
			return { type: "cmd/boot-again", machine: name, ports: [lowestFreePorts(s, 1)[0] ?? null], at: s.now };
		case "cmd/link":
			return {
				type: "cmd/link",
				changes: [{ machine: name, nic: 0, up: false, port: 1, newPort: false }],
				cause: "bar",
			};
		case "cmd/shell":
			return { type: "cmd/shell", machine: name };
		case "cmd/focus":
			return { type: "cmd/focus", target: name, mode: "plain" };
		case "cmd/capture":
			return { type: "cmd/capture", filter: "arp" };
		case "cmd/logged":
			return { type: "cmd/logged", line: "ls", source: "bar", at: s.now, outcome: "ok" };
	}
}

const PHASES: readonly Phase[] = ["booting", "ready", "failed", "removing"];
const ATTEMPTS = [1, 2] as const;
const COLUMNS = Object.keys(TABLE.booting).filter((key): key is Column => key in TABLE.booting);
const VM_EVENTS = ["vm/stage", "vm/ready", "vm/failed", "vm/stopped"] as const;
/** Every event that names a machine or one of its sessions. */
const ADDRESSED = COLUMNS.filter(
	(column) => !["tick", "tick past the boot timeout", "cmd/spawn", "cmd/capture", "cmd/logged"].includes(column),
);

describe("the lifecycle table", () => {
	const cells = PHASES.flatMap((phase) =>
		ATTEMPTS.flatMap((attempt) => COLUMNS.map((column) => ({ phase, attempt, column, outcome: TABLE[phase][column] }))),
	);

	test.each(cells)("$phase (attempt $attempt) × $column → $outcome", ({ phase, attempt, column, outcome }) => {
		const before = labIn(phase, attempt);
		expect(machine(before, "node1").life).toMatchObject({ phase, attempt });
		const step = update(before, eventFor(column, before, "node1", attempt));
		const after = step.state.machines.node1;

		if (outcome === "ignored") {
			expect(step.state).toBe(before);
			expect(step.effects).toEqual([]);
		} else if (outcome === "untouched") {
			expect(after?.life).toBe(machine(before, "node1").life);
		} else if (outcome === "gone") {
			expect(after).toBeUndefined();
			expect(step.state.rail).not.toContain("node1");
		} else {
			expect(step.state).not.toBe(before);
			expect(after?.life.phase).toBe(outcome);
		}
		expect(step.state.machines.node2).toBe(before.machines.node2);
	});

	const stale = PHASES.flatMap((phase) =>
		ATTEMPTS.flatMap((attempt) =>
			VM_EVENTS.flatMap((column) => [
				{ phase, attempt, column, stamped: attempt - 1 },
				{ phase, attempt, column, stamped: attempt + 1 },
			]),
		),
	);

	test.each(stale)("$phase (attempt $attempt) ignores $column stamped with attempt $stamped", (cell) => {
		const before = labIn(cell.phase, cell.attempt);
		const step = update(before, eventFor(cell.column, before, "node1", cell.stamped));
		expect(step.state).toBe(before);
		expect(step.effects).toEqual([]);
	});

	test.each(ADDRESSED)("%s for a machine that does not exist is ignored", (column) => {
		const before = labWith(2);
		const step = update(before, eventFor(column, before, "node99", 1));
		expect(step.state).toBe(before);
		expect(step.effects).toEqual([]);
	});

	test("what each phase accepts is the handoff's last column", () => {
		expect(ACCEPTS).toEqual({
			booting: { commands: false, bootAgain: false, remove: true },
			ready: { commands: true, bootAgain: false, remove: true },
			failed: { commands: false, bootAgain: true, remove: true },
			removing: { commands: false, bootAgain: false, remove: false },
		});
	});

	test("a failed machine holds no port, and a removing one keeps its port until it is gone", () => {
		let s = labWith(2);
		expect([...takenPorts(s)]).toEqual([1, 2]);
		s = run(s, hasFailed("node1"));
		expect([...takenPorts(s)]).toEqual([2]);
		s = run(s, remove("node2"));
		expect(machine(s, "node2").life).toEqual({ phase: "removing", attempt: 1, ports: [2] });
		expect([...takenPorts(s)]).toEqual([2]);
		s = run(s, hasStopped("node2"));
		expect([...takenPorts(s)]).toEqual([]);
	});

	test("a late message from the worker a boot again replaced is ignored", () => {
		let s = labIn("failed", 1);
		s = run(s, bootAgainEvent(s, "node1"));
		expect(machine(s, "node1").life).toMatchObject({ phase: "booting", attempt: 2 });
		expect(update(s, isReady("node1", 1)).state).toBe(s);
		expect(update(s, hasStopped("node1", 1)).state).toBe(s);
		expect(update(s, hasFailed("node1", 1)).state).toBe(s);
	});
});

describe("names", () => {
	test("the number starts at 1 and only goes up", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 2));
		expect(s.rail).toEqual(["node1", "node2"]);
		s = run(s, spawnEvent(s, 1));
		expect(s.rail).toEqual(["node1", "node2", "node3"]);
	});

	test("a removed name is not reused", () => {
		let s = labWith(2);
		s = run(s, remove("node2"), hasStopped("node2"));
		s = run(s, spawnEvent(s, 1));
		expect(s.rail).toEqual(["node1", "node3"]);
		expect(machine(s, "node3")).toMatchObject(identity(3));
	});
});

describe("hues", () => {
	test("each machine takes the first hue not in use, in order", () => {
		const s = labWith(3);
		expect(s.rail.map((name) => machine(s, name).hue)).toEqual([1, 2, 3]);
		expect(firstFreeHues(s, 2)).toEqual([4, 5]);
	});

	test("a hue is held through failure and removal, and freed when the machine is gone", () => {
		let s = labWith(3);
		s = run(s, hasFailed("node1"), remove("node2"));
		expect(firstFreeHues(s, 1)).toEqual([4]);
		s = run(s, hasStopped("node2"));
		expect(firstFreeHues(s, 2)).toEqual([2, 4]);
		s = run(s, spawnEvent(s, 2));
		expect(machine(s, "node4").hue).toBe(2);
		expect(machine(s, "node5").hue).toBe(4);
	});

	test("boot again keeps the hue", () => {
		let s = labWith(3);
		s = run(s, hasFailed("node2"));
		s = run(s, bootAgainEvent(s, "node2"));
		expect(machine(s, "node2").hue).toBe(2);
	});
});

describe("ports", () => {
	test("a machine takes the lowest free port at spawn", () => {
		const s = labWith(3);
		expect(s.rail.map((name) => machine(s, name).life)).toMatchObject([
			{ plugs: [{ kind: "port", port: 1, link: "up" }] },
			{ plugs: [{ kind: "port", port: 2, link: "up" }] },
			{ plugs: [{ kind: "port", port: 3, link: "up" }] },
		]);
		expect(lowestFreePorts(s, 8)).toEqual([4, 5, 6, 7, 8]);
		expect(lowestFreePorts(s, 2)).toEqual([4, 5]);
	});

	test("a machine keeps its port while cut", () => {
		let s = labWith(3);
		s = run(s, linkEvent(s, false, "node2"));
		expect(machine(s, "node2").life).toMatchObject({ phase: "ready", plugs: [{ kind: "port", port: 2, link: "cut" }] });
		expect([...takenPorts(s)]).toEqual([1, 2, 3]);
		s = run(s, spawnEvent(s, 1));
		expect(machine(s, "node4").life).toMatchObject({ plugs: [{ port: 4 }] });
		s = run(s, linkEvent(s, true, "node2"));
		expect(machine(s, "node2").life).toMatchObject({ plugs: [{ kind: "port", port: 2, link: "up" }] });
	});

	test("boot again takes the lowest free port, and keeps the name, hue, image and memory", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 3, { memMiB: 512, image: "debian" }), isReady("node1"), isReady("node3"));
		s = run(s, hasFailed("node2"));
		expect(machine(s, "node2").life).toEqual({ phase: "failed", attempt: 1, reason: "Kernel panic." });
		s = run(s, spawnEvent(s, 1));
		expect(machine(s, "node4").life).toMatchObject({ plugs: [{ port: 2 }] });
		s = run(s, bootAgainEvent(s, "node2", 9000));
		expect(machine(s, "node2")).toMatchObject({
			...identity(2),
			hue: 2,
			spec: { image: "debian", memMiB: 512, nics: [{ net: "switch0" }] },
			life: { phase: "booting", attempt: 2, since: 9000, plugs: [{ kind: "port", port: 4, link: "up" }] },
		});
	});

	test("a boot-again planned for a port someone has since taken is ignored", () => {
		let s = labWith(2);
		s = run(s, hasFailed("node1"));
		const planned = bootAgainEvent(s, "node1");
		s = run(s, spawnEvent(s, 1));
		expect(machine(s, "node3").life).toMatchObject({ plugs: [{ port: 1 }] });
		expect(update(s, planned).state).toBe(s);
	});

	test("a machine spawned with --no-net has no port, and stays without one when it boots again", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { net: "none" }));
		expect(machine(s, "node1").life).toMatchObject({ plugs: [{ kind: "none" }] });
		expect([...takenPorts(s)]).toEqual([]);
		s = run(s, hasFailed("node1"));
		expect(planBootAgain(s, "node1")).toEqual({ machine: "node1", ports: [null] });
		s = run(s, bootAgainEvent(s, "node1"));
		expect(machine(s, "node1").life).toMatchObject({ phase: "booting", plugs: [{ kind: "none" }] });
	});

	test("link up gives an unplugged machine the lowest free port", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1));
		s = run(s, spawnEvent(s, 1, { net: "none" }));
		s = run(s, spawnEvent(s, 1));
		s = run(s, isReady("node1"), isReady("node2"), isReady("node3"));
		expect(machine(s, "node3").life).toMatchObject({ plugs: [{ port: 2 }] });
		expect(planLink(s, ["node2"], true)).toEqual([{ machine: "node2", nic: 0, up: true, port: 3, newPort: true }]);
		s = run(s, remove("node1"), hasStopped("node1"));
		expect(planLink(s, ["node2"], true)).toEqual([{ machine: "node2", nic: 0, up: true, port: 1, newPort: true }]);
		s = run(s, linkEvent(s, true, "node2"));
		expect(machine(s, "node2").life).toMatchObject({ plugs: [{ kind: "port", port: 1, link: "up" }] });
	});
});

describe("planSpawn", () => {
	test("plans names, addresses, hues and ports before anything boots", () => {
		const s = labWith(3);
		expect(planSpawn(s, 2, ALPINE)).toEqual({
			machines: [
				{ identity: identity(4), hue: 4, ports: [4] },
				{ identity: identity(5), hue: 5, ports: [5] },
			],
			spec: ALPINE,
		});
		expect(planSpawn(s, 1, UNPLUGGED)).toEqual({
			machines: [{ identity: identity(4), hue: 4, ports: [null] }],
			spec: UNPLUGGED,
		});
	});

	test("asking for more machines than there is room for says how much room there is", () => {
		const s = labWith(6);
		expect(planSpawn(s, 3, ALPINE)).toEqual({ kind: "no-room", free: 2, wanted: 3 });
		expect(planSpawn(s, 3, UNPLUGGED)).toEqual({ kind: "no-room", free: 2, wanted: 3 });
		expect(planSpawn(s, 2, ALPINE)).toMatchObject({ machines: [{ ports: [7] }, { ports: [8] }] });
	});

	test("a lab holds eight machines, counting ones still being removed", () => {
		let s = labWith(8);
		expect(planSpawn(s, 1, UNPLUGGED)).toEqual({ kind: "no-room", free: 0, wanted: 1 });
		s = run(s, remove("node3"));
		expect(planSpawn(s, 1, UNPLUGGED)).toEqual({ kind: "no-room", free: 0, wanted: 1 });
		s = run(s, hasStopped("node3"));
		expect(planSpawn(s, 1, ALPINE)).toEqual({
			machines: [{ identity: identity(9), hue: 3, ports: [3] }],
			spec: ALPINE,
		});
	});

	test("an image the lab does not have is an error", () => {
		expect(planSpawn(emptyLab(), 1, { ...ALPINE, image: "plan9" })).toEqual({ kind: "unknown-image", image: "plan9" });
	});

	test("names are never reused, so a lab runs out of addresses after node244", () => {
		let s = emptyLab();
		for (let round = 0; round < 30; round++) {
			s = run(s, spawnEvent(s, 8, { net: "none" }));
			s = run(s, remove(...s.rail), ...s.rail.map((name) => hasStopped(name)));
		}
		expect(s.nextN).toBe(241);
		expect(planSpawn(s, 5, ALPINE)).toEqual({ kind: "no-room", free: 4, wanted: 5 });
		s = run(s, spawnEvent(s, 4));
		expect(s.rail).toEqual(["node241", "node242", "node243", "node244"]);
		expect(machine(s, "node244").ip).toBe("10.88.0.254");
		expect(planSpawn(s, 1, ALPINE)).toEqual({ kind: "no-room", free: 0, wanted: 1 });
	});

	test("isPlanError tells a plan from an error", () => {
		expect(isPlanError(planSpawn(labWith(8), 1, ALPINE))).toBe(true);
		expect(isPlanError(planSpawn(emptyLab(), 1, ALPINE))).toBe(false);
		expect(isPlanError(planLink(labWith(1), ["node1"], false))).toBe(false);
		expect(isPlanError(planBootAgain(labWith(1), "node1"))).toBe(false);
	});
});

describe("planLink", () => {
	test("plans only the cables that would change", () => {
		let s = labWith(3);
		s = run(s, linkEvent(s, false, "node2"));
		expect(planLink(s, ["node1", "node2", "node3"], false)).toEqual([
			{ machine: "node1", nic: 0, up: false, port: 1, newPort: false },
			{ machine: "node3", nic: 0, up: false, port: 3, newPort: false },
		]);
		expect(planLink(s, ["node1", "node2", "node3"], true)).toEqual([
			{ machine: "node2", nic: 0, up: true, port: 2, newPort: false },
		]);
	});

	test("skips machines that are not ready or not there, and repeats", () => {
		let s = labWith(1);
		s = run(s, spawnEvent(s, 1));
		expect(planLink(s, ["node1", "node1", "node2", "node7"], false)).toEqual([
			{ machine: "node1", nic: 0, up: false, port: 1, newPort: false },
		]);
	});

	test("unplugged machines take the lowest free ports in the order named", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 3, { net: "none" }));
		s = run(s, ...s.rail.map((name) => isReady(name)));
		expect(planLink(s, ["node3", "node1"], true)).toEqual([
			{ machine: "node3", nic: 0, up: true, port: 1, newPort: true },
			{ machine: "node1", nic: 0, up: true, port: 2, newPort: true },
		]);
		expect(planLink(s, ["node3"], false)).toEqual([]);
	});
});

describe("planBootAgain", () => {
	test("is only for a failed machine", () => {
		const s = labWith(1);
		expect(planBootAgain(s, "node1")).toBeNull();
		expect(planBootAgain(s, "node9")).toBeNull();
	});

	test("plans the lowest free port", () => {
		let s = labWith(3);
		s = run(s, hasFailed("node1"), hasFailed("node3"));
		expect(planBootAgain(s, "node3")).toEqual({ machine: "node3", ports: [1] });
	});
});

describe("hostsFor", () => {
	test("lists every machine in the lab, in spawn order", () => {
		let s = labWith(2);
		s = run(s, spawnEvent(s, 1));
		expect(hostsFor(s)).toEqual([
			{ ip: "10.88.0.11", name: "node1" },
			{ ip: "10.88.0.12", name: "node2" },
			{ ip: "10.88.0.13", name: "node3" },
		]);
		s = run(s, remove("node1"), hasStopped("node1"));
		expect(hostsFor(s).map((h) => h.name)).toEqual(["node2", "node3"]);
	});
});

describe("machines with several NICs", () => {
	const ROUTER: MachineSpec = {
		image: "alpine",
		memMiB: 256,
		nics: [{ net: "switch0" }, { net: "none" }, { net: "switch0" }],
	};
	const ports = (s: LabState, count: number): unknown => {
		const plan = planSpawn(s, count, ROUTER);
		return isPlanError(plan) ? plan : plan.machines.map((m) => m.ports);
	};

	test("take the lowest free ports in machine and NIC order, and none for a NIC left unplugged", () => {
		const s = labWith(2);
		expect(ports(s, 2)).toEqual([
			[3, null, 4],
			[5, null, 6],
		]);
		const gap = run(s, remove("node1"), hasStopped("node1"));
		expect(ports(gap, 1)).toEqual([[1, null, 3]]);
	});

	test("are refused when the switch has too few ports, however much room the lab has", () => {
		const s = labWith(5);
		expect(ports(s, 2)).toEqual({ kind: "no-ports", free: 3, wanted: 4 });
		expect(ports(s, 1)).toEqual([[6, null, 7]]);
	});

	test("hold one port for each plugged NIC until they are gone", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { net: ["switch0", "none", "switch0"] }), isReady("node1"));
		expect([...takenPorts(s)]).toEqual([1, 2]);
		const event = remove("node1");
		expect(effectsOf(s, event)).toEqual([
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: false, cause: "bar" },
			{ type: "link/set", port: 2, machine: "node1", nic: 2, up: false, cause: "bar" },
			{ type: "vm/stop", machine: "node1", attempt: 1 },
		]);
		s = run(s, event);
		expect(machine(s, "node1").life).toEqual({ phase: "removing", attempt: 1, ports: [1, null, 2] });
		expect([...takenPorts(s)]).toEqual([1, 2]);
		expect(effectsOf(s, hasStopped("node1")).filter((e) => e.type === "port/detach")).toEqual([
			{ type: "port/detach", port: 1 },
			{ type: "port/detach", port: 2 },
		]);
	});

	test("attach every plugged NIC before the kernel boots, and raise each link at ready", () => {
		const s = emptyLab();
		const spawned = spawnEvent(s, 1, { net: ["switch0", "switch0"] });
		expect(effectsOf(s, spawned).slice(1, 4)).toMatchObject([
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node1", nic: 1 },
			{ type: "vm/boot" },
		]);
		expect(effectsOf(run(s, spawned), isReady("node1")).filter((e) => e.type === "link/set")).toEqual([
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: true, cause: "runtime" },
			{ type: "link/set", port: 2, machine: "node1", nic: 1, up: true, cause: "runtime" },
		]);
	});

	test("boot again with the NICs they were spawned with, on the lowest free ports", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { net: ["switch0", "none", "switch0"] }), hasFailed("node1"));
		s = run(s, spawnEvent(s, 1));
		expect([...takenPorts(s)]).toEqual([1]);
		expect(planBootAgain(s, "node1")).toEqual({ machine: "node1", ports: [2, null, 3] });
		s = run(s, spawnEvent(s, 6));
		expect(planBootAgain(s, "node1")).toEqual({ kind: "no-ports", free: 1, wanted: 2 });
	});

	test("change the cable of one NIC alone, or of every NIC by the machine's name", () => {
		let s = emptyLab();
		s = run(s, spawnEvent(s, 1, { net: ["switch0", "switch0", "none"] }), isReady("node1"));
		const eth1 = { machine: "node1", nic: 1 } as const;
		expect(planLink(s, [eth1], false)).toEqual([{ ...eth1, up: false, port: 2, newPort: false }]);
		expect(planLink(s, ["node1", eth1], false)).toEqual([
			{ machine: "node1", nic: 0, up: false, port: 1, newPort: false },
			{ ...eth1, up: false, port: 2, newPort: false },
		]);
		expect(effectsOf(s, linkEvent(s, false, eth1))).toEqual([
			{ type: "link/set", port: 2, ...eth1, up: false, cause: "bar" },
			{ type: "announce", text: "node1:eth1 link down" },
		]);
		s = run(s, linkEvent(s, false, eth1));
		expect(machine(s, "node1").life).toMatchObject({
			plugs: [{ link: "up" }, { link: "cut" }, { kind: "none" }],
		});
		expect(planLink(s, ["node1"], true)).toEqual([
			{ ...eth1, up: true, port: 2, newPort: false },
			{ machine: "node1", nic: 2, up: true, port: 3, newPort: true },
		]);
		expect(planLink(s, [{ machine: "node1", nic: 3 }], true)).toEqual([]);
	});

	test("cannot plug in more NICs than the switch has ports free", () => {
		let s = labWith(6);
		s = run(s, spawnEvent(s, 1, { net: ["none", "none", "none"] }), isReady("node7"));
		expect(planLink(s, ["node7"], true)).toEqual({ kind: "no-ports", free: 2, wanted: 3 });
	});
});
