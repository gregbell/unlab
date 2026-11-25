import { expect, test } from "vitest";
import { ping } from "../../test/support/frames.ts";
import {
	type CommandEvent,
	createStore,
	initialState,
	isNameFault,
	type MachineName,
	parseChosenName,
	parseSwitchName,
	planSpawn,
	planSwitch,
	type SwitchName,
	selectNames,
} from "../model/index.ts";
import { followLab } from "./follow.ts";
import { createCaptureLog } from "./log.ts";

const lan = parseSwitchName("lan") as SwitchName;

function lab() {
	const images = [{ name: "alpine", label: "alpine 3.24" }];
	const store = createStore(initialState(images, { width: 1300, height: 500 }), () => {});
	const log = createCaptureLog({ schedule: (fn) => fn(), now: () => 0, names: () => selectNames(store.state) });
	followLab(log, store);
	const command = (event: CommandEvent) => store.dispatchCommand(event);
	return {
		log,
		filter: (filter: string) => store.dispatchUi({ type: "ui/capture-filter", filter }),
		pause: (paused: boolean) => store.dispatchUi({ type: "ui/capture-pause", paused }),
		spawn(text: string): MachineName {
			const name = parseChosenName(text);
			if (isNameFault(name)) throw new Error(name.kind);
			const plan = planSpawn(store.state, 1, {
				image: "alpine",
				name,
				memMiB: 256,
				disks: { root: "4", extra: [] },
				gateway: false,
				nics: [{ net: "none", address: "default" }],
			});
			if ("kind" in plan) throw new Error(plan.kind);
			command({ type: "cmd/spawn", plan, at: 0 });
			return name;
		},
		remove(machine: MachineName) {
			const attempt = store.state.machines[machine]?.life.attempt ?? 0;
			command({ type: "cmd/remove", machines: [machine], cause: "bar" });
			store.dispatchRuntime({ type: "vm/stopped", machine, attempt, clean: true, at: 0 });
		},
		addSwitch(name: SwitchName) {
			const plan = planSwitch(store.state, name);
			if ("kind" in plan) throw new Error(plan.kind);
			command({ type: "cmd/switch-add", plan });
		},
		removeSwitch: (name: SwitchName) => command({ type: "cmd/switch-remove", switch: name, cause: "bar" }),
		frame: (on: SwitchName, from: number, to: number) =>
			log.appendFrame({ switch: on, from: 1, to: 2, flood: null, frame: ping(from, to) }),
		shown: () => log.window(0, log.matchCount).map(({ seq }) => seq),
	};
}

test("a name that was a machine's is a switch's once one takes it, in a filter that is set already", () => {
	const l = lab();
	const machine = l.spawn("lan");
	l.frame("switch0", 1, 2);
	l.frame("switch0", 2, 3);
	l.filter("lan");
	expect(l.shown()).toEqual([1]);
	l.remove(machine);
	expect(l.shown()).toEqual([1]);
	l.addSwitch(lan);
	expect(l.shown()).toEqual([]);
	l.frame(lan, 2, 3);
	expect(l.shown()).toEqual([3]);
});

test("a switch that is gone keeps its name, its cables and its frames, until a machine takes the name", () => {
	const l = lab();
	l.addSwitch(lan);
	l.frame(lan, 2, 3);
	l.frame("switch0", 2, 3);
	l.removeSwitch(lan);
	for (const filter of ["lan", "lan:1", "lan:2"]) {
		l.filter(filter);
		expect(l.shown(), filter).toEqual([1]);
	}
	l.filter("lan:3");
	expect(l.shown()).toEqual([]);
	l.filter("lan");
	const machine = l.spawn("lan");
	expect(l.shown()).toEqual([]);
	l.frame("switch0", 1, 2);
	expect(l.shown()).toEqual([3]);
	// The machine was the last to have it.
	l.remove(machine);
	expect(l.shown()).toEqual([3]);
});

test("a name that nothing had is read once something takes it, and until then the filter before it stays", () => {
	const l = lab();
	l.frame("switch0", 1, 2);
	l.filter("arp");
	l.filter("lan");
	expect(l.shown()).toEqual([]);
	l.filter("");
	expect(l.shown()).toEqual([1]);
	l.filter("lan");
	expect(l.shown()).toEqual([1]);
	l.addSwitch(lan);
	expect(l.shown()).toEqual([]);
	l.filter("");
	l.filter("web");
	expect(l.shown()).toEqual([1]);
	l.spawn("web");
	expect(l.shown()).toEqual([]);
});

test("pausing the lab's capture pauses the log", () => {
	const l = lab();
	l.pause(true);
	l.frame("switch0", 1, 2);
	expect(l.shown()).toEqual([]);
	l.pause(false);
	l.frame("switch0", 1, 2);
	expect(l.shown()).toHaveLength(1);
});
