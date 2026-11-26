// Random wirings, one broadcast each, on the fabric alone: its looped marks against a flood that has no loop rule.
//
//   node .audit/phase2/vlans/fuzz.mjs <fabric.ts> <cases> [seed] [dense]
//
// The reference floods as the README says a switch does, with no trail, no pace and no limit of its own: a
// broadcast whose copies are still going after DEPTH hops is in a loop. Without `dense` the wirings are those of
// the second verifier of #38, seed for seed: up to 4 switches and 6 cables, and a tag only from a trunk. With it
// they have up to 8 switches and 20 cables, and a machine on any port sends one tag, two, or none.
//
// It prints one line of counts, then up to three cases of each kind that is not zero. `missed`, `grew`, `stuck`,
// `restless` and `unbounded` are faults. `falseMark` is a looped mark on a flood that ends.

const [fabricPath, casesText, seedText, shape] = process.argv.slice(2);
const { Fabric, STORM_QUIET_MS } = await import(fabricPath);
const dense = shape === "dense";

let seed = Number(seedText ?? 1);
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const VLANS = [1, 10, 20, 30];
const TAGS = [...VLANS, 0, 4095, 77];
const DEPTH = 400;
/** Bytes a switch takes, with no checksum: 1,500 of payload, and 4 more with a tag. */
const LONGEST = 1514;

function topology() {
	const switches = 1 + int(dense ? 8 : 4);
	const modes = [];
	for (let s = 0; s < switches; s++) {
		modes.push([]);
		for (let p = 1; p <= 8; p++) {
			const r = rnd();
			if (r < 0.55) modes[s][p] = { mode: "access", vlan: pick(VLANS) };
			else if (r < 0.85) modes[s][p] = { mode: "trunk", allowed: "all", native: pick(VLANS) };
			else modes[s][p] = { mode: "trunk", allowed: VLANS.filter(() => rnd() < 0.6), native: pick(VLANS) };
		}
	}
	const free = [];
	for (let s = 0; s < switches; s++) for (let p = 1; p <= 8; p++) free.push([s, p]);
	const take = () => free.splice(int(free.length), 1)[0];
	const cables = [];
	const n = int(Math.min(dense ? 21 : 7, free.length / 2 - 1));
	for (let i = 0; i < n; i++) cables.push([take(), take()]);
	const machines = [take(), take()];
	return { switches, modes, cables, machines, trunkOnly: rnd() < 0.5 };
}

function frame(id, tags) {
	const f = new Uint8Array(60 + 4 * tags.length);
	f.fill(0xff, 0, 6);
	f.set([0x52, 0x54, 0, 0x88, 0, id & 255], 6);
	let o = 12;
	for (const tag of tags) {
		f.set([0x81, 0, tag >> 8, tag & 255], o);
		o += 4;
	}
	f.set([0x08, 0x06], o);
	return f;
}

/** The tags a machine puts on its frame. */
function tagsFor(mode) {
	if (!dense) {
		// The verifier's frames: a pick of 0 is no tag.
		const tag = mode.mode === "trunk" && rnd() < 0.6 ? pick(TAGS) : 0;
		return tag ? [tag] : [];
	}
	const r = rnd();
	if (r < 0.5) return [];
	return r < 0.85 ? [pick(TAGS)] : [pick(TAGS), pick(TAGS)];
}

const allows = (m, v) => m.allowed === "all" || m.allowed.includes(v);
const carries = (m, v) => (m.mode === "trunk" ? allows(m, v) : m.vlan === v);
const tagOf = (f) => (f.length >= 18 && f[12] === 0x81 && f[13] === 0 ? ((f[14] & 15) << 8) | f[15] : null);
const untag = (f) => [...f.slice(0, 12), ...f.slice(16)];
const tagged = (f, v) => [...f.slice(0, 12), 0x81, 0, (v >> 8) & 15, v & 255, ...f.slice(12)];

/**
 * Whether the broadcast's flood is alive after DEPTH hops. A port reads a frame's tag, takes a tag of 0 or none
 * as its own VLAN, and drops a frame of a VLAN it does not carry, of VLAN 4095, or longer than a switch takes.
 */
function eternal(t, at, bytes) {
	const far = new Map();
	for (const [a, b] of t.cables) {
		far.set(`${a}`, b);
		far.set(`${b}`, a);
	}
	let level = new Map([[`${at}|${bytes}`, { s: at[0], p: at[1], f: [...bytes] }]]);
	for (let d = 0; d < DEPTH && level.size > 0; d++) {
		const next = new Map();
		for (const { s, p, f } of level.values()) {
			const m = t.modes[s][p];
			const tag = tagOf(f);
			const vlan = tag === null || tag === 0 ? (m.mode === "trunk" ? m.native : m.vlan) : tag;
			if (vlan === 4095 || !carries(m, vlan)) continue;
			if (f.length > LONGEST + (tag === null ? 0 : 4)) continue;
			const plain = tag === null ? f : untag(f);
			for (let q = 1; q <= 8; q++) {
				if (q === p) continue;
				const to = far.get(`${[s, q]}`);
				if (!to) continue;
				const e = t.modes[s][q];
				if (!carries(e, vlan)) continue;
				const wire = e.mode !== "trunk" || e.native === vlan ? plain : tagged(plain, vlan);
				next.set(`${to}|${wire}`, { s: to[0], p: to[1], f: wire });
			}
		}
		level = next;
	}
	return level.size > 0;
}

function run(t, id) {
	let now = 1000;
	const seen = { looped: 0, plain: 0, longest: 0, firstLooped: null };
	const fabric = new Fabric({
		tap(slot, e) {
			if (e.looped) {
				seen.looped++;
				seen.firstLooped ??= { slot, vlan: e.vlan, from: e.from };
			} else seen.plain++;
			seen.longest = Math.max(seen.longest, e.frame.length);
		},
	});
	for (let s = 0; s < t.switches; s++) fabric.addSwitch();
	for (let s = 0; s < t.switches; s++) for (let p = 1; p <= 8; p++) fabric.setVlan(s, p, t.modes[s][p]);
	for (const [a, b] of t.cables) fabric.cable({ slot: a[0], port: a[1] }, { slot: b[0], port: b[1] });
	for (const [s, p] of t.machines) fabric.attach(s, p, { deliver() {} });
	const [s, p] = t.machines[0];
	const bytes = frame(id, tagsFor(t.modes[s][p]));
	fabric.receive(s, p, bytes, now);
	// What is due at once is the work that nothing paces.
	let unpaced = 0;
	for (;;) {
		const did = fabric.drain(now, 100000);
		unpaced += did;
		if (did < 100000) break;
		if (unpaced > 5e6) return { bytes, seen, unbounded: true };
	}
	const atOnce = seen.plain;
	for (let i = 0; i < 300; i++) {
		now += 1;
		fabric.drain(now, 100000);
	}
	const slots = [...Array(t.switches).keys()];
	const stormy = t.cables.length > 0 && slots.some((slot) => fabric.storm(slot, now));
	const waiting = fabric.waiting;
	// One cut of everything ends it.
	for (const [a] of t.cables) fabric.setLink(a[0], a[1], false);
	for (let i = 0; i < STORM_QUIET_MS + 5; i++) {
		now += 1;
		fabric.drain(now, 100000);
	}
	const stuck = fabric.busy || fabric.waiting !== 0 || slots.some((slot) => fabric.storm(slot, now));
	return { bytes, seen, unpaced, later: seen.plain - atOnce, stormy, waiting, stuck };
}

const tally = { cases: 0, loops: 0, marked: 0, missed: 0, falseMark: 0, stormDiffers: 0, grew: 0, restless: 0, stuck: 0, unbounded: 0, later: 0 };
const work = [];
const examples = {};
const keep = (k, v) => {
	examples[k] ??= [];
	if (examples[k].length < 3) examples[k].push(v);
};
for (let i = 0; i < Number(casesText); i++) {
	const caseSeed = seed;
	const t = topology();
	const r = run(t, i);
	const alive = eternal(t, t.machines[0], r.bytes);
	const note = (k, more = {}) => {
		tally[k]++;
		keep(k, { caseSeed, ...more });
	};
	tally.cases++;
	if (r.unbounded) {
		note("unbounded");
		continue;
	}
	work.push(r.unpaced);
	if (alive) tally.loops++;
	if (r.seen.looped > 0) tally.marked++;
	if (r.later > 0) tally.later++;
	if (r.seen.longest > r.bytes.length) note("grew", { longest: r.seen.longest });
	if (r.stuck) note("stuck");
	if (!alive && r.waiting > 0) note("restless", { waiting: r.waiting });
	if (alive && r.seen.looped === 0) note("missed", { t: JSON.stringify(t), seen: r.seen });
	if (!alive && r.seen.looped > 0) note("falseMark", { t: JSON.stringify(t), seen: r.seen, bytes: [...r.bytes.slice(12, 20)] });
	if (alive !== r.stormy) note("stormDiffers", { alive, stormy: r.stormy, looped: r.seen.looped });
}
work.sort((a, b) => a - b);
const at = (p) => work[Math.min(work.length - 1, Math.floor(work.length * p))] ?? 0;
console.log(JSON.stringify({ ...tally, unpaced: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1) } }));
for (const [k, v] of Object.entries(examples)) console.log(k, JSON.stringify(v).slice(0, 3000));
