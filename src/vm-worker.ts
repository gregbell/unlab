// One Linux machine, alone in its thread.
//
// The kernel gets a LabNic as its network device, which splits what the guest
// sends: lab traffic goes to the page's switch over postMessage and reaches
// the other machines at layer 2, while anything else goes to a NetStack that
// NATs to the internet over Wisp.
//
// Terminals come in two kinds. The kernel console (one per machine) carries
// the boot log and a shell. Beyond that each tab opens its own pty through
// vm.spawn(), so a machine can have several independent shells.

import { createKernel, DEFAULT_WISP_SERVERS, type KernelInstance, NetStack, type Pty, wispBackend } from "unkernel";
import { execAsRoot, setupScript } from "./lab/guest.ts";
import { MemoryDisk } from "./lab/image.ts";
import { LabNic } from "./lab/nic.ts";
import type { FromVm, PtySpec, ToVm, VmConfig } from "./lab/protocol.ts";
import { Subnet } from "./net/index.ts";

function post(m: FromVm, transfer: Transferable[] = []): void {
	self.postMessage(m, transfer);
}

function fail(message: string, fatal: boolean): void {
	post({ type: "error", message, fatal });
}

let vm: KernelInstance | undefined;
let nic: LabNic | undefined;
let cfg: VmConfig | undefined;
/** Shells opened beside the console, by session id. */
const ptys = new Map<number, Pty>();
/** Messages that arrive while the kernel is still booting. */
const queued: ToVm[] = [];
let booting = true;

self.addEventListener("message", (ev: MessageEvent<ToVm>) => {
	const m = ev.data;
	if (m.type === "boot") {
		void boot(m.cfg);
		return;
	}
	if (booting) {
		queued.push(m);
		return;
	}
	handle(m);
});

function handle(m: ToVm): void {
	if (!vm) return;
	switch (m.type) {
		case "frame":
			nic?.deliver(m.frame);
			return;
		case "input":
			vm.write(m.data);
			return;
		case "resize":
			vm.resize(m.cols, m.rows);
			return;
		case "exec":
			void runExec(m.id, m.cmd, m.root ?? false);
			return;
		case "reconfigure":
			void reconfigure(m);
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

async function runExec(id: number, cmd: string, root: boolean): Promise<void> {
	if (!vm) return;
	try {
		const r = root ? await execAsRoot(vm, cmd) : await vm.exec("/bin/sh", ["-c", cmd]);
		post({ type: "exec-result", id, exitCode: r.exitCode, stdout: String(r.stdout), stderr: String(r.stderr) });
	} catch (e) {
		post({ type: "exec-result", id, exitCode: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
	}
}

async function reconfigure(m: Extract<ToVm, { type: "reconfigure" }>): Promise<void> {
	if (!vm || !cfg) return;
	cfg = { ...cfg, name: m.name, ip: m.ip, prefixBits: m.prefixBits, hosts: m.hosts, internet: m.internet };
	const r = await execAsRoot(
		vm,
		setupScript({ hostname: m.name, ip: m.ip, prefixBits: m.prefixBits, hosts: m.hosts, dhcp: m.internet }),
	);
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
	cfg = c;
	const t0 = performance.now();
	const lab = new Subnet(c.labCidr);

	// The uplink is a NetStack of its own, told the same MAC as the NIC so its
	// DHCP lease and ARP replies are addressed to this machine.
	const uplink = c.internet
		? new NetStack({
				backend: wispBackend(c.wispServers?.length ? c.wispServers : [...DEFAULT_WISP_SERVERS]),
				mac: c.mac,
			})
		: undefined;

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
			net: nic,
			memoryMiB: c.memoryMiB,
			consoleSize: { cols: c.cols, rows: c.rows },
			onProgress: (p) => post({ type: "stage", stage: p.stage }),
			log: (line) => post({ type: "stage", stage: "log", detail: line }),
		});
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e), true);
		return;
	}

	post({ type: "booted", ms: Math.round(performance.now() - t0) });
	vm.onOutput((bytes) => {
		const copy = bytes.slice();
		post({ type: "console", bytes: copy }, [copy.buffer]);
	});
	void vm.exited.then((r) => post({ type: "exited", code: r.code, reason: r.reason ?? "" }));

	// Name, lab address and /etc/hosts; with an uplink, udhcpc also brings up
	// 10.0.2.15 and the default route.
	try {
		const r = await execAsRoot(
			vm,
			setupScript({ hostname: c.name, ip: c.ip, prefixBits: c.prefixBits, hosts: c.hosts, dhcp: c.internet }),
		);
		if (r.exitCode !== 0) fail(`setup: ${String(r.stderr).trim() || `exit ${r.exitCode}`}`, false);
	} catch (e) {
		fail(`setup: ${e instanceof Error ? e.message : String(e)}`, false);
	}

	booting = false;
	post({ type: "ready", ms: Math.round(performance.now() - t0) });
	for (const m of queued.splice(0)) handle(m);
}
