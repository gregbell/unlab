import { describe, expect, test } from "vitest";
import { disksOf } from "./disks.ts";
import { savingOf, takenPorts } from "./machines.ts";
import { selectDetails, selectRail, selectStatus } from "./selectors.ts";
import {
	bootEvent,
	checkpoint,
	checkpointed,
	effectsOf,
	hasFailed,
	hasHalted,
	hasStopped,
	IMAGES,
	isReady,
	isRestored,
	isSaved,
	labWith,
	machine,
	power,
	remove,
	restoreEvent,
	run,
	spawnEvent,
	WIDE,
} from "./testkit.ts";
import type { LabState, RuntimeEvent } from "./types.ts";
import { initialState, update } from "./update.ts";
import { restoreWorkspace, saveWorkspace } from "./workspace.ts";

const progress = (set: number, percent: number, attempt = 1): RuntimeEvent => ({
	type: "checkpoint/progress",
	machine: "node1",
	attempt,
	set,
	percent,
});
const unsaved = (set: number): RuntimeEvent => ({
	type: "checkpoint/unsaved",
	machine: "node1",
	attempt: 1,
	set,
	reason: "Browser storage is full.",
});

/** A ready node1 with checkpoints `before` (set 1) and `after` (set 2). */
function twoSaved(): LabState {
	return run(
		labWith(2),
		checkpoint("node1", "before"),
		isSaved("node1", 1, 1, 3 * 2 ** 20),
		checkpoint("node1", "after"),
		isSaved("node1", 2, 1, 2 ** 20),
	);
}

const details = (s: LabState, label: string) => selectDetails(s)?.rows.find((row) => row.label === label)?.value;
const focused = (s: LabState): LabState => run(s, { type: "cmd/focus", target: "node1", mode: "plain" });

describe("saving a checkpoint", () => {
	test("copies the live disks to a new set, and the checkpoint is there once it is whole", () => {
		const s = labWith(1);
		expect(effectsOf(s, checkpoint("node1", "before"))).toContainEqual({
			type: "checkpoint/save",
			copy: {
				machine: "node1",
				attempt: 1,
				n: 1,
				extras: disksOf(machine(s, "node1").spec).length - 1,
				checkpoint: "before",
				from: 0,
				to: 1,
			},
		});
		let saving = run(s, checkpoint("node1", "before"));
		expect(machine(saving, "node1").sets).toEqual({ live: 0, next: 2, checkpoints: [] });
		saving = focused(run(saving, progress(1, 40)));
		expect(details(saving, "checkpoints")).toBe("saving before 40%");
		expect(machine(saving, "node1").life.phase).toBe("ready");

		const saved = run(saving, isSaved("node1", 1, 1, 12.5 * 2 ** 20));
		expect(machine(saved, "node1").sets.checkpoints).toEqual([{ name: "before", set: 1, bytes: 12.5 * 2 ** 20 }]);
		expect(savingOf(machine(saved, "node1").life)).toBeNull();
		expect(details(saved, "checkpoints")).toBe("before 12.5 MiB");
		expect(details(focused(twoSaved()), "checkpoints")).toBe("before 3.0 MiB, after 1.0 MiB · 4.0 MiB in all");
		expect(details(focused(labWith(1)), "checkpoints")).toBeUndefined();
	});

	test("one that could not be saved leaves the machine as it was, says why, and its number is not used again", () => {
		let s = focused(run(labWith(1), checkpoint("node1", "before"), unsaved(1)));
		expect(machine(s, "node1")).toMatchObject({
			life: { phase: "ready" },
			sets: { live: 0, next: 2, checkpoints: [] },
		});
		expect(selectDetails(s)?.reason).toBe("Browser storage is full.");
		s = run(s, checkpoint("node1", "before"));
		expect(selectDetails(s)?.reason).toBeNull();
		expect(savingOf(machine(s, "node1").life)).toMatchObject({ set: 2 });
		expect(update(s, isSaved("node1", 1)).state, "late news of the first").toBe(s);
		expect(update(s, unsaved(1)).state).toBe(s);
	});

	test("one at a time, under a name the machine does not have, and no stop or boot under it", () => {
		const s = twoSaved();
		expect(update(s, checkpoint("node1", "after")).state).toBe(s);
		expect(update(s, checkpoint("node2", "after")).state).not.toBe(s);
		const saving = run(s, checkpoint("node1", "third"));
		for (const event of [
			checkpoint("node1", "fourth"),
			power("off", "node1"),
			power("reboot", "node1"),
			{ type: "cmd/restore", plan: { machine: "node1", set: 1, ports: [1] } } as const,
		]) {
			expect(update(saving, event).state).toBe(saving);
		}
		let off = run(s, power("off", "node1"), hasStopped("node1"), checkpoint("node1", "third"));
		expect(machine(off, "node1").life).toMatchObject({ phase: "off", saving: { set: 3 } });
		const plan = { machine: "node1", ports: [1] } as const;
		expect(update(off, { type: "cmd/boot", machines: [plan], at: 0 }).state).toBe(off);
		off = run(off, isSaved("node1", 3));
		expect(machine(run(off, bootEvent(off, "node1")), "node1").life.phase).toBe("booting");
	});

	test("ends with the guest, and what it goes on to say is ignored", () => {
		const saving = run(labWith(1), checkpoint("node1", "before"));
		for (const event of [hasHalted("node1", "off"), hasFailed("node1"), remove("node1")]) {
			const ended = run(saving, event);
			expect(savingOf(machine(ended, "node1").life)).toBeNull();
			expect(update(ended, isSaved("node1", 1)).state).toBe(ended);
		}
	});
});

describe("going back to a checkpoint", () => {
	test("drops the guest, copies the checkpoint to a new set, and boots from it once it is whole", () => {
		const s = run(twoSaved(), { type: "cmd/shell", machine: "node1" });
		const { state: back, effects } = update(s, restoreEvent(s, "node1", 1));
		expect(effects.map((e) => e.type)).toEqual([
			"link/set",
			"vm/stop",
			"screen/dispose",
			"announce",
			"checkpoint/restore",
		]);
		expect(effects).toContainEqual({ type: "vm/stop", machine: "node1", attempt: 2, how: "drop" });
		expect(effects).toContainEqual({
			type: "announce",
			text: "node1 going back to checkpoint before. sh1 closed with it.",
		});
		expect(effects.at(-1)).toMatchObject({ copy: { checkpoint: "before", from: 1, to: 3, attempt: 2 } });
		expect(machine(back, "node1")).toMatchObject({
			sessions: ["node1:console"],
			sets: { live: 0, next: 4 },
			life: { phase: "restoring", plugs: [{ port: 1 }] },
		});
		expect([...takenPorts(back)]).toEqual([1, 2]);
		const going = focused(run(back, progress(3, 40, 2)));
		expect(selectRail(going)[0].word).toBe("restoring 40%");
		expect(selectStatus(going).left[0].text).toBe("1 of 2 machines ready, 1 restoring");
		expect(details(going, "link")).toBe("plugged into port 1");
		for (const late of [hasStopped("node1", 2), hasStopped("node1", 1), hasFailed("node1", 1), isReady("node1", 1)]) {
			expect(update(going, late).state, "of the guest that was dropped").toBe(going);
		}

		const { state: booting, effects: then } = update(going, isRestored("node1", 3));
		expect(machine(booting, "node1")).toMatchObject({
			life: { phase: "booting", attempt: 3, plugs: [{ port: 1, link: "up" }] },
			sets: { live: 3, next: 4, checkpoints: [{ name: "before" }, { name: "after" }] },
		});
		expect(then.slice(0, 3).map((e) => e.type)).toEqual(["screen/note", "disks/delete", "vm/boot"]);
		expect(then).toContainEqual({ type: "disks/delete", n: 1, sets: [0] });
		expect(then[2]).toMatchObject({ attempt: 3, config: { set: 3 } });
		expect(effectsOf(booting, isReady("node1", 3))).toContainEqual(
			expect.objectContaining({ type: "link/set", port: 1, up: true, cause: "power" }),
		);
	});

	test("that fails leaves the disks as they were, and the machine boots on them or goes back again", () => {
		let s = twoSaved();
		s = run(s, restoreEvent(s, "node1", 1), hasFailed("node1", 2, "Browser storage is full."));
		expect(machine(s, "node1")).toMatchObject({
			life: { phase: "failed", reason: "Browser storage is full." },
			sets: { live: 0 },
		});
		expect([...takenPorts(s)]).toEqual([2]);
		const boot = effectsOf(s, bootEvent(s, "node1")).find((e) => e.type === "vm/boot");
		expect(boot).toMatchObject({ attempt: 3, config: { set: 0 } });

		const taken = run(s, spawnEvent(s, 1));
		const again = effectsOf(taken, restoreEvent(taken, "node1", 2));
		expect(again).toContainEqual({ type: "port/attach", port: 3, machine: "node1", nic: 0 });
		expect(again.at(-1)).toMatchObject({ type: "checkpoint/restore", copy: { from: 2, to: 4 } });
	});

	test("is not planned for a checkpoint that is gone, and one that is gone back to cannot be deleted", () => {
		const s = twoSaved();
		const event = restoreEvent(s, "node1", 1);
		const gone = run(s, { type: "cmd/forget", machine: "node1", set: 1 });
		expect(update(gone, event).state).toBe(gone);
		expect(effectsOf(s, { type: "cmd/forget", machine: "node1", set: 1 })).toContainEqual({
			type: "disks/delete",
			n: 1,
			sets: [1],
		});
		const back = run(s, event);
		expect(update(back, { type: "cmd/forget", machine: "node1", set: 1 }).state).toBe(back);
		expect(machine(run(back, { type: "cmd/forget", machine: "node1", set: 2 }), "node1").sets.checkpoints).toHaveLength(
			1,
		);
	});
});

test("a machine's every set is deleted with it, those that were never finished too", () => {
	let s = run(twoSaved(), checkpoint("node1", "cut"), remove("node1"));
	expect(effectsOf(s, hasStopped("node1"))).toContainEqual({ type: "disks/delete", n: 1, sets: [0, 1, 2, 3] });
	s = twoSaved();
	s = run(s, restoreEvent(s, "node1", 1), remove("node1"));
	expect(effectsOf(s, hasStopped("node1", 2))).toContainEqual({ type: "disks/delete", n: 1, sets: [0, 1, 2, 3] });
});

describe("a reload", () => {
	const reloaded = (s: LabState) => restoreWorkspace(initialState(IMAGES, WIDE), saveWorkspace(s));

	test("keeps the checkpoints and the live set, and forgets one that was being saved", () => {
		let s = twoSaved();
		s = run(s, restoreEvent(s, "node1", 1), isRestored("node1", 3), isReady("node1", 3), checkpoint("node1", "cut"));
		const { state, effects } = reloaded(s);
		expect(machine(state, "node1")).toMatchObject({
			life: { phase: "booting" },
			sets: {
				live: 3,
				next: 5,
				checkpoints: [
					{ name: "before", set: 1 },
					{ name: "after", set: 2 },
				],
			},
		});
		expect(effects.find((e) => e.type === "vm/boot")).toMatchObject({ machine: "node1", config: { set: 3 } });
	});

	test("goes on with a restore from the start, on another set, and boots nothing before it", () => {
		let s = twoSaved();
		s = run(s, restoreEvent(s, "node1", 1));
		const { state, effects } = reloaded(s);
		expect(machine(state, "node1")).toMatchObject({
			life: { phase: "restoring", plugs: [{ port: 1 }] },
			sets: { live: 0, next: 5 },
		});
		expect(effects.flatMap((e) => (e.type === "vm/boot" ? [e.machine] : []))).toEqual(["node2"]);
		expect(effects).toContainEqual(expect.objectContaining({ type: "port/attach", port: 1, machine: "node1" }));
		expect(effects).toContainEqual(
			expect.objectContaining({ type: "checkpoint/restore", copy: expect.objectContaining({ from: 1, to: 4 }) }),
		);
	});

	test.each<[string, object]>([
		["no sets", { sets: undefined }],
		["a set that was never given out", { sets: { live: 3, next: 3, checkpoints: [] } }],
		[
			"a checkpoint that is the live set",
			{ sets: { live: 1, next: 3, checkpoints: [{ name: "a", set: 1, bytes: 1 }] } },
		],
		[
			"two of one name",
			{ sets: { live: 0, next: 3, checkpoints: [1, 2].map((set) => ({ name: "a", set, bytes: 1 })) } },
		],
		["a name that is none", { sets: { live: 0, next: 3, checkpoints: [{ name: "A b", set: 1, bytes: 1 }] } }],
		["a restore of nothing", { restore: 2 }],
	])("with %s is not read", (_, fields) => {
		const saved = JSON.parse(saveWorkspace(labWith(1)));
		saved.nodes[0] = { ...saved.nodes[0], ...fields };
		expect(() => restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify(saved))).toThrow("could not be read");
	});

	test("of a lab saved before there were checkpoints finds each machine's disks where they were", () => {
		const saved = JSON.parse(saveWorkspace(labWith(1)));
		delete saved.nodes[0].sets;
		const { state } = restoreWorkspace(initialState(IMAGES, WIDE), JSON.stringify({ ...saved, version: 5 }));
		expect(machine(state, "node1").sets).toEqual({ live: 0, next: 1, checkpoints: [] });
	});
});

test("a checkpoint's name is spelled as a machine's is, and may be a word", () => {
	for (const name of ["before", "all", "node1", "a-1", "a".repeat(63)]) expect(checkpointed(name)).toBe(name);
	for (const name of ["", "Before", "1st", "a-", "a b", "a.b", "a".repeat(64)]) {
		expect(() => checkpointed(name)).toThrow("no checkpoint's name");
	}
});
