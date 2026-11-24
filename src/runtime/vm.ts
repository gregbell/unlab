// One boot attempt of one machine: a worker, and the translation between its
// wire protocol and typed calls. The protocol does not leave this file. A Vm
// keeps no lifecycle state; it reports, stamped with the attempt it was started
// for, and whoever listens decides what a report means.

import { type BootConfig, type HostEntry, type MachineName, type NicNo, nicMac } from "../model/index.ts";
import { NICS } from "../net/index.ts";
import type { FromVm, ToVm, VmConfig } from "./protocol.ts";

/** A kernel parked in Atomics.wait may never see `stop`, so the thread is dropped this long after asking. */
export const STOP_GRACE_MS = 250;
/** What a console or a shell starts at, until its screen has been measured. */
export const DEFAULT_TTY_SIZE = { cols: 100, rows: 30 } as const;

export interface VmRef {
	readonly machine: MachineName;
	readonly attempt: number;
}

/** The console, or a shell's pty by the number it was opened with. */
export type Tty = "console" | number;

export interface VmSink {
	stage(vm: VmRef, stage: string): void;
	/** `bootMs` runs from the start of the attempt, image fetch included. */
	ready(vm: VmRef, bootMs: number): void;
	/** One sentence, as the runtime gave it. Reported at most once. */
	failed(vm: VmRef, reason: string): void;
	/** A frame one of the guest's NICs put on the wire. */
	frame(vm: VmRef, nic: NicNo, frame: Uint8Array): void;
	consoleBytes(vm: VmRef, bytes: Uint8Array): void;
	ptyOpened(vm: VmRef, pty: number): void;
	ptyBytes(vm: VmRef, pty: number, bytes: Uint8Array): void;
	ptyExited(vm: VmRef, pty: number): void;
}

export interface Vm {
	write(tty: Tty, data: string): void;
	resize(tty: Tty, cols: number, rows: number): void;
	openPty(pty: number, cols: number, rows: number): void;
	closePty(pty: number): void;
	/** Give the guest a new host table. */
	reconfigure(hosts: readonly HostEntry[]): void;
	/** A frame from the switch, into one of the guest's NICs. */
	deliver(nic: NicNo, frame: Uint8Array): void;
	/** Ask the guest to stop, then drop its thread. Every call returns the same promise. */
	stop(): Promise<void>;
}

export interface VmBoot {
	readonly machine: MachineName;
	readonly attempt: number;
	readonly config: BootConfig;
	/** The console's size when the kernel starts. */
	readonly cols: number;
	readonly rows: number;
	/** Shared by every machine on the same image. */
	readonly image: Promise<ArrayBufferLike>;
	/** This boot's prompt token. */
	readonly promptToken: string;
}

export interface WorkerLike {
	postMessage(message: ToVm, transfer: Transferable[]): void;
	terminate(): void;
}

export interface WorkerEvents {
	message(message: FromVm): void;
	/** The thread itself failed: a script error, or it could not start. */
	error(reason: string): void;
}

export interface VmDeps {
	createWorker(name: MachineName, on: WorkerEvents): WorkerLike;
	/** Run fn once, ms from now. */
	after(ms: number, fn: () => void): void;
	now(): number;
}

export type StartVm = (boot: VmBoot, sink: VmSink) => Vm;

export function startVm(boot: VmBoot, sink: VmSink, deps: VmDeps): Vm {
	const ref: VmRef = { machine: boot.machine, attempt: boot.attempt };
	const { identity, spec } = boot.config;
	const startedAt = deps.now();
	// Set by the first failure and by stop: after either, the attempt is over and says nothing more.
	let over = false;
	let stopped: Promise<void> | undefined;

	const fail = (reason: string) => {
		if (over) return;
		over = true;
		sink.failed(ref, reason);
	};

	const worker = deps.createWorker(boot.machine, {
		message(m) {
			if (over) return;
			switch (m.type) {
				case "stage":
					if (m.stage !== "log") sink.stage(ref, m.stage);
					return;
				case "booted":
					sink.stage(ref, "configuring");
					return;
				case "ready":
					sink.ready(ref, Math.round(deps.now() - startedAt));
					return;
				case "frame":
					sink.frame(ref, m.nic, m.frame);
					return;
				case "console":
					sink.consoleBytes(ref, m.bytes);
					return;
				case "pty-ready":
					sink.ptyOpened(ref, m.sid);
					return;
				case "pty-output":
					sink.ptyBytes(ref, m.sid, m.bytes);
					return;
				case "pty-exit":
					sink.ptyExited(ref, m.sid);
					return;
				case "exited":
					fail(m.reason || `The guest exited with code ${m.code}.`);
					return;
				case "error":
					if (m.fatal) fail(m.message);
					else console.warn(`${ref.machine}: ${m.message}`);
					return;
				default:
					m satisfies never;
			}
		},
		error: fail,
	});

	const post = (m: ToVm, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

	const cfg: Omit<VmConfig, "image"> = {
		n: identity.n,
		name: identity.name,
		macs: NICS.slice(0, spec.nics.length).map((nic) => nicMac(identity.n, nic)),
		addresses: spec.nics.map((nic) => nic.address),
		distro: spec.image,
		memoryMiB: spec.memMiB,
		cpus: spec.cpus ?? 1,
		diskGiB: Number(spec.diskGiB ?? 4),
		hosts: boot.config.hosts,
		gateway: spec.gateway,
		cols: boot.cols,
		rows: boot.rows,
		promptToken: boot.promptToken,
	};

	sink.stage(ref, "fetching image");
	boot.image.then(
		(image) => {
			if (!over) post({ type: "boot", cfg: { ...cfg, image } });
		},
		(e: unknown) => fail(e instanceof Error ? e.message : String(e)),
	);

	return {
		write(tty, data) {
			post(tty === "console" ? { type: "input", data } : { type: "pty-data", sid: tty, data });
		},
		resize(tty, cols, rows) {
			post(tty === "console" ? { type: "resize", cols, rows } : { type: "pty-resize", sid: tty, cols, rows });
		},
		openPty(pty, cols, rows) {
			post({ type: "pty-open", spec: { sid: pty, cols, rows } });
		},
		closePty(pty) {
			post({ type: "pty-close", sid: pty });
		},
		reconfigure(hosts) {
			post({ type: "reconfigure", name: identity.name, hosts });
		},
		deliver(nic, frame) {
			// The switch shares one frame with every port of a flood, so the
			// bytes are copied before the buffer is transferred away.
			const copy = frame.slice();
			post({ type: "frame", nic, frame: copy }, [copy.buffer]);
		},
		stop() {
			stopped ??= new Promise((resolve) => {
				over = true;
				post({ type: "stop" });
				deps.after(STOP_GRACE_MS, () => {
					worker.terminate();
					resolve();
				});
			});
			return stopped;
		},
	};
}
