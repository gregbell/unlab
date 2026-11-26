// node probe.mjs <fabric.ts>: what a lab with no loop pays for the rule. A cable joins VLAN 10 and 20 on switch a,
// and a second cable goes on from a to b in VLAN 20: machine 1 is at a1 in VLAN 10, machine 2 at b2 in VLAN 20.
const { Fabric } = await import(process.argv[2]);
const access = (vlan) => ({ mode: "access", vlan });
const mac = (n) => [0x52, 0x54, 0, 0x88, 0, 10 + n];
const frame = (dst, src, seq = 0) => { const f = new Uint8Array(60); f.set(dst, 0); f.set(src, 6); f.set([8, 0, seq >> 8, seq & 255], 12); return f; };
const ALL = [255, 255, 255, 255, 255, 255];
function lab() {
	let got = 0, looped = 0, taps = 0;
	const fabric = new Fabric({ tap: (_s, e) => { taps++; if (e.looped) looped++; } });
	fabric.addSwitch(); fabric.addSwitch();
	fabric.attach(0, 1, { deliver() {} });
	fabric.attach(1, 2, { deliver: () => void got++ });
	fabric.cable({ slot: 0, port: 7 }, { slot: 0, port: 8 });
	fabric.cable({ slot: 0, port: 6 }, { slot: 1, port: 6 });
	fabric.setVlan(0, 1, access(10)); fabric.setVlan(0, 7, access(10));
	fabric.setVlan(0, 8, access(20)); fabric.setVlan(0, 6, access(20));
	fabric.setVlan(1, 6, access(20)); fabric.setVlan(1, 2, access(20));
	return { fabric, got: () => got, looped: () => looped, taps: () => taps };
}
const all = (fabric, now) => { while (fabric.drain(now, 100000) > 0); };
{
	const t = lab();
	t.fabric.receive(0, 1, frame(ALL, mac(1)), 1000);
	let at = -1;
	for (let now = 1000; now < 1100 && at < 0; now++) { all(t.fabric, now); if (t.got() > 0) at = now - 1000; }
	const storm = t.fabric.storm(0, 1100) || t.fabric.storm(1, 1100);
	console.log(`one broadcast: machine 2 has it after ${at} ms, ${t.looped()} looped rows, storm ${storm ? "yes" : "no"}`);
}
for (const [what, dst] of [["unicast frames by the table", mac(2)], ["broadcasts", ALL]]) {
	const t = lab();
	t.fabric.receive(0, 1, frame(ALL, mac(1)), 0);
	for (let now = 0; now < 50; now++) all(t.fabric, now);
	t.fabric.receive(1, 2, frame(mac(1), mac(2)), 50);
	for (let now = 50; now < 100; now++) all(t.fabric, now);
	const before = t.got();
	// A cable takes 256 that have not looped, so they are sent as a guest sends them: a few, and then the pump's turn.
	let atOnce = 0;
	for (let i = 0; i < 1000; i++) {
		t.fabric.receive(0, 1, frame(dst, mac(1), i), 1000);
		all(t.fabric, 1000);
	}
	atOnce = t.got() - before;
	for (let now = 1001; now < 1100; now++) all(t.fabric, now);
	const late = t.got() - before - atOnce;
	const dropped = t.fabric.totals(0).dropped + t.fabric.totals(1).dropped;
	console.log(`1,000 ${what} in one instant: ${atOnce} at once, ${late} more within 100 ms, ${dropped} dropped at a cable, ${t.looped()} looped rows`);
}
