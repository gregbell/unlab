// The work one broadcast causes before anything paces it, on the fabric alone.
//
//   node .audit/phase2/vlans/fanout.mjs <fabric.ts> [cases] [seed]
//
// First a full mesh of trunks, with cables that join two VLANs on one switch. Then random dense labs of 8
// switches, as the second verifier of #38 made them, seed for seed. For each it counts the frames that cross a
// cable at the instant of the broadcast, which is the work that blocks the page: `unlooped` are those that a
// switch took without a looped mark, and `turns` are all of them. After each dense lab it runs a churn of what
// the commands do, and says whether the fabric came out of it with nothing waiting and no storm.

const [fabricPath, casesText, seedText] = process.argv.slice(2);
const { Fabric, STORM_QUIET_MS } = await import(fabricPath);
const SWITCHES = 8;

function broadcast(id) {
	const f = new Uint8Array(60);
	f.fill(0xff, 0, 6);
	f.set([0x52, 0x54, 0, 0x88, 0, id & 255], 6);
	f.set([0x08, 0x06], 12);
	return f;
}

/** Carries everything that is due at `now`, and says how many frames that was and how long it took. */
function atOnce(fabric, now) {
	const t0 = performance.now();
	let turns = 0;
	for (;;) {
		const did = fabric.drain(now, 100000);
		turns += did;
		if (did < 100000 || turns > 2e7) break;
	}
	return { turns, ms: performance.now() - t0 };
}

for (const [n, joins] of [[4, 0], [4, 1], [4, 2], [6, 1], [6, 2], [6, 3], [8, 1]]) {
	let unlooped = 0;
	const fabric = new Fabric({ tap: (_s, e) => void (e.looped || unlooped++) });
	for (let s = 0; s < n; s++) fabric.addSwitch();
	const next = Array(n).fill(1);
	const trunk = { mode: "trunk", allowed: "all", native: 1 };
	for (let a = 0; a < n; a++)
		for (let b = a + 1; b < n; b++) {
			const pa = next[a]++;
			const pb = next[b]++;
			if (pa > 8 || pb > 8) continue;
			fabric.cable({ slot: a, port: pa }, { slot: b, port: pb });
			fabric.setVlan(a, pa, trunk);
			fabric.setVlan(b, pb, trunk);
		}
	// A mesh of 8 fills seven ports of each switch, so its one join takes the place of the cable from 0 to 1.
	if (n === 8) {
		fabric.detach(0, 1);
		next[1] = 9;
		fabric.cable({ slot: 1, port: 1 }, { slot: 1, port: 8 });
		fabric.setVlan(1, 1, { mode: "access", vlan: 10 });
		fabric.setVlan(1, 8, { mode: "access", vlan: 20 });
	}
	const pairs = [[10, 20], [20, 30], [30, 10]];
	for (let j = 0; j < joins && n < 8; j++) {
		const s = j + 1;
		const pa = next[s]++;
		const pb = next[s]++;
		fabric.cable({ slot: s, port: pa }, { slot: s, port: pb });
		fabric.setVlan(s, pa, { mode: "access", vlan: pairs[j][0] });
		fabric.setVlan(s, pb, { mode: "access", vlan: pairs[j][1] });
	}
	const p = n === 8 ? 1 : next[0]++;
	fabric.attach(0, p, { deliver() {} });
	fabric.setVlan(0, p, { mode: "access", vlan: 10 });
	fabric.receive(0, p, broadcast(1), 1000);
	const { turns, ms } = atOnce(fabric, 1000);
	console.log(`mesh of ${n} switches, ${joins} join(s): ${unlooped} unlooped, ${turns} turns, ${ms.toFixed(1)} ms`);
}

let seed = Number(seedText ?? 1);
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const VLANS = [1, 10, 20, 30, 40, 50, 60, 70];
const mode = (accessOnly) => {
	const r = rnd();
	if (accessOnly || r < 0.6) return { mode: "access", vlan: pick(VLANS) };
	return { mode: "trunk", allowed: "all", native: pick(VLANS) };
};

const unlooped = [];
const turns = [];
let worst = { turns: -1 };
let churnBad = 0;
let threw = 0;
const cases = Number(casesText ?? 300);
for (let i = 0; i < cases; i++) {
	const caseSeed = seed;
	const accessOnly = rnd() < 0.5;
	let plain = 0;
	let begun = 0;
	let over = 0;
	const fabric = new Fabric({
		tap: (_s, e) => void (e.looped || plain++),
		storm: (_s, _r, isOver) => (isOver ? over++ : begun++),
	});
	for (let s = 0; s < SWITCHES; s++) fabric.addSwitch();
	const free = [];
	for (let s = 0; s < SWITCHES; s++)
		for (let p = 1; p <= 8; p++) {
			fabric.setVlan(s, p, mode(accessOnly));
			free.push([s, p]);
		}
	const take = () => free.splice(int(free.length), 1)[0];
	const m = take();
	fabric.attach(m[0], m[1], { deliver() {} });
	const cables = 8 + int(24);
	for (let c = 0; c < cables && free.length >= 2; c++) {
		const [a, b] = [take(), take()];
		fabric.cable({ slot: a[0], port: a[1] }, { slot: b[0], port: b[1] });
	}
	let now = 1000;
	try {
		fabric.receive(m[0], m[1], broadcast(i), now);
		const first = atOnce(fabric, now);
		unlooped.push(plain);
		turns.push(first.turns);
		if (first.turns > worst.turns) worst = { turns: first.turns, unlooped: plain, ms: Math.round(first.ms), caseSeed, cables, accessOnly };

		for (let step = 0; step < 200; step++) {
			now += int(3);
			const r = rnd();
			const s = int(SWITCHES);
			const p = 1 + int(8);
			if (r < 0.3) fabric.setVlan(s, p, mode(false));
			else if (r < 0.45) fabric.setLink(s, p, rnd() < 0.5);
			else if (r < 0.55) fabric.detach(s, p);
			else if (r < 0.6) {
				fabric.removeSwitch(s, now);
				fabric.addSwitch();
			} else if (r < 0.75) {
				const a = [int(SWITCHES), 1 + int(8)];
				const b = [int(SWITCHES), 1 + int(8)];
				try {
					fabric.cable({ slot: a[0], port: a[1] }, { slot: b[0], port: b[1] });
				} catch {}
			} else fabric.receive(m[0], m[1], broadcast(step), now);
			fabric.drain(now, 2000);
		}
		for (let s = 0; s < SWITCHES; s++) for (let p = 1; p <= 8; p++) fabric.detach(s, p);
		for (let k = 0; k < STORM_QUIET_MS + 5; k++) {
			now++;
			fabric.drain(now, 100000);
		}
		const storming = [...Array(SWITCHES).keys()].filter((s) => fabric.storm(s, now)).length;
		if (fabric.busy || fabric.waiting !== 0 || storming || begun !== over || fabric.next() !== -1) {
			churnBad++;
			if (churnBad < 4) console.log("inconsistent", { caseSeed, busy: fabric.busy, waiting: fabric.waiting, storming, begun, over, next: fabric.next() });
		}
	} catch (e) {
		threw++;
		if (threw < 4) console.log("threw", caseSeed, String(e.stack).slice(0, 400));
	}
}
const q = (a, p) => a.toSorted((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const spread = (a) => `p50 ${q(a, 0.5)}, p90 ${q(a, 0.9)}, p99 ${q(a, 0.99)}, max ${q(a, 1)}`;
console.log(`${cases} dense labs, seed ${seedText ?? 1}: unlooped ${spread(unlooped)}; turns ${spread(turns)}`);
console.log(`worst ${JSON.stringify(worst)}; churn left ${churnBad} inconsistent; ${threw} threw`);
