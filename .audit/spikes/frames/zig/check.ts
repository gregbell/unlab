// Throwaway. Both cores, fed the same random frames, must hand out the same frames in the same order.
import { readFileSync } from "node:fs";
import { LeanCore, type SwitchCore } from "../lean.ts";
const mod = new WebAssembly.Module(readFileSync(new URL("./core.wasm", import.meta.url)));
function zig(log: string[]): SwitchCore {
	let heap: Uint8Array;
	const i = new WebAssembly.Instance(mod, { env: { out: (s: number, p: number, a: number, n: number) => log.push(`${s}.${p} ${heap.subarray(a, a + n).join()}`), tap: (s: number, f: number, t: number, l: number, a: number, n: number) => log.push(`tap ${s} ${f} ${t} ${l} ${heap.subarray(a, a + n).join()}`) } });
	const x = i.exports as any;
	heap = new Uint8Array(x.memory.buffer);
	x.init(1000, 1, 7);
	return { ...x, receive: (s: number, p: number, f: Uint8Array, now: number) => { const slot = x.take(); heap.set(f, x.address(slot)); x.receive(s, p, slot, f.length, now); } };
}
let total = 0;
for (let run = 0; run < 200; run++) {
	const a: string[] = [], b: string[] = [];
	const env = (log: string[]) => ({ out: (s: number, p: number, f: Uint8Array) => void log.push(`${s}.${p} ${f.join()}`), tap: (s: number, f: number, t: number, l: number, x: Uint8Array) => void log.push(`tap ${s} ${f} ${t} ${l} ${x.join()}`) });
	const cores: SwitchCore[] = [zig(a), new LeanCore(env(b), 1000, true, 7)];
	for (const c of cores) {
		for (let s = 0; s < 3; s++) for (let p = 0; p < 4; p++) c.host(s, p, 1 + (p & 1));
		for (const [x, px, y, py] of [[0, 7, 1, 7], [1, 6, 2, 6], [2, 7, 0, 6]]) c.cable(x, px, y, py);
		c.conditions(run % 6, run % 3 ? 5 : 0, 0);
	}
	let now = 1;
	const rnd = (n: number) => Math.floor(Math.random() * n);
	for (let k = 0; k < 60; k++) {
		const [s, p] = [rnd(3), rnd(4)];
		const f = new Uint8Array(20);
		f[5] = rnd(14);
		if (rnd(4) === 0) f.fill(255, 0, 6);
		f[11] = 1 + s * 4 + p;
		f[19] = k;
		now += rnd(3);
		for (const c of cores) {
			c.receive(s, p, f, now);
			c.drain(now, 50);
		}
	}
	if (a.join("\n") !== b.join("\n")) { const i = a.findIndex((l, j) => l !== b[j]); throw new Error(`run ${run} differs at ${i}: ${a[i]} / ${b[i]}`); }
	if (cores[0].hops() !== cores[1].hops() || cores[0].dropped() !== cores[1].dropped()) throw new Error("counts differ");
	total += a.length;
}
console.log(`200 random runs agree, ${total} events`);
