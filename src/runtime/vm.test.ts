import { afterEach, describe, expect, test, vi } from "vitest";
import type { BootConfig } from "../model/index.ts";
import type { FromVm, ToVm } from "./protocol.ts";
import { STOP_GRACE_MS, startVm, type VmSink, type WorkerEvents } from "./vm.ts";

const NODE3: BootConfig = {
	identity: { n: 3, name: "node3", ip: "10.88.0.13", mac: "52:54:00:88:00:0d" },
	spec: { image: "alpine", memMiB: 256, net: "switch0" },
	hosts: [
		{ ip: "10.88.0.11", name: "node1" },
		{ ip: "10.88.0.13", name: "node3" },
	],
};

type Call = readonly [name: keyof VmSink, ...args: unknown[]];

function boot(attempt = 1) {
	const posted: { message: ToVm; transfer: Transferable[] }[] = [];
	const timers: { ms: number; fn: () => void }[] = [];
	const calls: Call[] = [];
	let terminated = 0;
	let clock = 0;
	let events: WorkerEvents | undefined;
	let image: { resolve(buf: ArrayBufferLike): void; reject(e: unknown): void } | undefined;

	const record =
		(name: keyof VmSink) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
		};
	const sink: VmSink = {
		stage: record("stage"),
		ready: record("ready"),
		failed: record("failed"),
		frame: record("frame"),
		consoleBytes: record("consoleBytes"),
		ptyOpened: record("ptyOpened"),
		ptyBytes: record("ptyBytes"),
		ptyExited: record("ptyExited"),
	};

	const vm = startVm(
		{
			machine: "node3",
			attempt,
			config: NODE3,
			cols: 100,
			rows: 30,
			image: new Promise((resolve, reject) => {
				image = { resolve, reject };
			}),
		},
		sink,
		{
			createWorker(name, on) {
				expect(name).toBe("node3");
				events = on;
				return {
					postMessage: (message, transfer) => posted.push({ message, transfer }),
					terminate: () => terminated++,
				};
			},
			after: (ms, fn) => timers.push({ ms, fn }),
			now: () => clock,
		},
	);

	return {
		vm,
		calls,
		posted,
		timers,
		messages: () => posted.map((p) => p.message),
		terminated: () => terminated,
		from: (m: FromVm) => events?.message(m),
		workerError: (reason: string) => events?.error(reason),
		imageArrives: async (buf: ArrayBufferLike = new ArrayBuffer(8)) => {
			image?.resolve(buf);
			await Promise.resolve();
		},
		imageFails: async (e: unknown) => {
			image?.reject(e);
			await Promise.resolve();
		},
		at: (ms: number) => {
			clock = ms;
		},
	};
}

const AT = { machine: "node3", attempt: 1 };

afterEach(() => vi.restoreAllMocks());

describe("boot", () => {
	test("boots the worker with the identity's name, address and MAC once the image arrives", async () => {
		const t = boot();
		expect(t.messages()).toEqual([]);

		const image = new ArrayBuffer(16);
		await t.imageArrives(image);
		expect(t.messages()).toEqual([
			{
				type: "boot",
				cfg: {
					id: "node3",
					name: "node3",
					ip: "10.88.0.13",
					prefixBits: 24,
					mac: "52:54:00:88:00:0d",
					labCidr: "10.88.0.0/24",
					image,
					distro: "alpine",
					memoryMiB: 256,
					hosts: NODE3.hosts,
					internet: false,
					cols: 100,
					rows: 30,
				},
			},
		]);
	});

	test("every report carries the machine and the attempt it was started for", async () => {
		const t = boot(4);
		const bytes = Uint8Array.of(1, 2, 3);
		t.from({ type: "stage", stage: "kernel" });
		t.from({ type: "console", bytes });
		t.from({ type: "frame", frame: bytes });
		t.from({ type: "pty-ready", sid: 2, pid: 80, pts: 1 });
		t.from({ type: "pty-output", sid: 2, bytes });
		t.from({ type: "pty-exit", sid: 2, code: 0, reason: "" });
		t.from({ type: "ready", ms: 900 });

		const at = { machine: "node3", attempt: 4 };
		expect(t.calls).toEqual([
			["stage", at, "fetching image"],
			["stage", at, "kernel"],
			["consoleBytes", at, bytes],
			["frame", at, bytes],
			["ptyOpened", at, 2],
			["ptyBytes", at, 2, bytes],
			["ptyExited", at, 2],
			["ready", at, 0],
		]);
	});

	test("stages pass through, kernel log lines do not, and a booted kernel is configuring", () => {
		const t = boot();
		t.from({ type: "stage", stage: "download" });
		t.from({ type: "stage", stage: "log", detail: "virtio_net virtio0 eth0" });
		t.from({ type: "booted", ms: 700 });
		expect(t.calls).toEqual([
			["stage", AT, "fetching image"],
			["stage", AT, "download"],
			["stage", AT, "configuring"],
		]);
	});

	test("boot time runs from the start of the attempt to the worker's ready, image fetch included", async () => {
		const t = boot();
		t.at(1200);
		await t.imageArrives();
		t.at(3582.4);
		t.from({ type: "ready", ms: 2382 });
		expect(t.calls.at(-1)).toEqual(["ready", AT, 3582]);
	});
});

describe("failure reasons are the runtime's own words", () => {
	test("a fatal error", () => {
		const t = boot();
		t.from({ type: "error", message: "out of memory: 4096 MiB requested", fatal: true });
		expect(t.calls.at(-1)).toEqual(["failed", AT, "out of memory: 4096 MiB requested"]);
	});

	test("a worker that throws", () => {
		const t = boot();
		t.workerError("Uncaught SyntaxError: bad kernel module");
		expect(t.calls.at(-1)).toEqual(["failed", AT, "Uncaught SyntaxError: bad kernel module"]);
	});

	test("an image that cannot be fetched, and the worker is never booted", async () => {
		const t = boot();
		await t.imageFails(new Error("distros/alpine.erofs: HTTP 404"));
		expect(t.calls.at(-1)).toEqual(["failed", AT, "distros/alpine.erofs: HTTP 404"]);
		expect(t.messages()).toEqual([]);
	});

	test("a guest that exits by itself", () => {
		const t = boot();
		t.from({ type: "exited", code: 0, reason: "reboot: Power down" });
		expect(t.calls.at(-1)).toEqual(["failed", AT, "reboot: Power down"]);
	});

	test("an exit with no reason still gets a sentence", () => {
		const t = boot();
		t.from({ type: "exited", code: 137, reason: "" });
		expect(t.calls.at(-1)).toEqual(["failed", AT, "The guest exited with code 137."]);
	});

	test("only the first failure is reported", () => {
		const t = boot();
		t.from({ type: "error", message: "kernel panic", fatal: true });
		t.from({ type: "exited", code: 1, reason: "" });
		t.workerError("worker gone");
		expect(t.calls.filter(([name]) => name === "failed")).toEqual([["failed", AT, "kernel panic"]]);
	});

	test("an error the guest survives is not a failure", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = boot();
		t.from({ type: "error", message: "reconfigure: ip: RTNETLINK answers: File exists", fatal: false });
		expect(t.calls.filter(([name]) => name === "failed")).toEqual([]);
		expect(warn).toHaveBeenCalledOnce();
	});
});

describe("what the page sends", () => {
	test("console and pty input, sizes, shells and the host table", async () => {
		const t = boot();
		await t.imageArrives();
		t.posted.length = 0;

		t.vm.write("console", "ls\r");
		t.vm.write(2, "top\r");
		t.vm.resize("console", 120, 40);
		t.vm.resize(2, 80, 24);
		t.vm.openPty(2, 80, 24);
		t.vm.closePty(2);
		t.vm.reconfigure([{ ip: "10.88.0.14", name: "node4" }]);

		expect(t.messages()).toEqual([
			{ type: "input", data: "ls\r" },
			{ type: "pty-data", sid: 2, data: "top\r" },
			{ type: "resize", cols: 120, rows: 40 },
			{ type: "pty-resize", sid: 2, cols: 80, rows: 24 },
			{ type: "pty-open", spec: { sid: 2, cols: 80, rows: 24 } },
			{ type: "pty-close", sid: 2 },
			{
				type: "reconfigure",
				name: "node3",
				ip: "10.88.0.13",
				prefixBits: 24,
				hosts: [{ ip: "10.88.0.14", name: "node4" }],
				internet: false,
			},
		]);
	});

	test("a delivered frame is copied, because the switch shares one frame with every port of a flood", () => {
		const t = boot();
		const frame = Uint8Array.of(9, 8, 7, 6);
		t.vm.deliver(frame);

		const [sent] = t.posted;
		if (sent.message.type !== "frame") throw new Error("expected a frame message");
		expect(sent.message.frame).toEqual(frame);
		expect(sent.message.frame.buffer).not.toBe(frame.buffer);
		expect(sent.transfer).toEqual([sent.message.frame.buffer]);
	});
});

describe("stop", () => {
	test("asks the guest to stop, then terminates the worker after the grace period", async () => {
		const t = boot();
		let resolved = 0;
		void t.vm.stop().then(() => resolved++);

		expect(t.messages()).toEqual([{ type: "stop" }]);
		expect(t.timers.map((x) => x.ms)).toEqual([STOP_GRACE_MS]);
		expect(STOP_GRACE_MS).toBe(250);
		await Promise.resolve();
		expect([t.terminated(), resolved]).toEqual([0, 0]);

		t.timers[0].fn();
		await Promise.resolve();
		expect([t.terminated(), resolved]).toEqual([1, 1]);
	});

	test("is idempotent: one stop message, one timer, one termination, one promise", async () => {
		const t = boot();
		const first = t.vm.stop();
		const second = t.vm.stop();
		expect(second).toBe(first);
		expect(t.messages()).toEqual([{ type: "stop" }]);
		expect(t.timers).toHaveLength(1);

		t.timers[0].fn();
		await first;
		expect(t.vm.stop()).toBe(first);
		expect(t.terminated()).toBe(1);
		expect(t.timers).toHaveLength(1);
	});

	test("a stopped machine reports nothing more: its exit is not a failure", async () => {
		const t = boot();
		void t.vm.stop();
		t.calls.length = 0;

		t.from({ type: "exited", code: 0, reason: "powered off" });
		t.from({ type: "console", bytes: Uint8Array.of(1) });
		t.workerError("terminated");
		await t.imageArrives();

		expect(t.calls).toEqual([]);
		expect(t.messages()).toEqual([{ type: "stop" }]);
	});
});
