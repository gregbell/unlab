// A root that is cut off from a ring of three switches: how long word of it goes on round the ring, and what the
// ring's ports do meanwhile. One broadcast goes into the ring every 100 ms.
//
//   node .audit/phase2/spanning-tree/root-cut.mjs [checkout, this one by default]
//
// Run it on a copy with TX_HOLD in src/runtime/rstp.ts set to the standard's 6 to see what that limit costs.

import { resolve } from "node:path";

const here = resolve(import.meta.dirname, "../../..");
const root = resolve(process.argv[2] ?? here);
const { Fabric } = await import(root + "/src/runtime/fabric.ts");
const { decodeBpdu, isForBridges } = await import(root + "/src/net/index.ts");
const frames = await import(here + "/test/support/frames.ts");
const settle = Number(process.argv[3] ?? 10000);
let now = 0;
let looped = 0;
let firstLoop = -1, lastLoop = -1;
const said = [];
const fabric = new Fabric({ tap: (slot, e) => { if (e.looped) { looped++; if (firstLoop < 0) firstLoop = now; lastLoop = now; } const b = decodeBpdu(e.frame); if (b && now >= cutAt && cutAt >= 0) said.push(`${now - cutAt} ${"abcd"[slot]}${e.from} root=${b.root.slice(-2)} cost=${b.cost} age=${b.age}`); } });
let cutAt = -1;
for (let i = 0; i < 4; i++) { fabric.addSwitch(); fabric.attach(i, 1, { deliver() {} }); fabric.setTree(i, { address: 0x020000000001 + i }); }
const cable = (a, pa, b, pb) => fabric.cable({ slot: a, port: pa }, { slot: b, port: pb });
cable(0, 2, 1, 2); cable(1, 7, 2, 8); cable(2, 7, 3, 8); cable(3, 7, 1, 8);
const drain = () => { while (fabric.drain(now, 64) > 0); };
const pass = (ms) => { for (const end = now + ms; now < end; now++) drain(); drain(); };
drain(); pass(settle);
const ports = () => [0, 1, 2, 3].map((s) => "abcd"[s] + ":" + (fabric.tree(s)?.ports ?? []).filter((p) => p.port !== 1).map((p) => `${p.port}${p.role[0]}${p.state[0]}`).join(",")).join(" ");
console.log("before", ports());
cutAt = now;
fabric.setLink(0, 2, false);
drain();
console.log("at the cut", ports());
let stormMs = 0;
for (let ms = 0; ms < 30000; ms++) {
	if (ms % 100 === 0) fabric.receive(2, 1, frames.arpRequest(3, 99), now);
	now++; drain();
	if ([1, 2, 3].some((s) => fabric.storm(s, now))) stormMs++;
	if (ms === 100 || ms === 1000 || ms === 3000 || ms === 6000 || ms === 12000 || ms === 29999) console.log(`${ms} ms after`, ports(), "looped", looped);
}
console.log(looped === 0 ? "no frame looped, and no switch stormed" : `looped frames ${looped}, first ${firstLoop - cutAt} ms after the cut, last ${lastLoop - cutAt} ms after, stormed for ${stormMs} ms`);
console.log(`messages after the cut: ${said.length}, ages up to ${Math.max(...said.map((s) => Number(s.split("age=")[1])))}`);
console.log(said.slice(0, 14).join("\n"));
