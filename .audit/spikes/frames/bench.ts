// Throwaway. The switch core alone, in Chromium: today's LabSwitch with the queue, the lean TypeScript core, the Zig core.
import { mac } from "../../../test/support/frames.ts";
import { build, Fabric } from "./fabric.ts";
import { type Env, LeanCore, type SwitchCore } from "./lean.ts";
import { zigCore } from "./zig-core.ts";

type Name = "LabSwitch+queue" | "lean TS" | "Zig";
let kept: Uint8Array | undefined;
let outs = 0;
const copying: Env = { out: (_s, _p, f) => { outs++; kept = f.slice(); }, tap: (_s, _f, _t, _l, f) => { kept = f.slice(); } };
const bare: Env = { out: () => void outs++, tap: () => {} };

const frame = (dst: Uint8Array, src: Uint8Array, size: number) => {
	const f = new Uint8Array(size);
	f.set(dst, 0);
	f.set(src, 6);
	f[12] = 8;
	return f;
};
const links = { one: [] as [number, number][], two: [[0, 1]] as [number, number][], triangle: [[0, 1], [1, 2], [2, 0]] as [number, number][] };
interface Side {
	receive(sw: number, port: number, f: Uint8Array): void;
	hops(): number;
}
async function make(name: Name, t: keyof typeof links, env: Env, taps: boolean, pump: "inline" | "turns"): Promise<Side> {
	if (name === "LabSwitch+queue") {
		const f = new Fabric({ design: "B" });
		build(f, t, taps ? (s, e) => env.tap(s, e.from, e.to, e.flood ? 1 : 0, EMPTY) : undefined);
		for (const s of f.switches.keys()) f.switches[s].attach((s + 1) as never, { deliver: (x) => env.out(s, s + 1, x) });
		if (t === "one") f.switches[0].attach(2 as never, { deliver: (x) => env.out(0, 2, x) });
		return { receive: (s, p, x) => f.switches[s].receive(p as never, x), hops: () => f.stats.hops };
	}
	const core: SwitchCore = name === "Zig" ? await zigCore(env, 0, taps, 1) : new LeanCore(env, 0, taps, 1);
	const free = [7, 7, 7];
	for (const s of t === "one" ? [0] : t === "two" ? [0, 1] : [0, 1, 2]) core.host(s, s + 1, 1);
	if (t === "one") core.host(0, 2, 1);
	for (const [a, b] of links[t]) core.cable(a, free[a]--, b, free[b]--);
	const ch = new MessageChannel();
	const turn = () => {
		const t0 = performance.now();
		for (;;) {
			if (!core.drain(performance.now(), 64)) return;
			if (performance.now() - t0 > 4) break;
		}
		ch.port2.postMessage(0);
	};
	ch.port1.onmessage = turn;
	return {
		receive(s, p, x) {
			core.receive(s, p, x, performance.now());
			if (pump === "turns") turn();
			else core.drain(performance.now(), 64);
		},
		hops: () => core.hops(),
	};
}
// LabSwitch has copied the frame for its tap already.
const EMPTY = new Uint8Array(0);

async function forward(name: Name, t: "one" | "two", size: number, env: Env, taps: boolean) {
	const side = await make(name, t, env, taps, "inline");
	const [A, B] = [mac(1), mac(2)];
	const to = t === "one" ? 0 : 1;
	side.receive(to, 2, frame(A, B, size));
	const pool = Array.from({ length: 512 }, () => frame(B, A, size));
	for (let i = 0; i < 20_000; i++) side.receive(0, 1, pool[i & 511]);
	outs = 0;
	const N = 200_000;
	let worst = 0;
	const t0 = performance.now();
	let last = t0;
	for (let i = 0; i < N; i++) {
		side.receive(0, 1, pool[i & 511]);
		if (i % 1000 === 999) {
			const n = performance.now();
			worst = Math.max(worst, n - last);
			last = n;
		}
	}
	const ns = ((performance.now() - t0) * 1e6) / N;
	if (outs !== N) throw new Error(`${name} ${t} ${size}: ${outs} of ${N} arrived`);
	return { ns, worst };
}
async function storm(name: Name, size: number, taps: boolean) {
	const side = await make(name, "triangle", copying, taps, "turns");
	let gap = 0;
	let last = performance.now();
	let on = true;
	const beat = () => {
		const n = performance.now();
		gap = Math.max(gap, n - last);
		last = n;
		if (on) setTimeout(beat, 10);
	};
	setTimeout(beat, 10);
	const f = frame(new Uint8Array(6).fill(255), mac(1), size);
	side.receive(0, 1, f);
	const t0 = performance.now();
	const h0 = side.hops();
	await new Promise((r) => setTimeout(r, 2000));
	const rate = (side.hops() - h0) / ((performance.now() - t0) / 1000);
	on = false;
	return { rate, gap };
}
Object.assign(window, { bench: { forward: (n: Name, t: "one" | "two", size: number, how: string) => forward(n, t, size, how === "bare" ? bare : copying, how !== "bare"), storm }, kept: () => kept });
