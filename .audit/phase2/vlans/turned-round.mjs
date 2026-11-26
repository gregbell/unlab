// node .audit/phase2/vlans/turned-round.mjs <fabric.ts>
//
// One broadcast that a far switch turns round, with no loop: the rows that the switches take, and whether a storms.
// A trunk whose ends have native VLANs 30 and 1, and on the far switch a cable from VLAN 1 to VLAN 30.
const { Fabric } = await import(process.argv[2]);
const rows = [];
const fabric = new Fabric({ tap: (slot, e) => rows.push(`${"ab"[slot]}${e.from} vlan ${e.vlan}${e.looped ? " looped" : ""}`) });
fabric.addSwitch(); fabric.addSwitch();
let got = 0;
fabric.attach(0, 1, { deliver: () => void got++ });
fabric.cable({ slot: 0, port: 8 }, { slot: 1, port: 8 });
fabric.cable({ slot: 1, port: 3 }, { slot: 1, port: 4 });
fabric.setVlan(0, 1, { mode: "access", vlan: 30 });
fabric.setVlan(0, 8, { mode: "trunk", allowed: "all", native: 30 });
fabric.setVlan(1, 8, { mode: "trunk", allowed: "all", native: 1 });
fabric.setVlan(1, 3, { mode: "access", vlan: 1 });
fabric.setVlan(1, 4, { mode: "access", vlan: 30 });
const f = new Uint8Array(60); f.fill(255, 0, 6); f.set([0x52, 0x54, 0, 0x88, 0, 1], 6); f.set([8, 6], 12);
fabric.receive(0, 1, f, 0);
let stormed = false;
for (let now = 0; now < 300; now++) { while (fabric.drain(now, 100) > 0); stormed ||= fabric.storm(0, now) !== null; }
console.log(rows.join(" | "), `| the sender got ${got} back, a stormed ${stormed}, waiting ${fabric.waiting}`);
