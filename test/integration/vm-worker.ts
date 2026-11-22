// One machine, in its own thread. Mirrors what the browser worker does.
import { parentPort, workerData } from "node:worker_threads";
import { createKernel } from "unkernel/node";
import { Subnet } from "../../src/net/index.ts";
import { execAsRoot, setupScript } from "../../src/runtime/guest.ts";
import { LabNic } from "../../src/runtime/nic.ts";

const port = parentPort;
if (!port) throw new Error("not a worker");

const { name, ip, mac, labCidr, distro, memoryMiB, prefixBits, hosts } = workerData as {
	name: string;
	ip: string;
	mac: string;
	labCidr: string;
	distro: string;
	memoryMiB: number;
	prefixBits: number;
	hosts?: Array<{ ip: string; name: string }>;
};

const lab = new Subnet(labCidr);
const nic = new LabNic({
	mac,
	lab,
	toSwitch: (frame) => port.postMessage({ type: "frame", frame }, [frame.buffer as ArrayBuffer]),
});

const say = (type: string, extra: Record<string, unknown> = {}) => port.postMessage({ type, ...extra });

let booted = false;
try {
	const vm = await createKernel({
		distro,
		net: nic,
		memoryMiB,
		log: (m) => say("log", { line: m }),
	});

	port.on("message", (m: { type: string; frame?: ArrayBufferLike }) => {
		if (m.type === "frame" && m.frame) nic.deliver(new Uint8Array(m.frame as ArrayBuffer));
		else if (m.type === "stop") vm.stop?.({ code: 0, reason: "stopped" });
	});

	const r = await execAsRoot(
		vm,
		setupScript({ hostname: name, ip, prefixBits, hosts: hosts ?? [], dhcp: false, promptToken: "0123456789abcdef" }),
	);
	booted = true;
	say("booted", { exitCode: r.exitCode, stderr: String(r.stderr ?? "") });

	port.on("message", async (m: { type: string; id?: number; cmd?: string; root?: boolean }) => {
		if (m.type !== "exec" || !m.cmd) return;
		try {
			const out = m.root ? await execAsRoot(vm, m.cmd) : await vm.exec("/bin/sh", ["-c", m.cmd]);
			say("exec-result", {
				id: m.id,
				exitCode: out.exitCode,
				stdout: String(out.stdout ?? ""),
				stderr: String(out.stderr ?? ""),
			});
		} catch (e) {
			say("exec-result", { id: m.id, exitCode: -1, stdout: "", stderr: String(e) });
		}
	});
} catch (e) {
	say(booted ? "error" : "boot-error", { message: e instanceof Error ? `${e.message}` : String(e) });
}
