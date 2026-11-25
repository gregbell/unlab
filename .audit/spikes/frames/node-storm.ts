// Throwaway. The storm, with no guests: what recursion does, and what each queue carries.
//   node --expose-gc node-storm.ts
import { arpRequest, ping } from "../../../test/support/frames.ts";
import { build, Fabric, type FabricOptions, type Topology } from "./fabric.ts";

const median = (a: number[]) => a.toSorted((x, y) => x - y)[a.length >> 1];
const range = (a: number[]) => `${median(a).toFixed(0)} [${Math.min(...a).toFixed(0)}-${Math.max(...a).toFixed(0)}]`;
const mem = () => {
	(globalThis as { gc?: () => void }).gc?.();
	const m = process.memoryUsage();
	return (m.heapUsed + m.arrayBuffers) / 1e6;
};

async function storm(o: FabricOptions, t: Topology, ms: number, tapped: boolean) {
	const f = new Fabric(o);
	let taps = 0;
	const cables = build(f, t, tapped ? () => void taps++ : undefined);
	let delivered = 0;
	for (let m = 0; m < 2; m++) f.switches[m].attach((m + 1) as never, { deliver: () => void delivered++ });
	const before = mem();
	let maxGap = 0;
	let last = performance.now();
	const beat = setInterval(() => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
	}, 10);
	f.switches[0].receive(1 as never, arpRequest(1, 2));
	const t0 = performance.now();
	await new Promise((r) => setTimeout(r, ms));
	const hops = f.stats.hops;
	const rate = hops / ((performance.now() - t0) / 1000);
	const during = mem();
	const pop = f.waiting;
	const cutAt = performance.now();
	for (const c of t === "triangle" ? cables.slice(0, 1) : cables) f.cut(c, false);
	await new Promise((r) => setTimeout(r, 300));
	clearInterval(beat);
	return { rate, maxGap, grew: during - before, pop, dropped: f.dropped(), endMs: Math.max(0, f.stats.lastHop - cutAt), maxDrain: f.stats.maxDrainMs, waiting: f.waiting, delivered };
}

console.log("naive: triangle, one broadcast");
{
	const f = new Fabric({ design: "naive" });
	build(f, "triangle");
	f.switches[0].attach(1 as never, { deliver() {} });
	try {
		f.switches[0].receive(1 as never, arpRequest(1, 2));
		console.log("  returned, hops", f.stats.hops, "drops counted on cable ports", f.switches.map((s) => [7, 8].map((p) => s.counters(p as never)?.dropped).join("/")).join(" "));
	} catch (e) {
		console.log("  threw", String(e), "after hops", f.stats.hops);
	}
}

for (const t of ["triangle", "mesh"] as const)
	for (const tapped of [true]) {
		const got: Record<string, Awaited<ReturnType<typeof storm>>[]> = { A: [], B: [] };
		for (let i = 0; i < 5; i++) for (const design of ["A", "B"] as const) got[design].push(await storm({ design }, t, 2000, tapped));
		for (const design of ["A", "B"]) {
			const g = got[design];
			console.log(`${t} ${design}: hops/s ${range(g.map((x) => x.rate))}  max task gap ms ${range(g.map((x) => x.maxGap))}  grew MB ${range(g.map((x) => x.grew))}  waiting ${range(g.map((x) => x.pop))}  ended ms after cut ${range(g.map((x) => x.endMs))}  longest drain ms ${range(g.map((x) => x.maxDrain))}  dropped/run ${JSON.stringify(g[0].dropped)} left ${g[0].waiting}`);
		}
	}

console.log("forwarding cost with no loop, ns per frame at the first switch");
for (const t of ["one", "two"] as const) {
	const got: Record<string, number[]> = { naive: [], A: [], B: [] };
	for (let i = 0; i < 5; i++)
		for (const design of ["naive", "A", "B"] as const) {
			const f = new Fabric({ design });
			build(f, t, () => {});
			let n = 0;
			f.switches[0].attach(1 as never, { deliver: () => void n++ });
			f.switches[t === "one" ? 0 : 1].attach(2 as never, { deliver: () => void n++ });
			const frame = ping(1, 2);
			f.switches[t === "one" ? 0 : 1].receive(2 as never, ping(2, 1));
			const N = 300_000;
			const t0 = performance.now();
			for (let k = 0; k < N; k++) f.switches[0].receive(1 as never, frame);
			got[design].push(((performance.now() - t0) * 1e6) / N);
			if (n < N) throw new Error(`${design} ${t} delivered ${n}`);
		}
	for (const d of Object.keys(got)) console.log(`  ${t} ${d}: ${range(got[d])}`);
}
process.exit(0);
