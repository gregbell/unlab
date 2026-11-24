import type { KernelHandle, PtyEnd, Subprocess } from "unkernel";
import { describe, expect, test } from "vitest";
import { FrameCutter, packFrames } from "./nic-pipe.ts";
import { NIC_HELPER_PATH, openTap } from "./tap.ts";

const READY = packFrames([new Uint8Array(0)]);
const frame = (fill: number, length = 60): Uint8Array<ArrayBuffer> => new Uint8Array(length).fill(fill);

/** The helper as the page meets it: three streams and an ending, all held by the test. */
function helper() {
	const spawned: unknown[] = [];
	const written: Uint8Array[] = [];
	const received: Uint8Array[] = [];
	const lost: string[] = [];
	const ended = Promise.withResolvers<PtyEnd>();
	let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
	let stderr: ReadableStreamDefaultController<Uint8Array> | undefined;
	let reading = true;
	const blocked = Promise.withResolvers<void>();

	const process = {
		stdout: new ReadableStream<Uint8Array>({
			start(c) {
				stdout = c;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(c) {
				stderr = c;
			},
		}),
		stdin: new WritableStream<Uint8Array | string>({
			async write(chunk) {
				if (!reading) await blocked.promise;
				written.push(chunk as Uint8Array);
			},
		}),
		ended: ended.promise,
	} as unknown as Subprocess;
	const vm = {
		spawn: async (...args: unknown[]) => {
			spawned.push(args);
			return process;
		},
	} as unknown as Pick<KernelHandle, "spawn">;

	return {
		spawned,
		received,
		lost,
		open: () =>
			openTap(vm, {
				name: "eth1",
				mac: "52:54:00:88:01:0c",
				toSwitch: (f) => received.push(f),
				lost: (reason) => lost.push(reason),
			}),
		says: (chunk: Uint8Array) => stdout?.enqueue(chunk),
		complains: (text: string) => stderr?.enqueue(new TextEncoder().encode(text)),
		/** Every frame the helper has been handed. */
		got: () => new FrameCutter().push(new Uint8Array(written.flatMap((chunk) => [...chunk]))),
		stopReading() {
			reading = false;
		},
		readAgain() {
			reading = true;
			blocked.resolve();
		},
		ends(end: PtyEnd) {
			stdout?.close();
			stderr?.close();
			ended.resolve(end);
		},
	};
}

const settled = () => new Promise((resolve) => setTimeout(resolve));

describe("a TAP device", () => {
	test("is opened as root with its name and MAC, and is there once the helper says so", async () => {
		const h = helper();
		let open = false;
		const tap = h.open().then((t) => {
			open = true;
			return t;
		});
		await settled();
		expect(h.spawned).toEqual([[NIC_HELPER_PATH, ["tap", "eth1", "52:54:00:88:01:0c"], { pty: false, user: "root" }]]);
		expect(open).toBe(false);
		h.says(READY.subarray(0, 1));
		await settled();
		expect(open).toBe(false);
		h.says(READY.subarray(1));
		await tap;
		expect(h.received).toEqual([]);
	});

	test("hands on the frames the guest sends, however they are cut", async () => {
		const h = helper();
		h.says(new Uint8Array([...READY, ...packFrames([frame(1), frame(2, 1514)])].slice(0, 70)));
		await h.open();
		h.says(new Uint8Array([...READY, ...packFrames([frame(1), frame(2, 1514)])].slice(70)));
		await settled();
		expect(h.received).toEqual([frame(1), frame(2, 1514)]);
	});

	test("takes frames for the guest in order", async () => {
		const h = helper();
		h.says(READY);
		const tap = await h.open();
		for (let i = 0; i < 100; i++) tap.deliver(frame(i));
		await settled();
		expect(h.got()).toEqual(Array.from({ length: 100 }, (_, i) => frame(i)));
	});

	test("drops frames past 1 MiB while the guest is not reading, and takes them again when it is", async () => {
		const h = helper();
		h.says(READY);
		const tap = await h.open();
		h.stopReading();
		for (let i = 0; i < 4096; i++) tap.deliver(frame(i & 255, 1024));
		await settled();
		h.readAgain();
		await settled();
		expect(h.got()).toHaveLength(1024);
		expect(h.got()[1023]).toEqual(frame(255, 1024));
		tap.deliver(frame(7));
		await settled();
		expect(h.got()).toHaveLength(1025);
	});

	test("drops a frame no length can say", async () => {
		const h = helper();
		h.says(READY);
		const tap = await h.open();
		tap.deliver(new Uint8Array(65_536));
		tap.deliver(frame(1));
		await settled();
		expect(h.got()).toEqual([frame(1)]);
	});

	test("that the guest cannot make fails with the helper's words", async () => {
		const h = helper();
		const tap = h.open();
		h.complains("TUNSETIFF: Device or resource busy\n");
		h.ends({ type: "exit", code: 1 });
		await expect(tap).rejects.toThrow("eth1 stopped: TUNSETIFF: Device or resource busy.");
		expect(h.lost).toEqual([]);
	});

	test("that goes away is reported once, and drops what comes after", async () => {
		const h = helper();
		h.says(READY);
		const tap = await h.open();
		h.ends({ type: "signal", signal: 9 } as PtyEnd);
		await settled();
		expect(h.lost).toEqual(["eth1 stopped: signal 9."]);
		tap.deliver(frame(1));
		await settled();
		expect(h.got()).toEqual([]);
	});
});
