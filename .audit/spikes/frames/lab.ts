// Throwaway. Real guests on a lab network, on the page or in a worker, driven by Playwright through window.lab.
import { createCaptureLog } from "../../../src/capture/index.ts";
import { defaultAddress, ip4str, macStr, nodeMac } from "../../../src/net/index.ts";
import { arpRequest } from "../../../test/support/frames.ts";
import { type Core, type CoreOptions, createCore } from "./core.ts";
import type { Conditions } from "./fabric.ts";

interface Options extends CoreOptions {
	where: "main" | "worker";
	rxLimit: number;
	clock?: "worker";
	image: string;
}
const now = () => performance.now();
const workers: Worker[] = [];
const out: string[] = [];
let call: (name: string, ...args: unknown[]) => Promise<unknown>;
const capture = createCaptureLog({ now, schedule: (fn) => requestAnimationFrame(fn) });
let skipped = 0;
capture.subscribe(() => void capture.tail(20));
// The engine does this on its tick. Without it every unanswered ARP request is kept.
if (!location.search.includes("nosweep")) setInterval(() => capture.sweep(now()), 1000);

async function boot(o: Options) {
	const image = await (await fetch(`/distros/${o.image}.erofs`)).arrayBuffer();
	const shared = new SharedArrayBuffer(image.byteLength);
	new Uint8Array(shared).set(new Uint8Array(image));
	const spikeWorker = o.design !== "today" || o.window > 0;
	for (let m = 0; m < o.machines; m++)
		workers.push(
			spikeWorker
				? new Worker(new URL("./spike-vm-worker.ts", import.meta.url), { type: "module" })
				: new Worker(new URL("../../../src/runtime/vm-worker.ts", import.meta.url), { type: "module" }),
		);
	let core: Core | undefined;
	if (o.clock === "worker") {
		const clock = new Worker(new URL("./alarm-worker.ts", import.meta.url), { type: "module" });
		const due = new Map<number, () => void>();
		let ids = 0;
		clock.onmessage = ({ data }) => {
			const fn = due.get(data);
			due.delete(data);
			fn?.();
		};
		o.alarm = (ms, fn) => {
			const id = ++ids;
			due.set(id, fn);
			clock.postMessage({ id, ms });
			return () => {
				due.delete(id);
				clock.postMessage({ id, ms: -1 });
			};
		};
	}
	if (o.where === "main") {
		core = await createCore(
			o,
			(m, frame) => {
				const copy = frame.slice();
				workers[m].postMessage({ type: "frame", nic: 0, frame: copy }, [copy.buffer]);
			},
			(_, e) => capture.appendFrame(e),
		);
		call = async (name, ...args) => (core as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
		if (spikeWorker) for (const w of workers) w.postMessage({ type: "spike", rxLimit: o.rxLimit, acks: o.window > 0 });
	} else {
		const fw = new Worker(new URL("./fabric-worker.ts", import.meta.url), { type: "module" });
		const mine: MessagePort[] = [];
		for (const w of workers) {
			const c = new MessageChannel();
			mine.push(c.port1);
			w.postMessage({ type: "spike", rxLimit: o.rxLimit, acks: o.window > 0, port: c.port2 }, [c.port2]);
		}
		fw.postMessage({ type: "init", options: o, ports: mine }, mine);
		let ids = 0;
		const pending = new Map<number, (v: unknown) => void>();
		fw.onmessage = ({ data }) => {
			if (data.type === "taps") {
				skipped += data.skipped;
				for (const e of data.batch) capture.appendFrame(e);
			} else {
				pending.get(data.id)?.(data.result);
				pending.delete(data.id);
			}
		};
		call = (name, ...args) =>
			new Promise((resolve) => {
				pending.set(++ids, resolve);
				fw.postMessage({ id: ids, call: name, args });
			});
	}
	const hosts = workers.map((_, m) => ({ ip: ip4str(defaultAddress(m + 1).ip), name: `node${m + 1}` as never }));
	await Promise.all(
		workers.map(async (w, m) => {
			const n = m + 1;
			out[m] = "";
			await new Promise<void>((resolve, reject) => {
				w.onerror = (e) => reject(new Error(e.message));
				w.addEventListener("message", ({ data }) => {
					if (data.type === "frame") core?.receive(m, data.frame);
					else if (data.type === "ack") core?.ack(m, data.n);
					else if (data.type === "ready") resolve();
					else if (data.type === "error" && data.fatal) reject(new Error(data.message));
					else if (data.type === "pty-output") {
						out[m] += new TextDecoder().decode(data.bytes);
						for (const fn of [...said]) fn();
					}
				});
				w.postMessage({
					type: "boot",
					cfg: { n, name: `node${n}`, macs: [macStr(nodeMac(n))], addresses: [defaultAddress(n)], image: shared, memoryMiB: 256, cpus: 1, disks: { root: "4", extra: [] }, set: 0, hosts, gateway: false, cols: 200, rows: 50, promptToken: "0123456789abcdef" },
				});
			});
			await new Promise<void>((resolve) => {
				w.addEventListener("message", ({ data }) => data.type === "pty-ready" && resolve());
				w.postMessage({ type: "pty-open", spec: { sid: 1, cols: 200, rows: 50 } });
			});
		}),
	);
}

let seq = 0;
/** Called at any shell output: a timer would be throttled with the tab. */
const said = new Set<() => void>();
/** Run a line in machine m's shell. Waits for it at most `ms`. */
async function sh(m: number, line: string, ms = 60_000): Promise<{ ms: number; out: string }> {
	const id = ++seq;
	const from = out[m].length;
	const t0 = now();
	workers[m].postMessage({ type: "pty-data", sid: 1, data: `echo "S""_${id}"; ${line}; echo "E""_${id} $?"\r` });
	return new Promise((resolve) => {
		const settle = (r: { ms: number; out: string }) => {
			said.delete(look);
			clearTimeout(timer);
			resolve(r);
		};
		const look = () => {
			const text = out[m].slice(from);
			const end = text.indexOf(`E_${id} `);
			if (end >= 0) settle({ ms: now() - t0, out: text.slice(text.indexOf(`S_${id}`) + `S_${id}`.length, end).trim() });
		};
		const timer = setTimeout(() => settle({ ms: -1, out: out[m].slice(from) }), ms);
		said.add(look);
	});
}

let gaps: number[] = [];
let probing = false;
let paints = 0;
let probeAt = 0;
function probe(on: boolean) {
	if (!on) {
		probing = false;
		return { paintsPerS: (paints * 1000) / (now() - probeAt), max: Math.max(0, ...gaps), n: gaps.length, p50: gaps.toSorted((a, b) => a - b)[gaps.length >> 1] };
	}
	gaps = [];
	probing = true;
	paints = 0;
	probeAt = now();
	const paint = () => {
		paints++;
		if (probing) requestAnimationFrame(paint);
	};
	requestAnimationFrame(paint);
	let due = now() + 20;
	const beat = () => {
		gaps.push(now() - due);
		due = now() + 20;
		if (probing) setTimeout(beat, 20);
	};
	setTimeout(beat, 20);
	return null;
}
const vmProbe = (m: number) =>
	Promise.race([
		new Promise((resolve) => {
			const id = ++seq;
			const on = ({ data }: MessageEvent) => {
				if (data.type !== "probe" || data.id !== id) return;
				workers[m].removeEventListener("message", on);
				resolve(data);
			};
			workers[m].addEventListener("message", on);
			workers[m].postMessage({ type: "probe", id });
		}),
		new Promise((r) => setTimeout(() => r("no answer in 2 s"), 2000)),
	]);

Object.assign(window, {
	lab: {
		boot,
		sh,
		probe,
		vmProbe,
		call: (name: string, ...args: unknown[]) => call(name, ...args),
		storm: () => call("inject", 0, 6, arpRequest(7, 8)),
		conditions: (m: number, c: Conditions | null) => call("conditions", m, c),
		captured: () => ({ ...capture.counters, skipped }),
	},
});
