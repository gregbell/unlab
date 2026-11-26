import { describe, expect, test, vi } from "vitest";
import { testClock } from "../../test/support/clock.ts";
import { arpRequest, mac, ping, routedPing } from "../../test/support/frames.ts";
import { port0 } from "../../test/support/ports.ts";
import { createCaptureLog } from "../capture/index.ts";
import type { FileOutcome, GuestFile } from "../commands/index.ts";
import {
	type BootConfig,
	type DiskCopy,
	type Effect,
	type HostEntry,
	identity,
	type MachineName,
	type PortNo,
	type PortRef,
	parseCheckpointName,
	parseMachineName,
	parseSwitchName,
	type RuntimeEvent,
	type SessionId,
	type StopHow,
	type SwitchName,
} from "../model/index.ts";

import { defaultAddress } from "../net/index.ts";
import { createEngine, ExecRefused } from "./engine.ts";
import { Fabric } from "./fabric.ts";
import type { CopyJob, CopyReport } from "./protocol.ts";
import type { LineMark, MarkSource, Screen, ScreenIo, Screens } from "./screens.ts";
import { createShellTracker } from "./shell-tracker.ts";
import type { StartVm, Tty, Vm, VmBoot, VmRef, VmSink } from "./vm.ts";

const ESC = "\x1b";
const BEL = "\x07";
const bytes = (s: string) => new TextEncoder().encode(s);
const TOKEN = "00112233aabbccdd";
const prompt = (exit: number) =>
	`${ESC}]133;D;${exit};unlab=${TOKEN}${BEL}${ESC}]133;A;redraw=0;unlab=${TOKEN}${BEL}node1:~$ ${ESC}]133;B;unlab=${TOKEN}${BEL}`;
/** The terminal echoes Enter, the command prints nothing, and the shell is back with a status. */
const returns = (exit: number) => `\r\n${prompt(exit)}`;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const hostsOf = (...ns: number[]): HostEntry[] => ns.map((n) => ({ ip: `10.88.0.${10 + n}`, name: `node${n}` }));

function config(n: number, hosts: readonly HostEntry[] = hostsOf(n), image = "alpine"): BootConfig {
	return {
		identity: identity(n),
		spec: {
			image,
			memMiB: 256,
			disks: { root: "4", extra: [] },
			gateway: true,
			nics: [{ net: "switch0", address: defaultAddress(n) }],
		},
		set: 0,
		hosts,
	};
}

interface FakeMark extends LineMark {
	readonly line: string;
	ended: number;
}

interface FakeScreen extends Screen {
	readonly io: ScreenIo;
	readonly written: Uint8Array[];
	readonly made: FakeMark[];
	readonly notes: string[];
	text(): string;
	/** What the next mark's rows will read as. */
	printed: string;
	/** Whether the next mark's start has left the scrollback. */
	cut: boolean;
	resizeTo(cols: number, rows: number): void;
}

function fakeScreens() {
	const live = new Map<SessionId, FakeScreen>();
	const disposed: SessionId[] = [];
	const screens: Screens = {
		create(session, io) {
			const tracker = createShellTracker();
			const written: Uint8Array[] = [];
			const made: FakeMark[] = [];
			const notes: string[] = [];
			let size = { cols: 100, rows: 30 };
			const screen: FakeScreen = {
				session,
				io,
				written,
				made,
				notes,
				printed: "",
				cut: false,
				text: () => written.map((b) => new TextDecoder().decode(b)).join(""),
				get shell() {
					return tracker.phase;
				},
				expectPromptToken(token) {
					tracker.expectToken(token);
				},
				get size() {
					return size;
				},
				resizeTo(cols, rows) {
					size = { cols, rows };
					io.resize(cols, rows);
				},
				note(text) {
					notes.push(text);
				},
				write(b) {
					written.push(b);
					return tracker.scan(b);
				},
				submitted: () => tracker.submitted(),
				get expectsTypedAhead() {
					return tracker.expectsTypedAhead;
				},
				settle: () => tracker.settle(),
				mount: async () => {},
				setVisible() {},
				setFocused() {},
				beginMark(source: MarkSource, line: string) {
					const mark: FakeMark = {
						source,
						line,
						ended: 0,
						end() {
							mark.ended++;
						},
						output: () => ({ text: screen.printed, truncated: screen.cut }),
					};
					made.push(mark);
					return mark;
				},
				marks: () => [],
				subscribe: () => () => {},
				lastLines: () => "",
				readText: () => "",
			};
			live.set(session, screen);
			return screen;
		},
		get: (session) => live.get(session),
		dispose(session) {
			live.delete(session);
			disposed.push(session);
		},
	};
	const get = (session: SessionId): FakeScreen => {
		const s = live.get(session);
		if (!s) throw new Error(`no screen for ${session}`);
		return s;
	};
	return { screens, get, disposed };
}

interface FakeVm extends Vm {
	readonly boot: VmBoot;
	readonly ref: VmRef;
	readonly sink: VmSink;
	readonly sent: unknown[][];
	readonly stops: StopHow[];
	/** Let the teardown finish. */
	finishStop(clean?: boolean): void;
}

function fakeVms() {
	const started: FakeVm[] = [];
	const startVm: StartVm = (boot, sink) => {
		const sent: unknown[][] = [];
		const stopped = Promise.withResolvers<boolean>();
		const vm: FakeVm = {
			boot,
			sink,
			ref: { machine: boot.machine, attempt: boot.attempt },
			sent,
			stops: [],
			finishStop: (clean = true) => stopped.resolve(clean),
			write: (tty: Tty, data) => sent.push(["write", tty, data]),
			resize: (tty: Tty, cols, rows) => sent.push(["resize", tty, cols, rows]),
			openPty: (pty, cols, rows) => sent.push(["openPty", pty, cols, rows]),
			closePty: (pty) => sent.push(["closePty", pty]),
			reconfigure: (hosts) => sent.push(["reconfigure", hosts]),
			link: (target) => sent.push(["link", target]),
			checkpoint: (copy) => sent.push(["checkpoint", copy]),
			writeFile: (id, file) => sent.push(["writeFile", id, file]),
			deliver: (nic, frame) => sent.push(["deliver", nic, frame]),
			stop(how) {
				vm.stops.push(how);
				return stopped.promise;
			},
		};
		started.push(vm);
		return vm;
	};
	const of = (machine: MachineName, attempt?: number): FakeVm => {
		const vm = started.findLast(
			(v) => v.boot.machine === machine && (attempt === undefined || v.boot.attempt === attempt),
		);
		if (!vm) throw new Error(`${machine} was never started`);
		return vm;
	};
	return { startVm, started, of };
}

function setup() {
	const clock = testClock();
	const events: RuntimeEvent[] = [];
	const announced: string[] = [];
	const deleted: [n: number, ...sets: number[]][] = [];
	const copies: { job: CopyJob; report: (report: CopyReport) => void; dropped: boolean }[] = [];
	const imagesAsked: string[] = [];
	const intervals: { ms: number; fn: () => void; cancelled: boolean }[] = [];
	const made: Fabric[] = [];
	const fabric = (): Fabric => made[0];
	/** The first switch that a test names, which is switch0 in each. */
	const sw = {
		setLink: (port: PortNo, up: boolean) => fabric().setLink(0, port, up),
		isUp: (port: PortNo) => fabric().isUp(0, port),
	};
	const capture = createCaptureLog({ now: () => clock.now(), schedule: () => {} });
	const vms = fakeVms();
	const screens = fakeScreens();

	const engine = createEngine({
		store: { dispatchRuntime: (e) => events.push(e) },
		clock,
		newFabric(events) {
			made.push(new Fabric(events));
			return fabric();
		},
		capture,
		screens: screens.screens,
		startVm: vms.startVm,
		image(name) {
			imagesAsked.push(name);
			return Promise.resolve(new ArrayBuffer(4));
		},
		deleteDisks: (n, sets) => deleted.push([n, ...sets]),
		startCopy(job, report) {
			const copy = { job, report, dropped: false };
			copies.push(copy);
			return () => {
				copy.dropped = true;
			};
		},
		announce: (text) => announced.push(text),
		every(ms, fn) {
			const interval = { ms, fn, cancelled: false };
			intervals.push(interval);
			return () => {
				interval.cancelled = true;
			};
		},
		promptToken: () => TOKEN,
	});

	const run = (...effects: Effect[]) => {
		for (const e of effects) engine.run(e);
	};
	/** Spawn node<n> the way the reducer does: its console screen, then the boot. */
	const boot = (n: number, attempt = 1, hosts?: readonly HostEntry[]) => {
		const machine: MachineName = `node${n}`;
		run(
			{ type: "screen/create", session: `${machine}:console` },
			{ type: "vm/boot", machine, attempt, config: config(n, hosts) },
		);
		return vms.of(machine, attempt);
	};
	const ready = (n: number, attempt = 1, hosts?: readonly HostEntry[]) => {
		const vm = boot(n, attempt, hosts);
		vm.sink.ready(vm.ref, 3582);
		return vm;
	};
	/** A ready node<n> whose console sits at a prompt. */
	const atPrompt = (n: number) => {
		const vm = ready(n);
		vm.sink.consoleBytes(vm.ref, bytes(prompt(0)));
		events.length = 0;
		vm.sent.length = 0;
		return vm;
	};

	return {
		engine,
		run,
		boot,
		ready,
		atPrompt,
		events,
		announced,
		deleted,
		copies,
		imagesAsked,
		intervals,
		fabric,
		clock,
		sw,
		capture,
		vms,
		screens,
		at: (ms: number) => clock.at(ms),
		take: () => events.splice(0),
	};
}

const never = new AbortController().signal;

type Setup = ReturnType<typeof setup>;

describe("a name used again", () => {
	const web = parseMachineName("web") as MachineName;
	const bootWeb = (t: ReturnType<typeof setup>, n: number, attempt: number) => {
		t.run(
			{ type: "screen/create", session: `${web}:console` },
			{ type: "port/attach", port: port0(1), machine: web, nic: 0 },
			{ type: "vm/boot", machine: web, attempt, config: { ...config(n), identity: identity(n, web) } },
		);
		return t.vms.of(web, attempt);
	};

	test("nothing the removed machine says late is taken for the new one's", async () => {
		const t = setup();
		const old = bootWeb(t, 1, 1);
		old.sink.ready(old.ref, 10);
		t.run({ type: "screen/create", session: `${web}:sh1` }, { type: "pty/open", session: `${web}:sh1` });
		t.run({ type: "vm/stop", machine: web, attempt: 1, how: "drop" });
		old.finishStop();
		await settle();
		t.run(
			{ type: "port/detach", port: port0(1) },
			{ type: "screen/dispose", session: `${web}:console` },
			{ type: "screen/dispose", session: `${web}:sh1` },
			{ type: "disks/delete", n: 1, sets: [0] },
		);
		expect(t.deleted).toEqual([[1, 0]]);

		const next = bootWeb(t, 2, 2);
		t.run({ type: "screen/create", session: `${web}:sh1` }, { type: "pty/open", session: `${web}:sh1` });
		t.take();
		old.sink.stage(old.ref, "late");
		old.sink.ready(old.ref, 99);
		old.sink.consoleBytes(old.ref, bytes("late"));
		old.sink.ptyOpened(old.ref, 1);
		old.sink.ptyBytes(old.ref, 1, bytes("late"));
		old.sink.ptyExited(old.ref, 1, false);
		old.sink.frame(old.ref, 0, new Uint8Array(60));
		old.sink.failed(old.ref, "late");
		expect(t.take()).toEqual([]);
		expect(t.screens.get(`${web}:console`).text()).toBe("");
		expect(t.capture.counters.in).toBe(0);
		expect(t.deleted).toEqual([[1, 0]]);

		next.sink.ready(next.ref, 20);
		expect(t.take()).toEqual([{ type: "vm/ready", machine: "web", attempt: 2, bootMs: 20 }]);
	});
});

describe("vm/boot", () => {
	test("starts one vm for the attempt, with the image the spec names and the console's size", () => {
		const t = setup();
		const vm = t.boot(3);
		expect(t.vms.started).toHaveLength(1);
		expect(vm.boot).toMatchObject({ machine: "node3", attempt: 1, config: config(3), cols: 100, rows: 30 });
		expect(t.imagesAsked).toEqual(["alpine"]);
		expect(t.events).toEqual([]);
	});

	test("reports stages, ready and failure, stamped with the attempt", () => {
		const t = setup();
		const vm = t.boot(3, 2);
		vm.sink.stage(vm.ref, "kernel");
		vm.sink.ready(vm.ref, 3582);
		expect(t.take()).toEqual([
			{ type: "vm/stage", machine: "node3", attempt: 2, stage: "kernel" },
			{ type: "vm/ready", machine: "node3", attempt: 2, bootMs: 3582 },
		]);

		vm.sink.failed(vm.ref, "reboot: Power down");
		expect(t.take()).toEqual([{ type: "vm/failed", machine: "node3", attempt: 2, reason: "reboot: Power down" }]);
	});

	test("a newer attempt replaces the old vm, and nothing the old one says is reported", () => {
		const t = setup();
		const first = t.boot(3, 1);
		const second = t.boot(3, 2);
		expect(first.stops).toEqual(["save"]);
		expect(second.stops).toEqual([]);

		first.sink.stage(first.ref, "kernel");
		first.sink.ready(first.ref, 900);
		first.sink.failed(first.ref, "late");
		first.sink.consoleBytes(first.ref, bytes("late output"));
		expect(t.events).toEqual([]);
		expect(t.screens.get("node3:console").written).toEqual([]);

		second.sink.ready(second.ref, 1200);
		expect(t.take()).toEqual([{ type: "vm/ready", machine: "node3", attempt: 2, bootMs: 1200 }]);
	});

	test("a boot effect for an attempt that is not newer is ignored", () => {
		const t = setup();
		t.boot(3, 2);
		t.run({ type: "vm/boot", machine: "node3", attempt: 2, config: config(3) });
		t.run({ type: "vm/boot", machine: "node3", attempt: 1, config: config(3) });
		expect(t.vms.started).toHaveLength(1);
		expect(t.vms.of("node3").stops).toEqual([]);
	});
});

describe("vm/stop", () => {
	test("stops the vm and reports vm/stopped only once the teardown has finished", async () => {
		const t = setup();
		const vm = t.ready(3);
		t.take();

		t.run({ type: "vm/stop", machine: "node3", attempt: 1, how: "drop" });
		await settle();
		expect(vm.stops).toEqual(["drop"]);
		expect(t.events).toEqual([]);

		vm.finishStop();
		await settle();
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node3", attempt: 1, clean: true, at: 0 }]);
	});

	test("is idempotent: a repeat while stopping reports once, a repeat afterwards reports the end state again", async () => {
		const t = setup();
		const vm = t.ready(3);
		t.take();

		t.run(
			{ type: "vm/stop", machine: "node3", attempt: 1, how: "drop" },
			{ type: "vm/stop", machine: "node3", attempt: 1, how: "drop" },
		);
		vm.finishStop();
		await settle();
		expect(vm.stops).toEqual(["drop"]);
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node3", attempt: 1, clean: true, at: 0 }]);

		t.run({ type: "vm/stop", machine: "node3", attempt: 1, how: "drop" });
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node3", attempt: 1, clean: true, at: 0 }]);
	});

	test("a stop for a stale attempt leaves the current vm alone and reports nothing", async () => {
		const t = setup();
		t.boot(3, 1);
		const current = t.boot(3, 2);
		t.run({ type: "vm/stop", machine: "node3", attempt: 1, how: "drop" });
		await settle();
		expect(current.stops).toEqual([]);
		expect(t.events).toEqual([]);
	});

	test("a stopping vm is quiet, and its machine takes no more input", async () => {
		const t = setup();
		const vm = t.atPrompt(3);
		t.run({ type: "vm/stop", machine: "node3", attempt: 1, how: "drop" });
		vm.sink.failed(vm.ref, "powered off");
		vm.sink.consoleBytes(vm.ref, bytes("bye"));
		t.screens.get("node3:console").io.input("ls\r");
		expect(t.events).toEqual([]);
		expect(vm.sent).toEqual([]);
	});
});

describe("power", () => {
	const reboots = (t: ReturnType<typeof setup>) =>
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "reboot" });

	test("a guest that is shutting down is still heard and seen, and takes no more", () => {
		const t = setup();
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "link/set", port: port0(1), machine: "node1", nic: 0, up: true, cause: "runtime" },
		);
		const vm = t.atPrompt(1);
		reboots(t);
		expect(vm.stops).toEqual(["reboot"]);
		vm.sink.consoleBytes(vm.ref, bytes("The system is going down NOW!"));
		vm.sink.frame(vm.ref, 0, arpRequest(1, 2));
		expect(t.screens.get("node1:console").text()).toContain("The system is going down NOW!");
		expect(t.capture.counters.in).toBe(1);

		t.take();
		vm.sink.consoleBytes(vm.ref, bytes(prompt(0)));
		vm.sink.ptyExited(vm.ref, 1, true);
		vm.sink.halted(vm.ref, "off");
		vm.sink.nicLost(vm.ref, 1, "eth1 stopped: signal 15.");
		t.screens.get("node1:console").io.input("ls\r");
		expect(t.take()).toEqual([]);
		expect(vm.sent).toEqual([]);
	});

	test("says a guest went down by itself, with the shells it took away but not one that had exited", () => {
		const t = setup();
		const vm = t.atPrompt(1);
		for (const k of [1, 2, 3] as const) {
			t.run({ type: "screen/create", session: `node1:sh${k}` }, { type: "pty/open", session: `node1:sh${k}` });
			vm.sink.ptyOpened(vm.ref, k);
		}
		vm.sink.ptyExited(vm.ref, 1, false);
		vm.sink.ptyExited(vm.ref, 2, true);
		t.take();
		vm.sink.halted(vm.ref, "reboot");
		expect(t.take()).toEqual([
			{ type: "session/ended", session: "node1:sh3" },
			{ type: "vm/halted", machine: "node1", attempt: 1, next: "reboot", closed: ["node1:sh2"] },
		]);
	});

	test("a command that a power off or a reboot cut short says so", async () => {
		const t = setup();
		t.atPrompt(1);
		const asked = t.engine.exec.inject("node1:console", "sleep 100", "bar", never);
		reboots(t);
		await expect(asked).rejects.toThrow("node1 rebooted before the command returned.");
		const vm = t.atPrompt(2);
		const halted = t.engine.exec.inject("node2:console", "poweroff; sleep 100", "bar", never);
		vm.sink.halted(vm.ref, "off");
		await expect(halted).rejects.toThrow("node2 powered off before the command returned.");
	});

	test("reports the stop with how it went, and a drop hurries it without reporting it twice", async () => {
		const t = setup();
		const vm = t.ready(1);
		reboots(t);
		reboots(t);
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "drop" });
		expect(vm.stops).toEqual(["reboot", "drop"]);
		t.take();
		vm.finishStop(false);
		await settle();
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node1", attempt: 1, clean: false, at: 0 }]);
	});

	test("the next boot waits for the last one's disks, and starts its console over", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const screen = t.screens.get("node1:console");
		screen.io.input("half a li");
		vm.sink.failed(vm.ref, "Kernel panic.");
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "save" });
		t.run({ type: "vm/boot", machine: "node1", attempt: 2, config: config(1) });
		let released = false;
		void t.vms.of("node1", 2).boot.released.then(() => {
			released = true;
		});
		await settle();
		expect(released).toBe(false);
		vm.finishStop();
		await settle();
		expect(released).toBe(true);

		const next = t.vms.of("node1", 2);
		expect(screen.shell).toBe("unknown");
		next.sink.ready(next.ref, 1);
		next.sink.consoleBytes(next.ref, bytes(prompt(0)));
		void t.engine.exec.inject("node1:console", "true", "bar", never).catch(() => {});
		expect(next.sent).toEqual([["write", "console", "true\r"]]);
	});

	test("a note goes to the session's screen, if it has one", () => {
		const t = setup();
		t.boot(1);
		t.run({ type: "screen/note", session: "node1:console", text: "node1 is off." });
		t.run({ type: "screen/note", session: "node9:console", text: "nobody" });
		expect(t.screens.get("node1:console").notes).toEqual(["node1 is off."]);
	});
});

describe("ports and frames", () => {
	test("a port reserved at spawn carries nothing until its link comes up at ready", () => {
		const t = setup();
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
		);
		const a = t.ready(1);
		const b = t.ready(2);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(t.sw.isUp(1)).toBe(false);

		t.run(
			{ type: "link/set", port: port0(1), machine: "node1", nic: 0, up: true, cause: "runtime" },
			{ type: "link/set", port: port0(2), machine: "node2", nic: 0, up: true, cause: "runtime" },
		);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toHaveLength(1);
	});

	test("a frame from a plugged machine goes through the switch to its neighbour and into the capture log", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
		);
		t.sw.setLink(1, true);
		t.sw.setLink(2, true);

		const frame = arpRequest(1, 2);
		a.sink.frame(a.ref, 0, frame);

		expect(b.sent).toEqual([["deliver", 0, frame]]);
		expect(a.sent).toEqual([]);
		expect(t.capture.tail(1)).toMatchObject([
			{ kind: "frame", proto: "ARP", from: { kind: "machine", name: "node1" }, note: "flooded to port 2" },
		]);
		expect(t.engine.reads.macTable("switch0")).toMatchObject([{ mac: "52:54:00:88:00:0b", port: 1, flushed: false }]);
		expect(t.engine.reads.counters(port0(1))).toMatchObject({ rxFrames: 1 });
	});

	test("each NIC sends and receives on its own port", () => {
		const t = setup();
		const a = t.ready(1);
		const router = t.ready(2);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
			{ type: "port/attach", port: port0(3), machine: "node2", nic: 2 },
		);
		for (const port of [1, 2, 3] as const) t.sw.setLink(port, true);

		const asked = arpRequest(1, 2);
		a.sink.frame(a.ref, 0, asked);
		expect(router.sent).toEqual([
			["deliver", 0, asked],
			["deliver", 2, asked],
		]);

		const sent = routedPing(mac(2, 2), mac(1), 3, 1);
		router.sink.frame(router.ref, 2, sent);
		expect(a.sent).toEqual([["deliver", 0, sent]]);
		expect(t.engine.reads.macTable("switch0")).toContainEqual(
			expect.objectContaining({ mac: "52:54:00:88:02:0c", port: 3 }),
		);

		router.sink.frame(router.ref, 1, routedPing(mac(2, 1), mac(1), 3, 1));
		expect(a.sent).toHaveLength(1);
	});

	test("cutting one NIC's cable leaves the machine's other NIC connected", () => {
		const t = setup();
		const a = t.ready(1);
		const router = t.ready(2);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
			{ type: "port/attach", port: port0(3), machine: "node2", nic: 1 },
		);
		for (const port of [1, 2, 3] as const) t.sw.setLink(port, true);
		t.run({ type: "link/set", port: port0(3), machine: "node2", nic: 1, up: false, cause: "bar" });
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(router.sent.map((call) => call.slice(0, 2))).toEqual([["deliver", 0]]);
		router.sink.frame(router.ref, 1, routedPing(mac(2, 1), mac(1), 3, 1));
		expect(a.sent).toEqual([]);
		expect(t.capture.tail(1)).toMatchObject([{ kind: "frame", from: { name: "node1" } }]);
	});

	test("a port may be attached before its machine boots", () => {
		const t = setup();
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
		);
		t.sw.setLink(1, true);
		t.sw.setLink(2, true);
		const a = t.ready(1);
		const b = t.ready(2);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toHaveLength(1);
	});

	test("an unplugged machine's frames go nowhere", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run({ type: "port/attach", port: port0(2), machine: "node2", nic: 0 });
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(t.capture.size).toBe(0);
	});

	test("a detached port carries nothing, and attaching the same port twice is harmless", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
			{ type: "port/detach", port: port0(2) },
			{ type: "port/detach", port: port0(2) },
		);
		t.sw.setLink(1, true);
		t.sw.setLink(2, true);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(t.capture.tail(1)).toMatchObject([{ note: "flooded, no other port is up" }]);
	});

	test("a port handed to another machine delivers to the new one", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		const c = t.ready(3);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node3", nic: 0 },
		);
		t.sw.setLink(1, true);
		t.sw.setLink(2, true);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(c.sent).toHaveLength(1);
	});
});

describe("several switches", () => {
	const lan = parseSwitchName("lan") as SwitchName;
	/** node1 on port 1 of switch0, node2 on port 1 of lan, and node3 on port 2 of both. */
	const plugged = () => {
		const t = setup();
		const vms = [t.ready(1), t.ready(2), t.ready(3)] as const;
		const cables = [
			{ port: { switch: "switch0", port: 1 }, machine: "node1", nic: 0 },
			{ port: { switch: lan, port: 1 }, machine: "node2", nic: 0 },
			{ port: { switch: "switch0", port: 2 }, machine: "node3", nic: 0 },
			{ port: { switch: lan, port: 2 }, machine: "node3", nic: 1 },
		] as const;
		for (const cable of cables) {
			t.run({ type: "port/attach", ...cable }, { type: "link/set", ...cable, up: true, cause: "runtime" });
		}
		for (const vm of vms) vm.sent.length = 0;
		return { ...t, vms };
	};

	test("carry frames of their own: a broadcast on one reaches no machine on the other", () => {
		const { vms, capture } = plugged();
		const [vm1, vm2, vm3] = vms;
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 3));
		expect(vm2.sent).toEqual([]);
		expect(vm3.sent).toEqual([["deliver", 0, expect.any(Uint8Array)]]);
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		expect(vm1.sent).toEqual([]);
		expect(vm3.sent).toHaveLength(2);
		expect(vm3.sent[1]).toEqual(["deliver", 1, expect.any(Uint8Array)]);
		expect([...capture.frames()].map((e) => [e.switch, e.from, e.to])).toEqual([
			["switch0", 1, 0b10],
			["lan", 1, 0b10],
		]);
	});

	test("each have their own MAC table and counters", () => {
		const { vms, engine } = plugged();
		const [vm1, vm2] = vms;
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 3));
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		expect(engine.reads.macTable("switch0").map((e) => [e.mac, e.port])).toEqual([["52:54:00:88:00:0b", 1]]);
		expect(engine.reads.macTable(lan).map((e) => [e.mac, e.port])).toEqual([["52:54:00:88:00:0c", 1]]);
		expect(engine.reads.counters({ switch: "switch0", port: 1 })).toMatchObject({ rxFrames: 1 });
		expect(engine.reads.counters({ switch: lan, port: 1 })).toMatchObject({ rxFrames: 2 });
		expect(engine.reads.macTable(parseSwitchName("wan") as SwitchName)).toEqual([]);
	});

	test("count what each has carried, and what one had stays when its cables go", () => {
		const { vms, engine, run } = plugged();
		const [vm1, vm2] = vms;
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 3));
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		vm2.sink.frame(vm2.ref, 0, ping(2, 2));
		run({ type: "port/detach", port: { switch: lan, port: 1 } });
		expect(engine.reads.totals("switch0")).toEqual({ in: 1, delivered: 1, flooded: 1, dropped: 0 });
		expect(engine.reads.totals(lan)).toEqual({ in: 2, delivered: 1, flooded: 1, dropped: 0 });
		expect(engine.reads.totals(parseSwitchName("wan") as SwitchName)).toEqual({
			in: 0,
			delivered: 0,
			flooded: 0,
			dropped: 0,
		});
	});

	test("one that is removed lets go of its ports and its tap, and starts empty when it is added again", () => {
		const { vms, engine, run, capture } = plugged();
		const [, vm2, vm3] = vms;
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		run({ type: "switch/remove", switch: lan });
		expect(engine.reads.macTable(lan)).toEqual([]);
		expect(engine.reads.totals(lan)).toEqual({ in: 0, delivered: 0, flooded: 0, dropped: 0 });
		expect(engine.reads.counters({ switch: lan, port: 1 })).toBeUndefined();

		const before = capture.frameCount;
		vm3.sent.length = 0;
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		expect([capture.frameCount, vm3.sent]).toEqual([before, []]);

		const cable = { port: { switch: lan, port: 1 }, machine: "node2", nic: 0 } as const;
		run({ type: "port/attach", ...cable }, { type: "link/set", ...cable, up: true, cause: "runtime" });
		expect(engine.reads.macTable(lan)).toEqual([]);
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		expect(engine.reads.totals(lan)).toEqual({ in: 1, delivered: 0, flooded: 1, dropped: 0 });
		expect(capture.frameCount).toBe(before + 1);
		expect(vm3.sent).toEqual([]);
	});

	test("a NIC that moves from one to the other sends where its cable is, whichever end is done first", () => {
		const { vms, engine, run } = plugged();
		const [vm1] = vms;
		const to = { port: { switch: lan, port: 5 }, machine: "node1", nic: 0 } as const;
		run({ type: "port/attach", ...to }, { type: "link/set", ...to, up: true, cause: "bar" });
		run({ type: "port/detach", port: { switch: "switch0", port: 1 } });
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 3));
		expect(engine.reads.counters({ switch: lan, port: 5 })).toMatchObject({ rxFrames: 1 });
	});

	test("cut and free a port of one, and leave the other's port of that number as it was", () => {
		const { vms, engine, run, capture } = plugged();
		const [vm1, vm2, vm3] = vms;
		run({ type: "link/set", port: { switch: lan, port: 2 }, machine: "node3", nic: 1, up: false, cause: "bar" });
		expect(capture.entry(5)).toMatchObject({ kind: "link", port: { switch: "lan", port: 2 }, up: false });
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 3));
		expect(vm3.sent).toEqual([]);
		run({ type: "port/detach", port: { switch: lan, port: 1 } });
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 3));
		expect(vm3.sent).toEqual([["deliver", 0, expect.any(Uint8Array)]]);
		expect(engine.reads.counters({ switch: lan, port: 1 })).toBeUndefined();
		expect(engine.reads.counters({ switch: "switch0", port: 1 })).toMatchObject({ rxFrames: 1 });
	});
});

describe("link/set", () => {
	test("changes the switch link, then writes the capture row with its cause", () => {
		const t = setup();
		t.ready(1);
		t.ready(2);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
		);
		const setLink = vi.spyOn(t.fabric(), "setLink");
		const appendLink = vi.spyOn(t.capture, "appendLink");
		t.at(2500);

		t.run({ type: "link/set", port: port0(2), machine: "node2", nic: 0, up: false, cause: "agent" });

		expect(t.sw.isUp(2)).toBe(false);
		expect(t.capture.tail(1)).toEqual([
			{
				kind: "link",
				seq: 1,
				time: "2.50",
				port: 2,
				up: false,
				text: "port 2 link down",
				cause: "Cable to node2 cut by the agent.",
			},
		]);
		expect(setLink.mock.invocationCallOrder[0]).toBeLessThan(appendLink.mock.invocationCallOrder[0]);

		t.run({ type: "link/set", port: port0(2), machine: "node2", nic: 0, up: true, cause: "bar" });
		expect(t.sw.isUp(2)).toBe(true);
		expect(t.capture.tail(1)).toMatchObject([{ up: true, cause: "Cable to node2 reconnected by you." }]);
	});

	test("a cut machine's neighbour stops hearing it", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run(
			{ type: "port/attach", port: port0(1), machine: "node1", nic: 0 },
			{ type: "port/attach", port: port0(2), machine: "node2", nic: 0 },
			{ type: "link/set", port: port0(1), machine: "node1", nic: 0, up: false, cause: "button" },
		);
		a.sink.frame(a.ref, 0, ping(1, 2));
		expect(b.sent).toEqual([]);
	});
});

describe("sessions", () => {
	test("console bytes go to the console's screen, and the shell's phase is reported when it changes", () => {
		const t = setup();
		const vm = t.ready(1);
		t.take();
		const log = bytes("Welcome to Alpine Linux\r\n");
		vm.sink.consoleBytes(vm.ref, log);
		expect(t.screens.get("node1:console").written).toEqual([log]);
		expect(t.events).toEqual([]);

		vm.sink.consoleBytes(vm.ref, bytes(prompt(0)));
		vm.sink.consoleBytes(vm.ref, bytes(prompt(0)));
		expect(t.take()).toEqual([{ type: "session/shell", session: "node1:console", shell: "prompt" }]);
	});

	test("keys reach a ready machine's console, and Enter at a prompt reports running", () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const { io } = t.screens.get("node1:console");
		io.input("l");
		io.input("s");
		expect(t.events).toEqual([]);
		io.input("\r");
		expect(vm.sent).toEqual([
			["write", "console", "l"],
			["write", "console", "s"],
			["write", "console", "\r"],
		]);
		expect(t.take()).toEqual([{ type: "session/shell", session: "node1:console", shell: "running" }]);
	});

	test("a booting machine ignores keys", () => {
		const t = setup();
		const vm = t.boot(1);
		t.screens.get("node1:console").io.input("ls\r");
		expect(vm.sent).toEqual([]);
	});

	test("a resized screen resizes the guest's terminal", () => {
		const t = setup();
		const vm = t.ready(1);
		t.screens.get("node1:console").resizeTo(120, 40);
		expect(vm.sent).toEqual([["resize", "console", 120, 40]]);
	});

	test("pty/open opens the shell's pty at its screen's size and reports it open, bytes flow, and its exit ends the session", () => {
		const t = setup();
		const vm = t.ready(2);
		t.take();
		t.run({ type: "screen/create", session: "node2:sh1" });
		t.screens.get("node2:sh1").resizeTo(90, 20);
		vm.sent.length = 0;

		t.run({ type: "pty/open", session: "node2:sh1" });
		expect(vm.sent).toEqual([["openPty", 1, 90, 20]]);
		expect(t.events).toEqual([]);

		// The screen may have been fitted while the pty was opening, when the guest could not be told.
		t.screens.get("node2:sh1").resizeTo(81, 12);
		vm.sink.ptyOpened(vm.ref, 1);
		expect(vm.sent.slice(1)).toEqual([["resize", 1, 81, 12]]);
		expect(t.take()).toEqual([{ type: "session/opened", session: "node2:sh1" }]);

		const out = bytes(prompt(0));
		vm.sink.ptyBytes(vm.ref, 1, out);
		expect(t.screens.get("node2:sh1").written).toEqual([out]);
		expect(t.take()).toEqual([{ type: "session/shell", session: "node2:sh1", shell: "prompt" }]);

		t.screens.get("node2:sh1").io.input("exit\r");
		t.screens.get("node2:sh1").resizeTo(80, 24);
		expect(vm.sent.slice(2)).toEqual([
			["write", 1, "exit\r"],
			["resize", 1, 80, 24],
		]);
		t.take();

		vm.sink.ptyExited(vm.ref, 1, false);
		vm.sink.ptyExited(vm.ref, 1, false);
		expect(t.take()).toEqual([{ type: "session/ended", session: "node2:sh1" }]);
	});

	test("pty/close closes the pty and reports the session ended, once", () => {
		const t = setup();
		const vm = t.ready(2);
		t.run({ type: "screen/create", session: "node2:sh3" }, { type: "pty/open", session: "node2:sh3" });
		vm.sink.ptyOpened(vm.ref, 3);
		t.take();
		vm.sent.length = 0;

		t.run({ type: "pty/close", session: "node2:sh3" });
		expect(vm.sent).toEqual([["closePty", 3]]);
		expect(t.take()).toEqual([{ type: "session/ended", session: "node2:sh3" }]);

		vm.sink.ptyExited(vm.ref, 3, false);
		t.run({ type: "pty/close", session: "node2:sh3" });
		expect(t.events).toEqual([]);
	});

	test("a pty asked for on a machine with no vm ends at once", () => {
		const t = setup();
		t.run({ type: "screen/create", session: "node7:sh1" }, { type: "pty/open", session: "node7:sh1" });
		expect(t.take()).toEqual([{ type: "session/ended", session: "node7:sh1" }]);
	});

	test("a machine's failure ends its open shells before it is reported", () => {
		const t = setup();
		const vm = t.ready(2);
		t.run({ type: "screen/create", session: "node2:sh1" }, { type: "pty/open", session: "node2:sh1" });
		vm.sink.ptyOpened(vm.ref, 1);
		t.take();
		vm.sink.failed(vm.ref, "kernel panic");
		expect(t.take()).toEqual([
			{ type: "session/ended", session: "node2:sh1" },
			{ type: "vm/failed", machine: "node2", attempt: 1, reason: "kernel panic" },
		]);
	});

	test("screen/create and screen/dispose make and drop the session's screen", () => {
		const t = setup();
		t.run({ type: "screen/create", session: "node1:console" });
		const screen = t.engine.screens.get("node1:console");
		expect(screen).toBeDefined();
		t.run({ type: "screen/create", session: "node1:console" });
		expect(t.engine.screens.get("node1:console")).toBe(screen);

		t.run({ type: "screen/dispose", session: "node1:console" });
		expect(t.engine.screens.get("node1:console")).toBeUndefined();
		expect(t.screens.disposed).toEqual(["node1:console"]);
	});
});

describe("hosts/publish", () => {
	test("gives every ready vm the new table, and a vm that becomes ready later the latest one", () => {
		const t = setup();
		const a = t.ready(1, 1, hostsOf(1));
		const b = t.boot(2, 1, hostsOf(1, 2));
		expect(a.sent).toEqual([]);

		t.run({ type: "hosts/publish", hosts: hostsOf(1, 2) });
		expect(a.sent).toEqual([["reconfigure", hostsOf(1, 2)]]);
		expect(b.sent).toEqual([]);

		t.run({ type: "hosts/publish", hosts: hostsOf(1, 2, 3) });
		expect(a.sent.at(-1)).toEqual(["reconfigure", hostsOf(1, 2, 3)]);
		expect(b.sent).toEqual([]);

		b.sink.ready(b.ref, 2000);
		expect(b.sent).toEqual([["reconfigure", hostsOf(1, 2, 3)]]);
	});

	test("a vm that booted with the latest table is not configured again", () => {
		const t = setup();
		t.run({ type: "hosts/publish", hosts: hostsOf(1, 2) });
		const b = t.ready(2, 1, hostsOf(1, 2));
		expect(b.sent).toEqual([]);

		t.run({ type: "hosts/publish", hosts: hostsOf(1, 2) });
		expect(b.sent).toEqual([]);
	});
});

describe("capture/clear, announce, clock", () => {
	test("capture/clear empties the list", () => {
		const t = setup();
		const a = t.ready(1);
		t.run({ type: "port/attach", port: port0(1), machine: "node1", nic: 0 });
		t.sw.setLink(1, true);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(t.capture.size).toBe(1);
		t.run({ type: "capture/clear" });
		expect(t.capture.size).toBe(0);
		expect(t.engine.capture).toBe(t.capture);
	});

	test("announce goes to the page's live region", () => {
		const t = setup();
		t.run({ type: "announce", text: "node4 ready" });
		expect(t.announced).toEqual(["node4 ready"]);
	});

	test("the clock ticks at the rate asked for, with the lab's time", () => {
		const t = setup();
		expect(t.intervals).toEqual([]);
		t.run({ type: "clock", hz: 10 });
		expect(t.intervals.map((i) => i.ms)).toEqual([100]);

		t.at(100);
		t.intervals[0].fn();
		t.at(200);
		t.intervals[0].fn();
		expect(t.take()).toEqual([
			{ type: "tick", now: 100 },
			{ type: "tick", now: 200 },
		]);

		t.run({ type: "clock", hz: 10 });
		expect(t.intervals).toHaveLength(1);

		t.run({ type: "clock", hz: 1 });
		expect(t.intervals.map((i) => [i.ms, i.cancelled])).toEqual([
			[100, true],
			[1000, false],
		]);
	});

	test("each tick sweeps the capture log, so an unanswered ARP request is marked", () => {
		const t = setup();
		const a = t.ready(1);
		t.run({ type: "port/attach", port: port0(1), machine: "node1", nic: 0 }, { type: "clock", hz: 1 });
		t.sw.setLink(1, true);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(t.capture.tail(1)[0]).toMatchObject({ note: "flooded, no other port is up" });

		t.at(1000);
		t.intervals[0].fn();
		expect(t.capture.tail(1)[0]).toMatchObject({ note: "flooded, no other port is up · no reply" });
	});
});

describe("dispose", () => {
	test("stops every vm and the clock, and unhooks the capture tap", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.boot(2);
		t.run({ type: "port/attach", port: port0(1), machine: "node1", nic: 0 }, { type: "clock", hz: 10 });
		t.take();

		t.engine.dispose();
		expect([a.stops, b.stops]).toEqual([["drop"], ["drop"]]);
		expect(t.intervals[0].cancelled).toBe(true);
		expect(t.screens.disposed).toEqual(["node1:console", "node2:console"]);

		// A switch that the fabric is given behind the engine's back has no name, so nothing of it is captured.
		const slot = t.fabric().addSwitch();
		t.fabric().attach(slot, 1, { deliver() {} });
		t.fabric().receive(slot, 1, arpRequest(1, 2), 0);
		expect(t.capture.size).toBe(0);
		expect(t.events).toEqual([]);
	});
});

describe("exec", () => {
	test("types the line into the session, marks it, and resolves at the shell's next D with what it printed", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const screen = t.screens.get("node1:console");
		t.at(5000);

		const result = t.engine.exec.inject("node1:console", "ping -c1 node2", "bar", never);
		expect(vm.sent).toEqual([["write", "console", "ping -c1 node2\r"]]);
		expect(screen.made.map((m) => [m.source, m.line, m.ended])).toEqual([["bar", "ping -c1 node2", 0]]);
		expect(t.take()).toEqual([{ type: "session/shell", session: "node1:console", shell: "running" }]);

		screen.printed = "PING node2 (10.88.0.12)\n64 bytes from 10.88.0.12\n\n1 packets transmitted, 1 received";
		t.at(6020.4);
		vm.sink.consoleBytes(vm.ref, bytes(`...output...\r\n${prompt(0)}`));

		expect(await result).toEqual({
			exitCode: 0,
			output: screen.printed,
			truncated: false,
			lastLine: "1 packets transmitted, 1 received",
			ms: 1020,
		});
		expect(screen.made[0].ended).toBeGreaterThan(0);
		expect(t.take()).toEqual([{ type: "session/shell", session: "node1:console", shell: "prompt" }]);
	});

	test("says when the start of what it printed is gone", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const screen = t.screens.get("node1:console");
		const result = t.engine.exec.inject("node1:console", "seq 1 20000", "agent", never);
		screen.printed = "19999\n20000";
		screen.cut = true;
		vm.sink.consoleBytes(vm.ref, bytes(returns(0)));
		expect(await result).toMatchObject({ output: "19999\n20000", truncated: true, lastLine: "20000" });
	});

	test("a failing command resolves with its exit code", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const result = t.engine.exec.inject("node1:console", "false", "button", never);
		vm.sink.consoleBytes(vm.ref, bytes(returns(1)));
		expect(await result).toMatchObject({ exitCode: 1, output: "", lastLine: "" });
		expect(t.screens.get("node1:console").made[0].source).toBe("bar");
	});

	test("an agent's line carries the agent's mark and is reported", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const result = t.engine.exec.inject("node1:console", "uname", "agent", never);
		expect(t.screens.get("node1:console").made[0].source).toBe("agent");
		expect(t.take()).toEqual([
			{ type: "session/marked", session: "node1:console", source: "agent" },
			{ type: "session/shell", session: "node1:console", shell: "running" },
		]);
		vm.sink.consoleBytes(vm.ref, bytes(returns(0)));
		await result;
	});

	test("a line from the bar is not reported as marked", () => {
		const t = setup();
		t.atPrompt(1);
		void t.engine.exec.inject("node1:console", "uname", "bar", never);
		expect(t.events.filter((e) => e.type === "session/marked")).toEqual([]);
	});

	test("refuses with a sentence while the session is running a program, and types nothing", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		t.screens.get("node1:console").io.input("top\r");
		vm.sent.length = 0;
		t.take();

		const refused = t.engine.exec.inject("node1:console", "ls", "bar", never);
		await expect(refused).rejects.toBeInstanceOf(ExecRefused);
		await expect(refused).rejects.toThrow("node1:console is running a program, so wait until it ends.");
		expect(vm.sent).toEqual([]);
		expect(t.screens.get("node1:console").made).toEqual([]);
		expect(t.events).toEqual([]);
	});

	test("refuses while the person has a line half typed, so a command never lands on top of theirs", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const screen = t.screens.get("node1:console");
		screen.io.input(`${ESC}[1;5R`);
		screen.io.input("rm -rf ");
		vm.sent.length = 0;

		await expect(t.engine.exec.inject("node1:console", "ls /tmp", "agent", never)).rejects.toThrow(
			"node1:console has a half-typed line, so finish it there or use another session.",
		);
		expect(vm.sent).toEqual([]);

		screen.io.input("\x03");
		vm.sent.length = 0;
		void t.engine.exec.inject("node1:console", "ls /tmp", "agent", never);
		expect(vm.sent).toEqual([["write", "console", "ls /tmp\r"]]);
	});

	test("a terminal reply is not typing", () => {
		const t = setup();
		const vm = t.atPrompt(1);
		t.screens.get("node1:console").io.input(`${ESC}[1;5R`);
		vm.sent.length = 0;
		void t.engine.exec.inject("node1:console", "ls", "bar", never);
		expect(vm.sent).toEqual([["write", "console", "ls\r"]]);
	});

	test("refuses a session that is not open: unknown, still booting, or a shell whose pty has not opened", async () => {
		const t = setup();
		t.boot(1);
		t.ready(2);
		t.run({ type: "screen/create", session: "node2:sh1" }, { type: "pty/open", session: "node2:sh1" });

		for (const session of ["node9:console", "node1:console", "node2:sh1"] as const) {
			const refused = t.engine.exec.inject(session, "ls", "bar", never);
			await expect(refused).rejects.toBeInstanceOf(ExecRefused);
			await expect(refused).rejects.toThrow(`${session} is not open, so use another session.`);
		}
		expect(t.vms.of("node2").sent.filter(([op]) => op === "write")).toEqual([]);
	});

	test("types into a shell's own pty", async () => {
		const t = setup();
		const vm = t.ready(2);
		t.run({ type: "screen/create", session: "node2:sh1" }, { type: "pty/open", session: "node2:sh1" });
		vm.sink.ptyOpened(vm.ref, 1);
		vm.sink.ptyBytes(vm.ref, 1, bytes(prompt(0)));
		vm.sent.length = 0;

		const result = t.engine.exec.inject("node2:sh1", "id -u", "bar", never);
		expect(vm.sent).toEqual([["write", 1, "id -u\r"]]);
		vm.sink.ptyBytes(vm.ref, 1, bytes(returns(0)));
		expect(await result).toMatchObject({ exitCode: 0 });
	});

	test("refuses a shell that has not shown a prompt yet, because its next prompt would not be the line's", async () => {
		const t = setup();
		const vm = t.ready(1);
		const refused = t.engine.exec.inject("node1:console", "false", "bar", never);
		await expect(refused).rejects.toBeInstanceOf(ExecRefused);
		await expect(refused).rejects.toThrow("node1:console has not shown a prompt yet, so wait until it has.");
		expect(vm.sent).toEqual([]);
	});

	test("a prompt the shell reprinted before it read the line does not end the line", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const result = t.engine.exec.inject("node1:console", "false", "bar", never);
		let settled = false;
		void result.then(() => {
			settled = true;
		});

		vm.sink.consoleBytes(vm.ref, bytes(`\r${prompt(0)}`));
		await settle();
		expect(settled).toBe(false);
		expect(t.screens.get("node1:console").made[0].ended).toBe(0);

		vm.sink.consoleBytes(vm.ref, bytes(`false${returns(1)}`));
		expect(await result).toMatchObject({ exitCode: 1 });
	});

	test("abort rejects with the signal's reason and ends the mark; the command it left running still holds the session", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const screen = t.screens.get("node1:console");
		const abort = new AbortController();
		const result = t.engine.exec.inject("node1:console", "sleep 100", "bar", abort.signal);
		expect(screen.made[0].ended).toBe(0);

		abort.abort(new Error("Stopped by you."));
		await expect(result).rejects.toThrow("Stopped by you.");
		expect(screen.made[0].ended).toBeGreaterThan(0);

		await expect(t.engine.exec.inject("node1:console", "true", "bar", never)).rejects.toThrow(
			"node1:console is running a program, so wait until it ends.",
		);

		vm.sink.consoleBytes(vm.ref, bytes(returns(130)));
		const next = t.engine.exec.inject("node1:console", "true", "bar", never);
		vm.sink.consoleBytes(vm.ref, bytes(returns(0)));
		expect(await next).toMatchObject({ exitCode: 0 });
	});

	describe("after an Enter that a program read instead of the shell", () => {
		/** `cat` was run and Enter pressed while it ran. Its prompt is back and the shell waits. */
		function swallowed() {
			const t = setup();
			const vm = t.atPrompt(1);
			const screen = t.screens.get("node1:console");
			t.run({ type: "clock", hz: 1 });
			const clock = t.intervals.at(-1);
			const tickAt = (ms: number) => {
				t.at(ms);
				clock?.fn();
			};
			screen.io.input("cat\r");
			screen.io.input("\r");
			vm.sink.consoleBytes(vm.ref, bytes(`cat\r\n\r\n${prompt(0)}`));
			t.take();
			return { ...t, vm, screen, tickAt };
		}

		test("the session takes commands again once it has been quiet for a second", async () => {
			const t = swallowed();
			t.tickAt(1000);
			await expect(t.engine.exec.inject("node1:console", "ls", "agent", never)).rejects.toThrow(
				"is running a program, so wait until it ends.",
			);
			t.tickAt(2000);
			expect(t.take()).toContainEqual({ type: "session/shell", session: "node1:console", shell: "prompt" });

			const result = t.engine.exec.inject("node1:console", "false", "agent", never);
			t.vm.sink.consoleBytes(t.vm.ref, bytes(`false${returns(1)}`));
			expect(await result).toMatchObject({ exitCode: 1 });
		});

		test("output or typing starts the second over", () => {
			const t = swallowed();
			t.tickAt(1000);
			t.vm.sink.consoleBytes(t.vm.ref, bytes("m"));
			t.tickAt(2000);
			t.screen.io.input("a");
			t.tickAt(3000);
			t.tickAt(3900);
			expect(t.events.filter((e) => e.type === "session/shell")).toEqual([]);
			t.tickAt(4000);
			expect(t.events).toContainEqual({ type: "session/shell", session: "node1:console", shell: "prompt" });
		});

		test("a line half typed meanwhile is still the person's", async () => {
			const t = swallowed();
			t.screen.io.input("rm -rf ");
			t.tickAt(1000);
			t.tickAt(2000);
			await expect(t.engine.exec.inject("node1:console", "ls", "agent", never)).rejects.toThrow(
				"has a half-typed line, so finish it there or use another session.",
			);
		});

		test("keys the program took are not a half-typed line", async () => {
			const t = setup();
			const vm = t.atPrompt(1);
			const screen = t.screens.get("node1:console");
			t.run({ type: "clock", hz: 1 });
			for (const key of ["less f\r", "\r", "q"]) screen.io.input(key);
			vm.sink.consoleBytes(vm.ref, bytes(`less f\r\n${prompt(0)}`));
			for (const ms of [1000, 2000]) {
				t.at(ms);
				t.intervals.at(-1)?.fn();
			}
			vm.sent.length = 0;
			void t.engine.exec.inject("node1:console", "ls", "agent", never);
			expect(vm.sent).toEqual([["write", "console", "ls\r"]]);
		});
	});

	test("a line typed ahead that the shell is running is never settled, however quiet", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const screen = t.screens.get("node1:console");
		t.run({ type: "clock", hz: 1 });
		screen.io.input("make\r");
		screen.io.input("sleep 100\r");
		vm.sink.consoleBytes(vm.ref, bytes(`make\r\n${prompt(0)}sleep 100\r\n`));
		for (const ms of [1000, 2000, 60_000]) {
			t.at(ms);
			t.intervals.at(-1)?.fn();
		}
		await expect(t.engine.exec.inject("node1:console", "ls", "agent", never)).rejects.toThrow(
			"is running a program, so wait until it ends.",
		);
	});

	test("an already aborted signal rejects before anything is typed", async () => {
		const t = setup();
		const vm = t.atPrompt(1);
		const abort = new AbortController();
		abort.abort(new Error("Stopped by you."));
		await expect(t.engine.exec.inject("node1:console", "ls", "bar", abort.signal)).rejects.toThrow("Stopped by you.");
		expect(vm.sent).toEqual([]);
		expect(t.screens.get("node1:console").made).toEqual([]);
	});

	test("a session that goes away rejects the lines waiting on it", async () => {
		const t = setup();
		t.atPrompt(1);
		const stopped = t.engine.exec.inject("node1:console", "sleep 100", "bar", never);
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "drop" });
		await expect(stopped).rejects.toBeInstanceOf(ExecRefused);
		await expect(stopped).rejects.toThrow("node1:console closed before the command returned.");
		expect(t.screens.get("node1:console").made[0].ended).toBeGreaterThan(0);

		const vm = t.atPrompt(2);
		const failed = t.engine.exec.inject("node2:console", "sleep 100", "bar", never);
		vm.sink.failed(vm.ref, "kernel panic");
		await expect(failed).rejects.toThrow("node2:console closed before the command returned.");

		const other = t.atPrompt(3);
		t.run({ type: "screen/create", session: "node3:sh1" }, { type: "pty/open", session: "node3:sh1" });
		other.sink.ptyOpened(other.ref, 1);
		other.sink.ptyBytes(other.ref, 1, bytes(prompt(0)));
		const exited = t.engine.exec.inject("node3:sh1", "exit", "bar", never);
		other.sink.ptyExited(other.ref, 1, false);
		await expect(exited).rejects.toThrow("node3:sh1 closed before the command returned.");
	});
});

describe("files", () => {
	const FILE: GuestFile = { path: "/etc/motd", text: "hello\n", owner: null, mode: null };
	const WRITTEN: FileOutcome = { kind: "written", path: "/etc/motd", owner: "root:root", mode: "644" };
	const none = () => new AbortController().signal;

	test("a ready machine writes each file it is given, and nothing is typed", async () => {
		const t = setup();
		const vm = t.ready(1);
		const first = t.engine.files.write("node1", FILE, none());
		const second = t.engine.files.write("node1", { ...FILE, path: "/etc/issue" }, none());
		expect(vm.sent).toEqual([
			["writeFile", 1, FILE],
			["writeFile", 2, { ...FILE, path: "/etc/issue" }],
		]);
		vm.sink.wrote(vm.ref, 2, { kind: "refused", reason: "No." });
		vm.sink.wrote(vm.ref, 1, WRITTEN);
		expect(await first).toEqual(WRITTEN);
		expect(await second).toEqual({ kind: "refused", reason: "No." });
		expect(t.events.filter((e) => e.type.startsWith("session/"))).toEqual([]);
	});

	test("a machine that is not ready is given nothing", async () => {
		const t = setup();
		const vm = t.boot(1);
		const refused = { kind: "refused", reason: "node1 is not ready, so wait until it is." };
		expect(await t.engine.files.write("node1", FILE, none())).toEqual(refused);
		expect(await t.engine.files.write("node2", FILE, none())).toMatchObject({ kind: "refused" });
		vm.sink.ready(vm.ref, 1);
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "off" });
		expect(await t.engine.files.write("node1", FILE, none())).toEqual(refused);
		expect(vm.sent).toEqual([]);
	});

	test.each([
		["rebooted", (t: Setup) => t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "reboot" })],
		["powered off", (_: Setup, vm: FakeVm) => vm.sink.halted(vm.ref, "off")],
		["stopped", (t: Setup) => t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "drop" })],
		["stopped", (_: Setup, vm: FakeVm) => vm.sink.failed(vm.ref, "It panicked.")],
		["stopped", (t: Setup) => t.run({ type: "vm/boot", machine: "node1", attempt: 2, config: config(1) })],
		["stopped", (t: Setup) => t.engine.dispose()],
	])("a machine that %s leaves a file it was given in doubt, and what it says later is not heard", async (why, end) => {
		const t = setup();
		const vm = t.ready(1);
		const write = t.engine.files.write("node1", FILE, none());
		end(t, vm);
		vm.sink.wrote(vm.ref, 1, WRITTEN);
		expect(await write).toEqual({
			kind: "unsure",
			reason: `node1 ${why} while /etc/motd was being written, so check whether it was.`,
		});
	});

	test("an abort stops the wait, and one that came first sends nothing", async () => {
		const t = setup();
		const vm = t.ready(1);
		const abort = new AbortController();
		const write = t.engine.files.write("node1", FILE, abort.signal);
		abort.abort(new Error("Stopped by you."));
		await expect(write).rejects.toThrow("Stopped by you.");
		vm.sink.wrote(vm.ref, 1, WRITTEN);
		await expect(t.engine.files.write("node1", FILE, abort.signal)).rejects.toThrow("Stopped by you.");
		expect(vm.sent).toHaveLength(1);
	});
});

describe("checkpoints", () => {
	const checkpoint = parseCheckpointName("before");
	if (!checkpoint) throw new Error("no name");
	const copy = (attempt: number, from: number, to: number): DiskCopy => ({
		machine: "node1",
		attempt,
		n: 1,
		extras: 1,
		checkpoint,
		from,
		to,
	});
	const stopped = async (t: ReturnType<typeof setup>, how: StopHow, attempt = 1) => {
		t.run({ type: "vm/stop", machine: "node1", attempt, how });
		t.vms.of("node1").finishStop();
		await settle();
		t.take();
	};

	test("a running guest saves its own, and what it reports is passed on", () => {
		const t = setup();
		const vm = t.ready(1);
		t.take();
		t.run({ type: "checkpoint/save", copy: copy(1, 0, 1) });
		expect(vm.sent.at(-1)).toEqual(["checkpoint", copy(1, 0, 1)]);
		expect(t.copies).toEqual([]);
		vm.sink.copied(vm.ref, { kind: "progress", percent: 40 });
		vm.sink.copied(vm.ref, { kind: "done", bytes: 4096 });
		vm.sink.copied(vm.ref, { kind: "done", bytes: 1 });
		expect(t.take()).toEqual([
			{ type: "checkpoint/progress", machine: "node1", attempt: 1, set: 1, percent: 40 },
			{ type: "checkpoint/saved", machine: "node1", attempt: 1, set: 1, bytes: 4096 },
		]);
		t.run({ type: "checkpoint/save", copy: copy(1, 0, 2) });
		vm.sink.copied(vm.ref, { kind: "failed", reason: "Full." });
		expect(t.take()).toEqual([{ type: "checkpoint/unsaved", machine: "node1", attempt: 1, set: 2, reason: "Full." }]);
		expect(t.deleted).toEqual([]);
	});

	test("what a guest had copied when it went is deleted once its worker is gone, and so is what it finishes late", async () => {
		const t = setup();
		const vm = t.ready(1);
		t.run({ type: "checkpoint/save", copy: copy(1, 0, 1) });
		vm.sink.halted(vm.ref, "off");
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "save" });
		t.take();
		vm.sink.copied(vm.ref, { kind: "done", bytes: 4096 });
		expect(t.take()).toEqual([]);
		expect(t.deleted).toEqual([]);
		vm.finishStop();
		await settle();
		expect(t.deleted).toEqual([[1, 1]]);
	});

	test("the disks of a machine that is off are copied by a worker of their own", async () => {
		const t = setup();
		t.ready(1);
		await stopped(t, "off");
		t.run({ type: "checkpoint/save", copy: copy(1, 0, 1) });
		const [made] = t.copies;
		expect(made.job).toEqual({ copy: copy(1, 0, 1), why: "save" });
		made.report({ kind: "done", bytes: 4096 });
		expect(t.take()).toEqual([{ type: "checkpoint/saved", machine: "node1", attempt: 1, set: 1, bytes: 4096 }]);
		made.report({ kind: "failed", reason: "late" });
		expect(t.take()).toEqual([]);
	});

	test("a restore waits for the worker that has the disks, and reports that they are back or why not", async () => {
		const t = setup();
		const vm = t.ready(1);
		t.run({ type: "vm/stop", machine: "node1", attempt: 2, how: "drop" });
		t.run({ type: "checkpoint/restore", copy: copy(2, 1, 2) });
		await settle();
		expect(t.copies).toEqual([]);
		vm.finishStop();
		await settle();
		t.take();
		expect(t.copies[0].job).toEqual({ copy: copy(2, 1, 2), why: "restore" });
		t.copies[0].report({ kind: "progress", percent: 7 });
		t.copies[0].report({ kind: "done", bytes: 4096 });
		expect(t.take()).toEqual([
			{ type: "checkpoint/progress", machine: "node1", attempt: 2, set: 2, percent: 7 },
			{ type: "checkpoint/restored", machine: "node1", attempt: 2, set: 2, at: 0 },
		]);
		t.run({ type: "checkpoint/restore", copy: copy(2, 1, 3) });
		t.copies[1].report({ kind: "failed", reason: "Full." });
		expect(t.take()).toEqual([{ type: "vm/failed", machine: "node1", attempt: 2, reason: "Full." }]);
	});

	test("a machine that is removed drops its copy, also one that has not begun, and what it wrote goes", async () => {
		const t = setup();
		t.run({ type: "checkpoint/restore", copy: copy(1, 1, 2) });
		t.run({ type: "vm/stop", machine: "node1", attempt: 1, how: "drop" });
		expect(t.copies[0].dropped).toBe(true);
		expect(t.deleted).toEqual([[1, 2]]);
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node1", attempt: 1, clean: true, at: 0 }]);
		t.copies[0].report({ kind: "done", bytes: 1 });
		expect(t.take()).toEqual([]);

		const vm = t.ready(1, 2);
		t.run({ type: "vm/stop", machine: "node1", attempt: 3, how: "drop" });
		t.run({ type: "checkpoint/restore", copy: copy(3, 1, 3) });
		t.run({ type: "vm/stop", machine: "node1", attempt: 3, how: "drop" });
		vm.finishStop();
		await settle();
		expect(t.copies).toHaveLength(1);
		expect(t.deleted).toEqual([
			[1, 2],
			[1, 3],
		]);
	});
});

describe("cables between switches", () => {
	const lan = parseSwitchName("lan") as SwitchName;
	const wan = parseSwitchName("wan") as SwitchName;
	const cable = [
		{ switch: "switch0", port: 8 },
		{ switch: lan, port: 7 },
	] as const;

	/** node1 on port 1 of switch0, node2 on port 1 of lan and node3 on port 1 of wan, each with its link up. */
	const three = () => {
		const t = setup();
		const vms = [t.ready(1), t.ready(2), t.ready(3)] as const;
		for (const [i, on] of (["switch0", lan, wan] as const).entries()) {
			const plugged = { port: { switch: on, port: 1 }, machine: `node${i + 1}`, nic: 0 } as const;
			t.run({ type: "port/attach", ...plugged }, { type: "link/set", ...plugged, up: true, cause: "runtime" });
		}
		for (const vm of vms) vm.sent.length = 0;
		return { ...t, vms };
	};
	const up = (ends: typeof cable | readonly [PortRef, PortRef]): Effect[] => [
		{ type: "cable/attach", ends },
		{ type: "cable/link", ends, up: true, cause: "bar", plug: true },
	];
	const hops = (t: ReturnType<typeof three>) => [...t.capture.frames()].map((e) => `${e.switch} ${e.from}`);

	test("carry a machine's frame to the machines on the far switch once the link is raised, and each switch learns over them", () => {
		const t = three();
		const [vm1, vm2, vm3] = t.vms;
		t.run({ type: "cable/attach", ends: cable });
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 2));
		expect(vm2.sent).toEqual([]);

		t.run({ type: "cable/link", ends: cable, up: true, cause: "bar", plug: true });
		const frame = arpRequest(1, 2);
		vm1.sink.frame(vm1.ref, 0, frame);
		expect(vm2.sent).toEqual([["deliver", 0, frame]]);
		expect(vm3.sent).toEqual([]);
		expect(hops(t).slice(-2)).toEqual(["switch0 1", "lan 7"]);
		expect(t.engine.reads.macTable(lan).map((e) => [e.mac, e.port])).toEqual([["52:54:00:88:00:0b", 7]]);
		expect(t.engine.reads.counters({ switch: lan, port: 7 })).toMatchObject({ rxFrames: 1 });
		expect(t.capture.tail(3)[0]).toEqual({
			kind: "cable",
			seq: expect.any(Number),
			time: "0.00",
			ends: cable,
			up: true,
			text: "port 8 and port 7 link up",
			cause: "Cable between them plugged in by you.",
		});
	});

	test("are put in once however often they are asked for, and are cut and come out at both their ends", () => {
		const t = three();
		const [vm1, vm2] = t.vms;
		t.run(...up(cable), ...up(cable));
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 2));
		vm2.sink.frame(vm2.ref, 0, arpRequest(2, 1));
		expect([vm1.sent.length, vm2.sent.length]).toEqual([1, 1]);

		t.at(1500);
		t.run({ type: "cable/link", ends: cable, up: false, cause: "agent" });
		expect(t.capture.tail(1)).toMatchObject([
			{ kind: "cable", time: "1.50", up: false, cause: "Cable between them cut by the agent." },
		]);
		expect(t.engine.reads.macTable("switch0").find((e) => e.port === 8)).toMatchObject({ flushed: true });
		expect(t.engine.reads.macTable(lan).find((e) => e.port === 7)).toMatchObject({ flushed: true });
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 2));
		expect(vm2.sent).toHaveLength(1);

		t.run(
			{ type: "cable/link", ends: cable, up: false, cause: "bar", plug: true, cut: true },
			{ type: "cable/detach", ends: cable },
			{ type: "cable/detach", ends: cable },
		);
		expect(t.capture.tail(1)).toMatchObject([{ cause: "Cut cable between them unplugged by you." }]);
		expect(t.engine.reads.counters({ switch: "switch0", port: 8 })).toBeUndefined();
		expect(t.engine.reads.counters({ switch: lan, port: 7 })).toBeUndefined();
		expect(t.engine.reads.macTable(lan).map((e) => e.port)).toEqual([1]);
		// Its ports are free for a machine's cable.
		t.run({ type: "port/attach", port: { switch: lan, port: 7 }, machine: "node3", nic: 1 });
		expect(t.engine.reads.counters({ switch: lan, port: 7 })).toMatchObject({ rxFrames: 0 });
	});

	test("go with a switch that is removed, out of the switch at their other end too", () => {
		const t = three();
		const [vm1, vm2] = t.vms;
		t.run(...up(cable));
		t.run({ type: "switch/remove", switch: lan });
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 2));
		expect(vm2.sent).toEqual([]);
		expect(t.engine.reads.counters({ switch: "switch0", port: 8 })).toBeUndefined();
	});

	test("that make a loop storm: the store is told when it begins, its numbers on each tick, and when a cut has ended it", () => {
		const t = three();
		const [vm1, vm2] = t.vms;
		const loop = [
			cable,
			[
				{ switch: lan, port: 8 },
				{ switch: wan, port: 7 },
			],
			[
				{ switch: wan, port: 8 },
				{ switch: "switch0", port: 7 },
			],
		] as const;
		for (const ends of loop) t.run(...up(ends));
		t.run({ type: "clock", hz: 1 });
		t.take();

		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 9));
		t.clock.pass(1200);
		const began = t.take().filter((e) => e.type === "switch/storm");
		expect(began.map((e) => e.switch).sort()).toEqual(["lan", "switch0", "wan"]);
		for (const e of began) expect(e.storm).toMatchObject({ rate: 0, dropped: 0 });
		expect(vm2.sent.length).toBeGreaterThan(700);
		expect(t.capture.tail(10_000).filter((row) => row.kind === "storm")).toMatchObject([
			{ switch: "switch0", over: false, text: "switch0 is storming" },
			{ switch: "lan", over: false },
			{ switch: "wan", over: false },
		]);
		expect(t.capture.tail(1)).toMatchObject([
			{ kind: "frame", looped: true, note: expect.stringMatching(/^looped · /) },
		]);

		t.intervals[0].fn();
		const read = t.take().filter((e) => e.type === "switch/storm");
		expect(read.map((e) => e.switch)).toEqual(["switch0", "lan", "wan"]);
		// One copy goes each way round, so each switch takes two in every three milliseconds.
		for (const e of read) expect(e.storm?.rate).toBeGreaterThan(600);

		t.run({ type: "cable/link", ends: loop[1], up: false, cause: "bar" });
		t.clock.pass(150);
		const over = t.take().filter((e) => e.type === "switch/storm");
		expect(over.map((e) => [e.switch, e.storm]).sort()).toEqual([
			["lan", null],
			["switch0", null],
			["wan", null],
		]);
		expect(t.capture.tail(3)).toMatchObject([
			{ kind: "storm", over: true },
			{ kind: "storm", over: true },
			{
				kind: "storm",
				over: true,
				cause: expect.stringMatching(/^It took \d+ looped frames in 1\.[23] s\. It has forgotten/),
			},
		]);
		expect(t.engine.reads.macTable("switch0")).toEqual([]);
		const sent = vm2.sent.length;
		t.clock.pass(500);
		expect(vm2.sent.length).toBe(sent);
		t.intervals[0].fn();
		expect(t.take().filter((e) => e.type === "switch/storm")).toEqual([]);
	});

	test("end with a switch that is removed while it storms: the capture says so of it, and of the others once they are quiet", () => {
		const t = three();
		const [vm1] = t.vms;
		const loop: readonly [PortRef, PortRef] = [
			{ switch: lan, port: 5 },
			{ switch: lan, port: 6 },
		];
		t.run(...up(cable), ...up(loop));
		vm1.sink.frame(vm1.ref, 0, arpRequest(1, 9));
		t.clock.pass(300);
		t.take();
		t.run({ type: "switch/remove", switch: lan });
		expect(t.capture.tail(10_000).filter((row) => row.kind === "storm")).toMatchObject([
			{ switch: "lan", over: false },
			{ switch: "switch0", over: false },
			{ switch: "lan", over: true, text: "lan storm over" },
		]);
		t.clock.pass(300);
		expect(t.capture.tail(10_000).filter((row) => row.kind === "storm")).toMatchObject([
			{ switch: "lan", over: false },
			{ switch: "switch0", over: false },
			{ switch: "lan", over: true },
			{ switch: "switch0", over: true },
		]);
	});
});
