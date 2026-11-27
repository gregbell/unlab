// A triangle of switches with spanning tree on, where the cable between the two that are not the root has a delay,
// and one broadcast goes in every 200 ms. A port proposes for 3 s before it takes its cable to end at no bridge, so a
// cable that is slower than that carries before its switches have heard each other.
//
//   node .audit/phase2/spanning-tree/slow-cable.mjs [delay in ms, 4000 by default]

import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const { Fabric } = await import(root + "/src/runtime/fabric.ts");
const { conditionsOf } = await import(root + "/src/model/index.ts");
const frames = await import(root + "/test/support/frames.ts");
let now = 0, looped = 0, first = -1, last = -1;
const fabric = new Fabric({ tap: (_s, e) => { if (e.looped) { looped++; if (first < 0) first = now; last = now; } } });
for (let i = 0; i < 3; i++) { fabric.addSwitch(); fabric.attach(i, 1, { deliver() {} }); }
const cable = (a, pa, b, pb) => fabric.cable({ slot: a, port: pa }, { slot: b, port: pb });
cable(0, 7, 1, 8); cable(1, 7, 2, 8); cable(2, 7, 0, 8);
const slow = conditionsOf({ delay: Number(process.argv[2] ?? 4000) });
fabric.setConditions(1, 7, slow); fabric.setConditions(2, 8, slow);
for (let i = 0; i < 3; i++) fabric.setTree(i, { address: 0x020000000001 + i });
const ports = () => [0, 1, 2].map((s) => "abc"[s] + ":" + (fabric.tree(s)?.ports ?? []).filter((p) => p.port !== 1).map((p) => `${p.port}${p.role[0]}${p.state[0]}`).join(",")).join(" ");
for (let ms = 0; ms <= 20000; ms++) {
	now = ms;
	if (ms % 200 === 0) fabric.receive(0, 1, frames.arpRequest(1, 99), now);
	while (fabric.drain(now, 64) > 0);
	if ([0, 2900, 3100, 4100, 8200, 20000].includes(ms)) console.log(ms, ports(), "looped", looped, "storming", [0, 1, 2].filter((s) => fabric.storm(s, now)).length);
}
console.log(looped === 0 ? "no frame looped" : `frames looped from ${first} to ${last} ms`);
