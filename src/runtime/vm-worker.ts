// One Linux machine, alone in its thread.
//
// The kernel gets a LabNic as its network device, which splits what the guest
// sends: lab traffic goes to the page's switch over postMessage and reaches
// the other machines at layer 2, while anything else goes to a NetStack that
// handles DHCP, DNS and the supported package repositories.
//
// Terminals come in two kinds. The kernel console (one per machine) carries
// the boot log and a shell. Beyond that each tab opens its own pty through
// vm.spawn(), so a machine can have several independent shells.

import { createKernel, type KernelInstance, NetStack, type Pty } from "unkernel";
import { Subnet } from "../net/index.ts";
import { diskName } from "./disk-name.ts";
import { execAsRoot, hostsScript, setupScript } from "./guest.ts";
import { MemoryDisk } from "./image.ts";
import { LabNic } from "./nic.ts";
import { alpinePackageSetup, packageBackend } from "./package-repositories.ts";
import type { FromVm, PtySpec, ToVm, VmConfig } from "./protocol.ts";
import { createShellTracker } from "./shell-tracker.ts";

function post(m: FromVm, transfer: Transferable[] = []): void {
	self.postMessage(m, transfer);
}

function fail(message: string, fatal: boolean): void {
	post({ type: "error", message, fatal });
}

type Queued = Exclude<ToVm, { type: "boot" | "frame" }>;

let vm: KernelInstance | undefined;
let nic: LabNic | undefined;
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
		nic?.deliver(m.frame);
		return;
	}
	if (booting) {
		queued.push(m);
		return;
	}
	handle(m);
});

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
		case "stop":
			for (const p of ptys.values()) void p.kill();
			ptys.clear();
			vm.stop({ code: 0, reason: "powered off" });
			return;
	}
}

async function reconfigure(m: Extract<ToVm, { type: "reconfigure" }>): Promise<void> {
	if (!vm) return;
	const r = await execAsRoot(vm, hostsScript({ hostname: m.name, ip: m.ip, hosts: m.hosts }));
	if (r.exitCode !== 0) fail(`reconfigure: ${String(r.stderr).trim()}`, false);
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
		post({ type: "pty-exit", sid: spec.sid, code: null, reason: e instanceof Error ? e.message : String(e) });
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
		});
	} catch (e) {
		post({ type: "pty-exit", sid: spec.sid, code: null, reason: e instanceof Error ? e.message : String(e) });
	}
	ptys.delete(spec.sid);
}

async function boot(c: VmConfig): Promise<void> {
	const t0 = performance.now();
	const lab = new Subnet(c.labCidr);

	// The uplink is a NetStack of its own, told the same MAC as the NIC so its
	// DHCP lease and ARP replies are addressed to this machine.
	const uplink = c.packageRepositories ? new NetStack({ mac: c.mac, backend: packageBackend() }) : undefined;

	nic = new LabNic({
		mac: c.mac,
		lab,
		uplink,
		// A right-sized copy already, so transferring it costs nothing further.
		toSwitch: (frame) => post({ type: "frame", frame }, [frame.buffer]),
	});

	try {
		post({ type: "stage", stage: "download" });
		vm = await createKernel({
			distro: new MemoryDisk(c.image),
			disks: [{ kind: "data", template: "bundled", name: diskName(c.id), size: (c.diskGiB ?? 4) * 2 ** 30 }],
			onDiskError: (_, error) => fail(`Saving ${c.name} failed: ${error}`, true),
			net: nic,
			memoryMiB: c.memoryMiB,
			memoryFallbackMiB: [],
			cpus: c.cpus,
			consoleSize: { cols: c.cols, rows: c.rows },
			onProgress: (p) => post({ type: "stage", stage: p.stage }),
			log: (line) => post({ type: "stage", stage: "log", detail: line }),
		});
		if (vm.stats().cpus !== (c.cpus ?? 1))
			throw new Error(`Requested ${c.cpus} CPUs but the browser started ${vm.stats().cpus}.`);
		if (!vm.kernel.block.disks.some((d) => d.persistent))
			throw new Error("Persistent disk unavailable. Check browser storage and boot again.");
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e), true);
		return;
	}

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
	void vm.exited.then((r) => post({ type: "exited", code: r.code, reason: r.reason ?? "" }));

	// Name, lab address, /etc/hosts and the marked prompt; with an uplink,
	// udhcpc also brings up 10.0.2.15 and the default route. A machine that
	// cannot be set up is not on the lab, so it has not booted.
	try {
		const setup = setupScript({
			hostname: c.name,
			ip: c.ip,
			prefixBits: c.prefixBits,
			hosts: c.hosts,
			dhcp: Boolean(uplink),
			promptToken: c.promptToken,
		});
		const prepareApk = c.packageRepositories && c.distro === "alpine";
		const r = await execAsRoot(vm, prepareApk ? `${alpinePackageSetup}\n${setup}` : setup);
		if (r.exitCode !== 0) {
			fail(`setup: ${String(r.stderr).trim() || `exit ${r.exitCode}`}`, true);
			return;
		}
	} catch (e) {
		fail(`setup: ${e instanceof Error ? e.message : String(e)}`, true);
		return;
	}

	// Ready is the first prompt that carries setup's marks: from here the page
	// can tell a busy shell from an idle one, and input reaches a shell that reads it.
	await firstPrompt;

	booting = false;
	post({ type: "ready", ms: Math.round(performance.now() - t0) });
	for (const m of queued.splice(0)) handle(m);
}
