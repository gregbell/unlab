import { describe, expect, test } from "vitest";
import { createStore, type Store } from "./store.ts";
import { agentCall, emptyLab, isReady, labWith, remove, spawnEvent } from "./testkit.ts";
import type { Effect, LabState } from "./types.ts";

const noEffects = (): void => {};
const tag = (effect: Effect): string => ("machine" in effect ? `${effect.type} ${effect.machine}` : effect.type);

/** A store whose effects go to `react`, which gets the store too, so it can answer like a runtime would. */
function wired(initial: LabState, react: (effect: Effect, store: Store) => void): Store {
	const store: Store = createStore(initial, (effect) => react(effect, store));
	return store;
}

describe("dispatch", () => {
	test("reduces synchronously, so a caller reads its own result on the next line", () => {
		const store = createStore(emptyLab(), noEffects);
		expect(store.state.rail).toEqual([]);
		store.dispatchCommand(spawnEvent(store.state, 2));
		expect(store.state.rail).toEqual(["node1", "node2"]);
		store.dispatchRuntime(isReady("node1"));
		expect(store.state.machines.node1?.life.phase).toBe("ready");
	});

	test("each producer's dispatcher works as a bare function", () => {
		const store = createStore(emptyLab(), noEffects);
		const { dispatchRuntime, dispatchCommand, dispatchUi, dispatchAgent } = store;
		dispatchUi({ type: "ui/agent-panel", open: true });
		dispatchRuntime({ type: "tick", now: 5 });
		dispatchCommand({ type: "cmd/capture", filter: "arp" });
		dispatchAgent({ type: "agent/call", call: agentCall(1, 5) });
		expect(store.state).toMatchObject({
			agentPanel: true,
			now: 5,
			capture: { filter: "arp" },
			agent: { firstCallAt: 5 },
		});
	});

	test("the effects of one event run in the order the reducer gave them", () => {
		const ran: string[] = [];
		const store = createStore(labWith(2), (effect) => ran.push(tag(effect)));
		store.dispatchCommand(remove("node2", "node1"));
		expect(ran).toEqual(["link/set node2", "vm/stop node2", "link/set node1", "vm/stop node1"]);
	});
});

describe("subscribers", () => {
	test("are told synchronously after each commit, before the effects run, and see the new state", () => {
		const order: string[] = [];
		const store = createStore(emptyLab(), (effect) => order.push(effect.type));
		store.subscribe(() => order.push(`told: ${store.state.rail.length} machines`));
		store.dispatchCommand(spawnEvent(store.state, 1, { net: "none" }));
		expect(order).toEqual(["told: 1 machines", "screen/create", "vm/boot", "clock"]);
	});

	test("are not told about an event that changed nothing", () => {
		let told = 0;
		const store = createStore(labWith(1), noEffects);
		store.subscribe(() => told++);
		store.dispatchRuntime(isReady("node1"));
		store.dispatchRuntime({ type: "vm/stopped", machine: "node9", attempt: 1, clean: true, at: 0 });
		store.dispatchUi({ type: "ui/view", view: "lab" });
		expect(told).toBe(0);
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		expect(told).toBe(1);
	});

	test("an event that changes nothing still runs its effects", () => {
		const ran: string[] = [];
		const store = createStore(emptyLab(), (effect) => ran.push(effect.type));
		store.dispatchUi({ type: "ui/capture-clear" });
		expect(ran).toEqual(["capture/clear"]);
	});

	test("stop hearing once unsubscribed, even part-way through a round", () => {
		const heard: string[] = [];
		const store = createStore(emptyLab(), noEffects);
		const stopSecond = { now: (): void => {} };
		store.subscribe(() => {
			heard.push("first");
			stopSecond.now();
		});
		stopSecond.now = store.subscribe(() => heard.push("second"));
		const stopThird = store.subscribe(() => heard.push("third"));
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		expect(heard).toEqual(["first", "third"]);
		stopThird();
		stopThird();
		store.dispatchUi({ type: "ui/view", view: "lab" });
		expect(heard).toEqual(["first", "third", "first"]);
	});

	test("the same function subscribed twice is told twice, and each subscription ends on its own", () => {
		let told = 0;
		const listener = (): void => {
			told++;
		};
		const store = createStore(emptyLab(), noEffects);
		const stop = store.subscribe(listener);
		store.subscribe(listener);
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		expect(told).toBe(2);
		stop();
		store.dispatchUi({ type: "ui/view", view: "lab" });
		expect(told).toBe(3);
	});
});

describe("re-entrant dispatch", () => {
	test("an effect that dispatches is queued: effect order equals event order", () => {
		const log: string[] = [];
		const store = wired(labWith(2), (effect, s) => {
			log.push(tag(effect));
			if (effect.type === "vm/stop")
				s.dispatchRuntime({ type: "vm/stopped", machine: effect.machine, attempt: effect.attempt, clean: true, at: 0 });
		});
		store.subscribe(() => log.push(`told: ${store.state.rail.join(",") || "empty"}`));

		store.dispatchCommand(remove("node1", "node2"));

		expect(log).toEqual([
			"told: node1,node2",
			"link/set node1",
			"vm/stop node1",
			"link/set node2",
			"vm/stop node2",
			"told: node2",
			"port/detach",
			"screen/dispose",
			"disks/delete",
			"hosts/publish",
			"announce",
			"told: empty",
			"port/detach",
			"screen/dispose",
			"disks/delete",
			"hosts/publish",
			"announce",
		]);
		expect(store.state.rail).toEqual([]);
	});

	test("events dispatched while one is in flight run first in, first out", () => {
		const seen: string[] = [];
		const store = wired(emptyLab(), (effect, s) => {
			if (effect.type !== "capture/clear") return;
			s.dispatchUi({ type: "ui/capture-filter", filter: "first" });
			s.dispatchUi({ type: "ui/capture-filter", filter: "second" });
			seen.push(`after queueing: ${s.state.capture.filter || "unset"}`);
		});
		store.subscribe(() => seen.push(`told: ${store.state.capture.filter}`));
		store.dispatchUi({ type: "ui/capture-clear" });
		expect(seen).toEqual(["after queueing: unset", "told: first", "told: second"]);
	});

	test("a subscriber that dispatches does not jump ahead of the current event's effects", () => {
		const log: string[] = [];
		const store = createStore(emptyLab(), (effect) => log.push(effect.type));
		store.subscribe(() => {
			log.push(`told: ${store.state.view}`);
			if (store.state.rail.length === 1 && store.state.view === "lab")
				store.dispatchUi({ type: "ui/view", view: "spawn" });
		});
		store.dispatchCommand(spawnEvent(store.state, 1, { net: "none" }));
		expect(log).toEqual(["told: lab", "screen/create", "vm/boot", "clock", "told: spawn"]);
	});
});

describe("until", () => {
	const gone = (state: LabState): boolean => state.rail.length === 0;

	test("resolves at once with the current state when the predicate already holds", async () => {
		const store = createStore(emptyLab(), noEffects);
		await expect(store.until(gone, new AbortController().signal)).resolves.toBe(store.state);
	});

	test("resolves with the state of the commit that makes the predicate hold", async () => {
		const store = createStore(labWith(1), noEffects);
		let checks = 0;
		const waiting = store.until((state) => {
			checks++;
			return gone(state);
		}, new AbortController().signal);
		store.dispatchCommand(remove("node1"));
		store.dispatchRuntime({ type: "vm/stopped", machine: "node1", attempt: 1, clean: true, at: 0 });
		const settledWith = store.state;
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await expect(waiting).resolves.toBe(settledWith);
		expect(checks).toBe(3);
	});

	test("rejects with the signal's reason on abort, and stops watching", async () => {
		const store = createStore(labWith(1), noEffects);
		const abort = new AbortController();
		let checks = 0;
		const waiting = store.until((state) => {
			checks++;
			return gone(state);
		}, abort.signal);
		const reason = new Error("the agent gave up");
		abort.abort(reason);
		await expect(waiting).rejects.toBe(reason);
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		expect(checks).toBe(1);
	});

	test("rejects at once when the signal is already aborted, without consulting the predicate", async () => {
		const store = createStore(emptyLab(), noEffects);
		let checks = 0;
		const waiting = store.until(
			() => {
				checks++;
				return true;
			},
			AbortSignal.abort(new Error("too late")),
		);
		await expect(waiting).rejects.toThrow("too late");
		expect(checks).toBe(0);
	});

	test("a predicate that throws rejects its own wait and no one else's", async () => {
		const store = createStore(emptyLab(), noEffects);
		const signal = new AbortController().signal;
		const broken = store.until((state) => {
			if (state.view === "spawn") throw new Error("bad predicate");
			return false;
		}, signal);
		const fine = store.until((state) => state.view === "spawn", signal);
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await expect(broken).rejects.toThrow("bad predicate");
		await expect(fine).resolves.toMatchObject({ view: "spawn" });
	});
});

describe("a throwing subscriber or effect", () => {
	test("does not stop the others, and the error surfaces once the store has finished", () => {
		const ran: string[] = [];
		const store = createStore(labWith(1), (effect) => {
			ran.push(effect.type);
			if (effect.type === "link/set") throw new Error("the switch broke");
		});
		store.subscribe(() => {
			throw new Error("a pane broke");
		});
		store.subscribe(() => ran.push("told"));

		let thrown: unknown;
		try {
			store.dispatchCommand(remove("node1"));
		} catch (error) {
			thrown = error;
		}
		expect(ran).toEqual(["told", "link/set", "vm/stop"]);
		expect(store.state.machines.node1?.life.phase).toBe("removing");
		expect(thrown).toBeInstanceOf(AggregateError);
		expect(thrown).toMatchObject({ errors: [{ message: "a pane broke" }, { message: "the switch broke" }] });
	});

	test("a single error is thrown as itself, and the store keeps working afterwards", () => {
		const failure = new Error("no such screen");
		let fail = true;
		const store = createStore(emptyLab(), () => {
			if (fail) throw failure;
		});
		expect(() => store.dispatchUi({ type: "ui/capture-clear" })).toThrow(failure);
		fail = false;
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		expect(store.state.view).toBe("spawn");
	});
});

describe("a notification schedule", () => {
	test("coalesces subscriber notifications into one flush, without delaying effects or until", async () => {
		const pending: (() => void)[] = [];
		const ran: string[] = [];
		const store = createStore(
			emptyLab(),
			(effect) => ran.push(effect.type),
			(flush) => pending.push(flush),
		);
		let told = 0;
		store.subscribe(() => told++);
		const waiting = store.until((state) => state.rail.length === 2, new AbortController().signal);

		store.dispatchCommand(spawnEvent(store.state, 2, { net: "none" }));
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		store.dispatchRuntime({ type: "tick", now: 100 });

		expect(ran).toEqual(["screen/create", "vm/boot", "screen/create", "vm/boot", "clock"]);
		await expect(waiting).resolves.toMatchObject({ rail: ["node1", "node2"] });
		expect(told).toBe(0);
		expect(pending).toHaveLength(1);

		pending.splice(0).forEach((flush) => {
			flush();
		});
		expect(told).toBe(1);

		store.dispatchUi({ type: "ui/view", view: "lab" });
		expect(pending).toHaveLength(1);
	});

	test("a schedule that throws once does not stop later notifications", () => {
		const pending: (() => void)[] = [];
		let broken = true;
		const store = createStore(emptyLab(), noEffects, (flush) => {
			if (broken) throw new Error("no animation frame");
			pending.push(flush);
		});
		let told = 0;
		store.subscribe(() => told++);
		expect(() => store.dispatchUi({ type: "ui/view", view: "spawn" })).toThrow("no animation frame");
		expect(store.state.view).toBe("spawn");
		broken = false;
		store.dispatchUi({ type: "ui/view", view: "lab" });
		pending.splice(0).forEach((flush) => {
			flush();
		});
		expect(told).toBe(1);
	});
});
