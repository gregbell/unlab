// A NIC beyond eth0: a TAP device the helper holds open in the guest, with its
// frames on the helper's stdin and stdout.

import type { KernelHandle, PtyEnd } from "unkernel";
import { FRAME_MAX, FrameCutter, packFrames } from "./nic-pipe.ts";

/** Where the helper is put in the guest. */
export const NIC_HELPER_PATH = "/run/unlab-nic";

/**
 * Bytes waiting for a guest that is not reading them, past which a NIC drops
 * what arrives. TCP takes the loss as a full queue and slows down.
 */
const QUEUE_BYTES = 1 << 20;

export interface Tap {
	/** A frame from the switch, into the guest. Must not be changed afterwards. */
	deliver(frame: Uint8Array): void;
}

export interface TapOptions {
	/** The interface name in the guest. */
	readonly name: string;
	readonly mac: string;
	/** A frame the guest sent, in a buffer of its own. */
	readonly toSwitch: (frame: Uint8Array) => void;
	/** The device is gone from a guest that had it. One sentence. */
	readonly lost: (reason: string) => void;
}

function ending(end: PtyEnd): string {
	if (end.type === "exit") return `exit ${end.code}`;
	return end.type === "signal" ? `signal ${end.signal}` : end.type;
}

/** Resolves once the device exists in the guest. It is down until something brings it up. */
export async function openTap(vm: Pick<KernelHandle, "spawn">, opts: TapOptions): Promise<Tap> {
	const { name, mac, toSwitch, lost } = opts;
	const helper = await vm.spawn(NIC_HELPER_PATH, ["tap", name, mac], { pty: false, user: "root" });
	const made = Promise.withResolvers<void>();
	let exists = false;

	const read = async () => {
		const cutter = new FrameCutter();
		for (const reader = helper.stdout.getReader(); ; ) {
			const { done, value } = await reader.read();
			if (done) return;
			for (const frame of cutter.push(value)) {
				if (frame.length > 0) {
					toSwitch(frame);
					continue;
				}
				exists = true;
				made.resolve();
			}
		}
	};
	let said = "";
	const listen = async () => {
		const text = new TextDecoder();
		for (const reader = helper.stderr.getReader(); ; ) {
			const { done, value } = await reader.read();
			if (done) return;
			said += text.decode(value, { stream: true });
		}
	};
	// A stream that breaks breaks with the session, which `ended` reports.
	const drained = Promise.allSettled([read(), listen()]);

	let over = false;
	const ended = async (how: string) => {
		over = true;
		await drained;
		const reason = `${name} stopped: ${said.trim() || how}.`;
		if (exists) lost(reason);
		else made.reject(new Error(reason));
	};
	helper.ended.then(
		(end) => ended(ending(end)),
		(error: unknown) => ended(error instanceof Error ? error.message : String(error)),
	);

	const pipe = helper.stdin.getWriter();
	let queue: Uint8Array[] = [];
	let queued = 0;
	let writing = false;
	const drain = async () => {
		writing = true;
		try {
			while (queue.length > 0 && !over) {
				const frames = queue;
				queue = [];
				const chunk = packFrames(frames);
				await pipe.write(chunk);
				for (const frame of frames) queued -= frame.length;
			}
		} catch {
			// The session is over, which `ended` reports.
			over = true;
		}
		writing = false;
	};

	await made.promise;
	return {
		deliver(frame) {
			if (over || frame.length > FRAME_MAX || queued + frame.length > QUEUE_BYTES) return;
			queue.push(frame);
			queued += frame.length;
			if (!writing) void drain();
		},
	};
}
