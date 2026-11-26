// node .audit/phase2/vlans/storm-cost.mjs <fabric.ts>
//
// What a storm costs the fabric itself: a mesh of four switches and one broadcast, for 20 s of the lab's time, with a tap
// that keeps a copy of each frame as the capture does. It prints the frames carried, how long that took, and the
// garbage collections.
import { PerformanceObserver, performance } from "node:perf_hooks";
const { Fabric } = await import(process.argv[2]);
let count = 0, total = 0, worst = 0;
new PerformanceObserver((list) => { for (const e of list.getEntries()) { count++; total += e.duration; worst = Math.max(worst, e.duration); } }).observe({ entryTypes: ["gc"] });
const ring = new Array(10000);
let taps = 0;
const fabric = new Fabric({ tap: (_s, e) => { ring[taps++ % ring.length] = { ...e }; } });
for (let s = 0; s < 4; s++) { fabric.addSwitch(); fabric.attach(s, 1, { deliver() {} }); }
let port = [2, 2, 2, 2];
for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) fabric.cable({ slot: a, port: port[a]++ }, { slot: b, port: port[b]++ });
const f = new Uint8Array(60); f.fill(255, 0, 6); f.set([0x52, 0x54, 0, 0x88, 0, 1], 6); f.set([8, 6], 12);
fabric.receive(0, 1, f, 0);
const t0 = performance.now();
for (let now = 0; now < 20000; now++) while (fabric.drain(now, 64) > 0);
const ms = performance.now() - t0;
await new Promise((r) => setTimeout(r, 50));
console.log(`${taps} frames in ${ms.toFixed(0)} ms: ${count} collections, ${total.toFixed(1)} ms in all, worst ${worst.toFixed(2)} ms`);
