// One Linux machine, alone in its thread.
//
// The kernel gets a LabNic as its network device, which splits what the guest
// sends: lab traffic goes to the page's switch over postMessage and reaches
// the other machines at layer 2, while anything else goes to a NetStack that
// NATs to the internet over Wisp.

import { DEFAULT_WISP_SERVERS, NetStack, createKernel, wispBackend, type KernelInstance } from "unkernel";
import { Subnet } from "./lab/frames.ts";
import { MemoryDisk } from "./lab/image.ts";
import { execAsRoot, setupScript } from "./lab/guest.ts";
import { LabNic } from "./lab/nic.ts";
import type { FromVm, ToVm, VmConfig } from "./lab/protocol.ts";

function post(m: FromVm, transfer: Transferable[] = []): void {
	self.postMessage(m, transfer);
}

function fail(message: string, fatal: boolean): void {
	post({ type: "error", message, fatal });
}

let vm: KernelInstance | undefined;
let nic: LabNic | undefined;
let cfg: VmConfig | undefined;
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
		case "stop":
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
	const r = await execAsRoot(vm, setupScript({ hostname: m.name, ip: m.ip, prefixBits: m.prefixBits, hosts: m.hosts, dhcp: m.internet }));
	if (r.exitCode !== 0) fail(`reconfigure: ${String(r.stderr).trim()}`, false);
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
			onProgress: (p) => post({ type: "stage", stage: p.stage, detail: p.stage === "download" ? `${Math.round((p.loaded / Math.max(1, p.total)) * 100)}%` : undefined }),
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
		const r = await execAsRoot(vm, setupScript({ hostname: c.name, ip: c.ip, prefixBits: c.prefixBits, hosts: c.hosts, dhcp: c.internet }));
		if (r.exitCode !== 0) fail(`setup: ${String(r.stderr).trim() || `exit ${r.exitCode}`}`, false);
	} catch (e) {
		fail(`setup: ${e instanceof Error ? e.message : String(e)}`, false);
	}

	booting = false;
	post({ type: "ready", ms: Math.round(performance.now() - t0) });
	for (const m of queued.splice(0)) handle(m);
}
