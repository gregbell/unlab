import { describe, expect, test, vi } from "vitest";
import { arpRequest, mac, ping, routedPing } from "../../test/support/frames.ts";
import { createCaptureLog } from "../capture/index.ts";
import type { BootConfig, Effect, HostEntry, MachineName, RuntimeEvent, SessionId } from "../model/index.ts";
import { defaultAddress } from "../net/index.ts";
import { createEngine, ExecRefused } from "./engine.ts";
import type { LineMark, MarkSource, Screen, ScreenIo, Screens } from "./screens.ts";
import { createShellTracker } from "./shell-tracker.ts";
import { LabSwitch } from "./switch.ts";
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
		identity: {
			n,
			name: `node${n}`,
			mac: `52:54:00:88:00:${(10 + n).toString(16).padStart(2, "0")}`,
		},
		spec: { image, memMiB: 256, gateway: true, nics: [{ net: "switch0", address: defaultAddress(n) }] },
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
			let size = { cols: 100, rows: 30 };
			const screen: FakeScreen = {
				session,
				io,
				written,
				made,
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
	stops: number;
	/** Let the 250 ms teardown finish. */
	finishStop(): void;
}

function fakeVms() {
	const started: FakeVm[] = [];
	const startVm: StartVm = (boot, sink) => {
		const sent: unknown[][] = [];
		let finish = () => {};
		const stopped = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const vm: FakeVm = {
			boot,
			sink,
			ref: { machine: boot.machine, attempt: boot.attempt },
			sent,
			stops: 0,
			finishStop: () => finish(),
			write: (tty: Tty, data) => sent.push(["write", tty, data]),
			resize: (tty: Tty, cols, rows) => sent.push(["resize", tty, cols, rows]),
			openPty: (pty, cols, rows) => sent.push(["openPty", pty, cols, rows]),
			closePty: (pty) => sent.push(["closePty", pty]),
			reconfigure: (hosts) => sent.push(["reconfigure", hosts]),
			deliver: (nic, frame) => sent.push(["deliver", nic, frame]),
			stop() {
				vm.stops++;
				return stopped;
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
	let clock = 0;
	const events: RuntimeEvent[] = [];
	const announced: string[] = [];
	const imagesAsked: string[] = [];
	const intervals: { ms: number; fn: () => void; cancelled: boolean }[] = [];
	const sw = new LabSwitch({ now: () => clock });
	const capture = createCaptureLog({ now: () => clock, schedule: () => {} });
	const vms = fakeVms();
	const screens = fakeScreens();

	const engine = createEngine({
		store: { dispatchRuntime: (e) => events.push(e) },
		sw,
		capture,
		screens: screens.screens,
		startVm: vms.startVm,
		image(name) {
			imagesAsked.push(name);
			return Promise.resolve(new ArrayBuffer(4));
		},
		announce: (text) => announced.push(text),
		every(ms, fn) {
			const interval = { ms, fn, cancelled: false };
			intervals.push(interval);
			return () => {
				interval.cancelled = true;
			};
		},
		now: () => clock,
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
		imagesAsked,
		intervals,
		sw,
		capture,
		vms,
		screens,
		at: (ms: number) => {
			clock = ms;
		},
		take: () => events.splice(0),
	};
}

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
		expect(first.stops).toBe(1);
		expect(second.stops).toBe(0);

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
		expect(t.vms.of("node3").stops).toBe(0);
	});
});

describe("vm/stop", () => {
	test("stops the vm and reports vm/stopped only once the teardown has finished", async () => {
		const t = setup();
		const vm = t.ready(3);
		t.take();

		t.run({ type: "vm/stop", machine: "node3", attempt: 1 });
		await settle();
		expect(vm.stops).toBe(1);
		expect(t.events).toEqual([]);

		vm.finishStop();
		await settle();
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node3", attempt: 1 }]);
	});

	test("is idempotent: a repeat while stopping reports once, a repeat afterwards reports the end state again", async () => {
		const t = setup();
		const vm = t.ready(3);
		t.take();

		t.run({ type: "vm/stop", machine: "node3", attempt: 1 }, { type: "vm/stop", machine: "node3", attempt: 1 });
		vm.finishStop();
		await settle();
		expect(vm.stops).toBe(1);
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node3", attempt: 1 }]);

		t.run({ type: "vm/stop", machine: "node3", attempt: 1 });
		expect(t.take()).toEqual([{ type: "vm/stopped", machine: "node3", attempt: 1 }]);
	});

	test("a stop for a stale attempt leaves the current vm alone and reports nothing", async () => {
		const t = setup();
		t.boot(3, 1);
		const current = t.boot(3, 2);
		t.run({ type: "vm/stop", machine: "node3", attempt: 1 });
		await settle();
		expect(current.stops).toBe(0);
		expect(t.events).toEqual([]);
	});

	test("a stopping vm is quiet, and its machine takes no more input", async () => {
		const t = setup();
		const vm = t.atPrompt(3);
		t.run({ type: "vm/stop", machine: "node3", attempt: 1 });
		vm.sink.failed(vm.ref, "powered off");
		vm.sink.consoleBytes(vm.ref, bytes("bye"));
		t.screens.get("node3:console").io.input("ls\r");
		expect(t.events).toEqual([]);
		expect(vm.sent).toEqual([]);
	});
});

describe("ports and frames", () => {
	test("a port reserved at spawn carries nothing until its link comes up at ready", () => {
		const t = setup();
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
		);
		const a = t.ready(1);
		const b = t.ready(2);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(t.sw.isUp(1)).toBe(false);

		t.run(
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: true, cause: "runtime" },
			{ type: "link/set", port: 2, machine: "node2", nic: 0, up: true, cause: "runtime" },
		);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toHaveLength(1);
	});

	test("a frame from a plugged machine goes through the switch to its neighbour and into the capture log", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
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
		expect(t.engine.reads.macTable()).toMatchObject([{ mac: "52:54:00:88:00:0b", port: 1, flushed: false }]);
		expect(t.engine.reads.counters(1)).toMatchObject({ rxFrames: 1 });
	});

	test("each NIC sends and receives on its own port", () => {
		const t = setup();
		const a = t.ready(1);
		const router = t.ready(2);
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
			{ type: "port/attach", port: 3, machine: "node2", nic: 2 },
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
		expect(t.engine.reads.macTable()).toContainEqual(expect.objectContaining({ mac: "52:54:00:88:02:0c", port: 3 }));

		router.sink.frame(router.ref, 1, routedPing(mac(2, 1), mac(1), 3, 1));
		expect(a.sent).toHaveLength(1);
	});

	test("cutting one NIC's cable leaves the machine's other NIC connected", () => {
		const t = setup();
		const a = t.ready(1);
		const router = t.ready(2);
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
			{ type: "port/attach", port: 3, machine: "node2", nic: 1 },
		);
		for (const port of [1, 2, 3] as const) t.sw.setLink(port, true);
		t.run({ type: "link/set", port: 3, machine: "node2", nic: 1, up: false, cause: "bar" });
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(router.sent.map((call) => call.slice(0, 2))).toEqual([["deliver", 0]]);
		router.sink.frame(router.ref, 1, routedPing(mac(2, 1), mac(1), 3, 1));
		expect(a.sent).toEqual([]);
		expect(t.capture.tail(1)).toMatchObject([{ kind: "frame", from: { name: "node1" } }]);
	});

	test("a port may be attached before its machine boots", () => {
		const t = setup();
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
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
		t.run({ type: "port/attach", port: 2, machine: "node2", nic: 0 });
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(t.capture.size).toBe(0);
	});

	test("a detached port carries nothing, and attaching the same port twice is harmless", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
			{ type: "port/detach", port: 2 },
			{ type: "port/detach", port: 2 },
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
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node3", nic: 0 },
		);
		t.sw.setLink(1, true);
		t.sw.setLink(2, true);
		a.sink.frame(a.ref, 0, arpRequest(1, 2));
		expect(b.sent).toEqual([]);
		expect(c.sent).toHaveLength(1);
	});
});

describe("link/set", () => {
	test("changes the switch link, then writes the capture row with its cause", () => {
		const t = setup();
		t.ready(1);
		t.ready(2);
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
		);
		const setLink = vi.spyOn(t.sw, "setLink");
		const appendLink = vi.spyOn(t.capture, "appendLink");
		t.at(2500);

		t.run({ type: "link/set", port: 2, machine: "node2", nic: 0, up: false, cause: "agent" });

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

		t.run({ type: "link/set", port: 2, machine: "node2", nic: 0, up: true, cause: "bar" });
		expect(t.sw.isUp(2)).toBe(true);
		expect(t.capture.tail(1)).toMatchObject([{ up: true, cause: "Cable to node2 reconnected by you." }]);
	});

	test("a cut machine's neighbour stops hearing it", () => {
		const t = setup();
		const a = t.ready(1);
		const b = t.ready(2);
		t.run(
			{ type: "port/attach", port: 1, machine: "node1", nic: 0 },
			{ type: "port/attach", port: 2, machine: "node2", nic: 0 },
			{ type: "link/set", port: 1, machine: "node1", nic: 0, up: false, cause: "button" },
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

		vm.sink.ptyExited(vm.ref, 1);
		vm.sink.ptyExited(vm.ref, 1);
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

		vm.sink.ptyExited(vm.ref, 3);
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
		t.run({ type: "port/attach", port: 1, machine: "node1", nic: 0 });
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
		t.run({ type: "port/attach", port: 1, machine: "node1", nic: 0 }, { type: "clock", hz: 1 });
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
		t.run({ type: "port/attach", port: 1, machine: "node1", nic: 0 }, { type: "clock", hz: 10 });
		t.take();

		t.engine.dispose();
		expect([a.stops, b.stops]).toEqual([1, 1]);
		expect(t.intervals[0].cancelled).toBe(true);
		expect(t.screens.disposed).toEqual(["node1:console", "node2:console"]);

		t.sw.receive(1, arpRequest(1, 2));
		expect(t.capture.size).toBe(0);
		expect(t.events).toEqual([]);
	});
});

describe("exec", () => {
	const never = new AbortController().signal;

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
		await expect(refused).rejects.toThrow("node1:console is running a program.");
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
			"node1:console has a half-typed line.",
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
			await expect(refused).rejects.toThrow(`${session} is not open.`);
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
		await expect(refused).rejects.toThrow("node1:console has not shown a prompt yet.");
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
			"node1:console is running a program.",
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
				"is running a program.",
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
				"has a half-typed line.",
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
		await expect(t.engine.exec.inject("node1:console", "ls", "agent", never)).rejects.toThrow("is running a program.");
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
		t.run({ type: "vm/stop", machine: "node1", attempt: 1 });
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
		other.sink.ptyExited(other.ref, 1);
		await expect(exited).rejects.toThrow("node3:sh1 closed before the command returned.");
	});
});
