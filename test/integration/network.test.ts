// Proves the lab network: two unkernel machines, each in its own thread,
// bridged by the layer-2 switch, reach each other with ARP, ICMP and TCP.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fetchDistro } from "unkernel/node";
import { test } from "vitest";
import type { PortNo } from "../../src/model/types.ts";
import { arpAddrs, dstMac, ethertype, IP_ICMP, IP_TCP, ipAddrs, labMac, Subnet } from "../../src/net/index.ts";
import { LabSwitch } from "../../src/runtime/switch.ts";

const LAB = new Subnet("10.88.0.0/24");
const WORKER = new URL("./vm-worker.ts", import.meta.url);

interface Machine {
	name: string;
	worker: Worker;
	exec(cmd: string, root?: boolean): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function boot(
	sw: LabSwitch,
	port: PortNo,
	name: string,
	hostNum: number,
	distro: string,
	hosts: Array<{ ip: string; name: string }>,
): Promise<Machine> {
	const ip = LAB.host(hostNum);
	const worker = new Worker(WORKER, {
		workerData: {
			name,
			ip,
			mac: labMac(hostNum),
			labCidr: LAB.toString(),
			distro,
			memoryMiB: 256,
			prefixBits: LAB.bits,
			hosts,
		},
	});
	const pending = new Map<number, (r: { exitCode: number; stdout: string; stderr: string }) => void>();
	let nextId = 1;

	const ready = new Promise<void>((resolve, reject) => {
		worker.on("message", (m: Record<string, string | number>) => {
			if (m.type === "frame") sw.receive(port, new Uint8Array(m.frame as unknown as ArrayBuffer));
			else if (m.type === "booted") resolve();
			else if (m.type === "boot-error" || m.type === "error") reject(new Error(String(m.message)));
			else if (m.type === "exec-result") {
				pending.get(m.id as number)?.({
					exitCode: m.exitCode as number,
					stdout: m.stdout as string,
					stderr: m.stderr as string,
				});
				pending.delete(m.id as number);
			}
		});
		worker.on("error", reject);
	});

	sw.attach(port, {
		deliver: (frame) => {
			// A right-sized copy: transferring the switch's frame would detach it
			// for the other ports of the same flood.
			const copy = frame.slice();
			worker.postMessage({ type: "frame", frame: copy }, [copy.buffer]);
		},
	});
	await ready;

	return {
		name,
		worker,
		exec(cmd, root) {
			const id = nextId++;
			return new Promise((resolve) => {
				pending.set(id, resolve);
				worker.postMessage({ type: "exec", id, cmd, root: root ?? false });
			});
		},
	};
}

test("two machines share one layer-2 segment", { timeout: 300_000 }, async () => {
	const distro = await fetchDistro("alpine");
	const sw = new LabSwitch();
	const seen: string[] = [];
	const kinds = new Map<string, number>();
	const DB1_MAC = labMac(12);
	let unknownToDb1 = 0;
	sw.onTap((e) => {
		if (e.from === 1 && e.flood === "unknown" && dstMac(e.frame) === DB1_MAC) unknownToDb1++;
		const arp = arpAddrs(e.frame);
		const ip = ipAddrs(e.frame);
		const k = arp
			? `arp op=${arp.op}`
			: ip?.proto === IP_ICMP
				? "icmp"
				: ip?.proto === IP_TCP
					? "tcp"
					: `et=0x${ethertype(e.frame).toString(16)} proto=${ip?.proto ?? "-"}`;
		seen.push(k);
		kinds.set(k, (kinds.get(k) ?? 0) + 1);
	});

	let machines: Machine[] = [];
	try {
		const t0 = Date.now();
		const hosts = [
			{ ip: LAB.host(11), name: "web1" },
			{ ip: LAB.host(12), name: "db1" },
		];
		const [web1, db1] = await Promise.all([
			boot(sw, 1, "web1", 11, distro, hosts),
			boot(sw, 2, "db1", 12, distro, hosts),
		]);
		machines = [web1, db1];
		console.log(`both machines booted in ${Date.now() - t0} ms`);

		const addr = await web1.exec("ip -4 -o addr show eth0");
		console.log(`web1 eth0: ${addr.stdout.trim()}`);
		assert.match(addr.stdout, /10\.88\.0\.11/, "web1 should hold its lab address");

		// ICMP across the switch: ARP resolution then echo request/reply.
		const ping = await web1.exec(`ping -c 3 -W 2 ${LAB.host(12)}`, true);
		console.log(`ping:\n${ping.stdout.trim()}\n${ping.stderr.trim()}`);
		assert.equal(ping.exitCode, 0, "web1 should ping db1");
		assert.match(ping.stdout, /3 packets transmitted, 3 (packets )?received/);

		// The guests' own ARP tables, resolved over the switch.
		const arpTable = await web1.exec("ip neigh show");
		console.log(`web1 neighbours: ${arpTable.stdout.trim()}`);
		assert.match(arpTable.stdout, /10\.88\.0\.12/);

		// Real TCP between the two kernels.
		void db1.exec("printf 'hello-from-db1\\n' | nc -l -p 9000 -w 10", true);
		await new Promise((r) => setTimeout(r, 1500));
		const tcp = await web1.exec(`nc -w 5 ${LAB.host(12)} 9000`);
		console.log(`tcp payload: ${JSON.stringify(tcp.stdout)}`);
		assert.match(tcp.stdout, /hello-from-db1/, "TCP payload should cross the segment");

		console.log(`frames on the wire: ${JSON.stringify([...kinds])}`);
		assert.ok(
			seen.some((s) => s.startsWith("arp")),
			"the switch should have seen ARP",
		);
		assert.ok(seen.includes("icmp"), "the switch should have seen ICMP");
		assert.ok(seen.includes("tcp"), "the switch should have seen TCP");

		const db1Entry = () => sw.macTable().find((e) => e.mac === DB1_MAC);
		sw.setLink(2, false);
		assert.deepEqual(
			{ port: db1Entry()?.port, flushed: db1Entry()?.flushed },
			{ port: 2, flushed: true },
			"a cut keeps db1's entry, flushed",
		);
		const floodsBeforeCut = unknownToDb1;
		const cutPing = await web1.exec(`ping -c 1 -W 1 ${LAB.host(12)}`, true);
		assert.notEqual(cutPing.exitCode, 0, "a ping across a cut cable should fail");
		assert.ok(unknownToDb1 > floodsBeforeCut, "frames for db1 should flood as an unknown destination");

		sw.setLink(2, true);
		const healed = await web1.exec(`ping -c 2 -W 2 ${LAB.host(12)}`, true);
		assert.equal(healed.exitCode, 0, "web1 should reach db1 again after reconnecting");
		assert.equal(db1Entry()?.flushed, false, "db1's address is relearned on port 2");

		const c = sw.counters(1);
		console.log(`web1 port: rx=${c?.rxFrames} tx=${c?.txFrames} flooded=${c?.flooded}`);
		console.log(`mac table: ${JSON.stringify(sw.macTable())}`);
	} finally {
		await Promise.all(machines.map((m) => m.worker.terminate()));
	}
});
