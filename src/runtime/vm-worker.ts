// One Linux machine, alone in its thread.
//
// Frames a NIC sends go to the page's switch over postMessage and reach the
// other machines at layer 2. eth0 also reaches a NetStack that handles DHCP,
// DNS and the supported package repositories.
//
// Terminals come in two kinds. The kernel console (one per machine) carries
// the boot log and a shell. Beyond that each tab opens its own pty through
// vm.spawn(), so a machine can have several independent shells.

import { BootError, CowDisk, createKernel, type KernelInstance, NetStack, type Pty } from "unkernel";
import { type Device, type DiskCopy, disksOf, SHUTDOWN_MS } from "../model/index.ts";
import { defaultName } from "../net/index.ts";
import { rootStore } from "./disk-stores.ts";
import { keepSaved, openExtraDisk } from "./extra-disk.ts";
import { execAsRoot, hostsScript, setupScript } from "./guest.ts";
import { MemoryDisk } from "./image.ts";
import { copyLive, type LiveCopy, type LiveDisk, watchable } from "./live-copy.ts";
import { MachineNics } from "./machine-nics.ts";
import { alpinePackageSetup, packageBackend } from "./package-repositories.ts";
import { nextOf, saveDisks, shutDown, syncGuest } from "./power.ts";
import type { FromVm, PtySpec, ToVm, VmConfig } from "./protocol.ts";
import { createShellTracker } from "./shell-tracker.ts";
import { copyFailure, memoryShortage, storageFailure } from "./shortage.ts";

function post(m: FromVm, transfer: Transferable[] = []): void {
	self.postMessage(m, transfer);
}

function fail(message: string, fatal: boolean): void {
	post({ type: "error", message, fatal });
}

type Queued = Exclude<ToVm, { type: "boot" | "frame" | "release" }>;

/** A guest that goes down ends what it runs first: how long before its kernel, when nothing much is left to write. */
const GOING_DOWN_MS = 5000;

let vm: KernelInstance | undefined;
/** Every disk the guest writes, the root's first. */
let disks: readonly LiveDisk[] = [];
let copying: LiveCopy | undefined;
/** Once the kernel has ended and its disks are saved. Whether they were. */
let saved: Promise<boolean> | undefined;
/** The kernel has ended. */
let over = false;
let nics: MachineNics | undefined;
/** Shells opened beside the console, by session id. */
const ptys = new Map<number, Pty>();
/** Messages that arrive while the kernel is still booting. */
const queued: Queued[] = [];
let booting = true;
// Each host-table update rewrites the same guest file. Apply them in publication order.
let hostUpdate = Promise.resolve();

self.addEventListener("message", (ev: MessageEvent<ToVm>) => {
	const m = ev.data;
	if (m.type === "boot") {
		void boot(m.cfg);
		return;
	}
	if (m.type === "frame") {
		// Never queued: a NIC whose driver is not up yet drops frames, as a real one does.
		nics?.deliver(m.nic, m.frame);
		return;
	}
	if (m.type === "release") {
		void release(m.how);
		return;
	}
	if (booting) {
		queued.push(m);
		return;
	}
	handle(m);
});

async function release(how: Extract<ToVm, { type: "release" }>["how"]): Promise<void> {
	let clean = true;
	if (vm) {
		if (how !== "save") clean = await shutDown(vm, how, SHUTDOWN_MS);
		// Ends nothing when the guest has shut down.
		void vm.stop({ code: 0, reason: "powered off" });
		clean = (await saved) === true && clean;
	}
	post({ type: "released", clean });
}

function handle(m: Queued): void {
	if (!vm) return;
	switch (m.type) {
		case "input":
			vm.write(m.data);
			return;
		case "resize":
			vm.resize(m.cols, m.rows);
			return;
		case "reconfigure":
			hostUpdate = hostUpdate
				.then(() => reconfigure(m))
				.catch((error: unknown) => {
					fail(`reconfigure: ${error instanceof Error ? error.message : String(error)}`, false);
				});
			return;
		case "pty-open":
			void openPty(m.spec);
			return;
		case "pty-data":
			// Ordered with other writes on this pty; a rejection means it ended.
			void ptys
				.get(m.sid)
				?.write(m.data)
				.catch(() => {});
			return;
		case "pty-resize":
			ptys.get(m.sid)?.resize(m.cols, m.rows);
			return;
		case "pty-close":
			void ptys.get(m.sid)?.kill();
			ptys.delete(m.sid);
			return;
		case "checkpoint":
			void checkpoint(m.copy);
			return;
		case "stop":
			for (const p of ptys.values()) void p.kill();
			ptys.clear();
			vm.stop({ code: 0, reason: "powered off" });
			return;
	}
}

async function reconfigure(m: Extract<ToVm, { type: "reconfigure" }>): Promise<void> {
	if (!vm) return;
	const r = await execAsRoot(vm, hostsScript({ hostname: m.name, hosts: m.hosts }));
	if (r.exitCode !== 0) fail(`reconfigure: ${String(r.stderr).trim()}`, false);
}

async function checkpoint(copy: DiskCopy): Promise<void> {
	if (!vm || over) return;
	const guest = vm;
	const running = copyLive(
		copy,
		disks,
		() => syncGuest(guest),
		(percent) => post({ type: "copy", report: { kind: "progress", percent } }),
	);
	copying = running;
	try {
		post({ type: "copy", report: { kind: "done", bytes: await running.done } });
	} catch (error) {
		post({ type: "copy", report: { kind: "failed", reason: copyFailure(copy, "save", error) } });
	}
	copying = undefined;
}

/**
 * A shell on its own pty (/dev/pts/N), independent of the kernel console, so
 * one machine can have several terminals open at once. The guest's default
 * login shell and user are used, as the console's are.
 */
async function openPty(spec: PtySpec): Promise<void> {
	if (!vm) return;
	let pty: Pty;
	try {
		pty = await vm.spawn(undefined, undefined, { pty: true, cols: spec.cols, rows: spec.rows, term: "xterm-256color" });
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		post({ type: "pty-exit", sid: spec.sid, code: null, reason, lost: false });
		return;
	}
	ptys.set(spec.sid, pty);
	post({ type: "pty-ready", sid: spec.sid, pid: pty.pid, pts: pty.pts });

	// A pull stream: vsock credit follows what is read, so keep reading or the
	// guest blocks once its window is full.
	void (async () => {
		const reader = pty.output.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const copy = value.slice();
				post({ type: "pty-output", sid: spec.sid, bytes: copy }, [copy.buffer]);
			}
		} catch {
			// Whatever went wrong is reported through `ended` below.
		}
	})();

	try {
		const end = await pty.ended;
		post({
			type: "pty-exit",
			sid: spec.sid,
			code: end.type === "exit" ? end.code : null,
			reason: end.type === "exit" ? "" : end.type === "signal" ? `signal ${end.signal}` : end.type,
			lost: end.type === "lost",
		});
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		post({ type: "pty-exit", sid: spec.sid, code: null, reason, lost: true });
	}
	ptys.delete(spec.sid);
}

async function boot(c: VmConfig): Promise<void> {
	const t0 = performance.now();

	// The gateway is a NetStack of its own, told the same MAC as eth0 so its
	// DHCP lease and ARP replies are addressed to this machine.
	const gateway = c.gateway ? new NetStack({ mac: c.macs[0], backend: packageBackend() }) : undefined;

	nics = new MachineNics({
		macs: c.macs,
		gateway,
		// A right-sized copy already, so transferring it costs nothing further.
		toSwitch: (nic, frame) => post({ type: "frame", nic, frame }, [frame.buffer]),
		lost: (nic, reason) => {
			setTimeout(() => {
				if (!over) post({ type: "nic-lost", nic, reason });
			}, GOING_DOWN_MS);
		},
	});

	const [root, ...extra] = disksOf(c);
	const unsaved = (device: Device) => (error: unknown) => fail(storageFailure(c.name, device, error), true);

	try {
		post({ type: "stage", stage: "download" });
		const extras = await Promise.all(
			extra.map(({ device, gib }, i) =>
				openExtraDisk({ n: c.n, set: c.set, k: i + 1, gib, onError: unsaved(device) }).catch((error: unknown) => {
					throw new Error(storageFailure(c.name, device, error));
				}),
			),
		);
		vm = await createKernel({
			distro: new MemoryDisk(c.image),
			disks: [{ kind: "data", template: "bundled", name: rootStore(c.n, c.set), size: root.gib * 2 ** 30 }, ...extras],
			// The extra disks report their own.
			onDiskError: (_, error) => unsaved(root.device)(error),
			net: nics.eth0,
			memoryMiB: c.memoryMiB,
			memoryFallbackMiB: [],
			cpus: c.cpus,
			consoleSize: { cols: c.cols, rows: c.rows },
			onProgress: (p) => post({ type: "stage", stage: p.stage }),
			log: (line) => post({ type: "stage", stage: "log", detail: line }),
		});
		if (vm.stats().cpus !== (c.cpus ?? 1))
			throw new Error(`Requested ${c.cpus} CPUs but the browser started ${vm.stats().cpus}.`);
		const [, ...attached] = vm.kernel.block.disks;
		for (const [i, { device }] of [root, ...extra].entries()) {
			const disk = attached[i];
			if (disk?.persistent) continue;
			const notice = disk instanceof CowDisk ? disk.notice : undefined;
			throw new Error(storageFailure(c.name, device, notice ?? "it is not kept"));
		}
		keepSaved(extras);
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		fail(e instanceof BootError && e.stage === "memory" ? memoryShortage(c.name, c.memoryMiB) : reason, true);
		return;
	}

	const kept = vm.kernel.block.disks.filter((disk) => disk instanceof CowDisk);
	disks = kept.map((disk) => ({ disk, store: watchable(disk) }));
	saved = vm.exited.then((exit) => {
		over = true;
		const next = nextOf(exit);
		if (next) post({ type: "halted", next });
		else if (exit.kind !== "stopped") post({ type: "exited", code: exit.code, reason: exit.reason });
		void copying?.giveUp(new Error("It stopped."));
		return saveDisks(kept);
	});

	post({ type: "booted", ms: Math.round(performance.now() - t0) });

	const shell = createShellTracker();
	let prompted = () => {};
	shell.expectToken(c.promptToken);
	const firstPrompt = new Promise<void>((resolve) => {
		prompted = resolve;
	});
	vm.onOutput((bytes) => {
		if (shell.phase === "unknown") {
			shell.scan(bytes);
			if (shell.phase !== "unknown") prompted();
		}
		const copy = bytes.slice();
		post({ type: "console", bytes: copy }, [copy.buffer]);
	});

	// The NICs, name, addresses, /etc/hosts and the marked prompt; with a
	// gateway, udhcpc also brings up 10.0.2.15 and the default route. A machine that
	// cannot be set up is not on the lab, so it has not booted.
	try {
		await nics.start(vm);
		const setup = setupScript({
			hostname: c.name,
			namedPrompt: c.name !== defaultName(c.n),
			addresses: c.addresses,
			hosts: c.hosts,
			gateway: c.gateway,
			promptToken: c.promptToken,
		});
		const r = await execAsRoot(vm, c.gateway ? `${alpinePackageSetup}\n${setup}` : setup);
		if (r.exitCode !== 0) {
			fail(`setup: ${String(r.stderr).trim() || `exit ${r.exitCode}`}`, true);
			return;
		}
	} catch (e) {
		// A guest that shuts down while it is set up ends the session it is set up through.
		const late = new Promise((resolve) => setTimeout(resolve, GOING_DOWN_MS));
		await Promise.race([vm.exited, late]);
		if (!over) fail(`setup: ${e instanceof Error ? e.message : String(e)}`, true);
		return;
	}

	// Ready is the first prompt that carries setup's marks: from here the page
	// can tell a busy shell from an idle one, and input reaches a shell that reads it.
	await firstPrompt;

	booting = false;
	post({ type: "ready", ms: Math.round(performance.now() - t0) });
	for (const m of queued.splice(0)) handle(m);
}
