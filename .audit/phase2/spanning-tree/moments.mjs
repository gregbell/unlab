// Random wirings of five bare bridges, as the property test of src/runtime/rstp.test.ts makes them, with no kernel and no fabric.
//
//   node .audit/phase2/spanning-tree/moments.mjs [wirings, 20000 by default] [seed, 1 by default] [a copy of the source, this one by default]
//
// After every turn of every bridge it looks for a loop of cables that both ends forward on. It prints how many cases had
// such a moment, how many of those had it on a cable from a bridge to itself alone, how many were left with a loop when
// the bridges had come to rest, and the first of each kind.
import { join, resolve } from "node:path";

const [casesText = "20000", seedText = "1", repo = resolve(import.meta.dirname, "../../..")] = process.argv.slice(2);
const { Bridge, FORWARD_DELAY_MS } = await import(join(repo, "src/runtime/rstp.ts"));

function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function one(random) {
	const pick = (n) => Math.floor(random() * n);
	let now = 0;
	const up = new Map();
	const waiting = [];
	const bridges = Array.from({ length: 5 }, (_, i) => new Bridge(0x0200_0000_0001 + i, {
		send(port, frame) {
			for (const [a, pa, b, pb] of up.values()) {
				if (a === i && pa === port) waiting.push({ to: b, port: pb, frame });
				if (b === i && pb === port) waiting.push({ to: a, port: pa, frame });
			}
		},
		flush() {},
	}));
	const carrying = () => [...up.values()].filter(([a, pa, b, pb]) => bridges[a].forwards(pa) && bridges[b].forwards(pb));
	/** "self" when the only loops are cables from a bridge to itself, "ring" when bridges are in one, or null. */
	const looped = () => {
		const group = bridges.map((_, i) => i);
		const find = (i) => (group[i] === i ? i : find(group[i]));
		let self = 0;
		let ring = 0;
		for (const [a, , b] of carrying()) {
			if (a === b) self++;
			else if (find(a) === find(b)) ring++;
			else group[find(a)] = find(b);
		}
		return ring > 0 ? "ring" : self > 0 ? "self" : null;
	};
	let found = null;
	let rest = false;
	const settle = () => {
		for (let turn = 0; turn < 10000; turn++) {
			const next = waiting.shift();
			if (next) bridges[next.to].receive(next.port, next.frame, now);
			const busy = bridges.filter((bridge) => bridge.pending || bridge.due <= now);
			if (!next && busy.length === 0) {
				if (looped()) rest = true;
				return;
			}
			for (const bridge of next ? [bridges[next.to]] : busy) bridge.run(now);
			const kind = looped();
			if (kind === "ring" || (kind && !found)) found = kind;
		}
		throw new Error("never at rest");
	};
	const pass = (ms) => {
		const end = now + ms;
		for (;;) {
			const due = Math.min(...bridges.map((bridge) => bridge.due));
			if (due > end) break;
			now = due;
			settle();
		}
		now = end;
		settle();
	};
	const all = [];
	const steps = [];
	const taken = (on, port) => all.some(([a, pa, b, pb]) => (a === on && pa === port) || (b === on && pb === port));
	const count = 1 + pick(40);
	for (let s = 0; s < count; s++) {
		const what = pick(3);
		if (what === 0) {
			const cable = [pick(5), 1 + pick(8), pick(5), 1 + pick(8)];
			const [a, pa, b, pb] = cable;
			if ((a === b && pa === pb) || taken(a, pa) || taken(b, pb)) continue;
			all.push(cable);
			up.set(cable.join(), cable);
			steps.push({ kind: "plug", cable });
			bridges[a].enable(pa, false);
			bridges[b].enable(pb, false);
			settle();
		} else if (what === 1) {
			const which = pick(21);
			const [gone] = all.splice(which % Math.max(1, all.length), 1);
			if (!gone) continue;
			steps.push({ kind: "cut", cable: gone });
			up.delete(gone.join());
			bridges[gone[0]].disable(gone[1]);
			bridges[gone[2]].disable(gone[3]);
			settle();
		} else {
			const ms = pick(8001);
			steps.push({ kind: "pass", ms });
			pass(ms);
		}
		if (found === "ring") break;
	}
	pass(2 * FORWARD_DELAY_MS + 1000);
	return { found, rest, steps };
}

const random = mulberry32(Number(seedText));
const cases = Number(casesText);
const counts = { self: 0, ring: 0, rest: 0 };
const first = {};
for (let i = 0; i < cases; i++) {
	const { found, rest, steps } = one(random);
	if (rest) counts.rest++;
	if (!found) continue;
	counts[found]++;
	first[found] ??= { i, steps };
}
console.log(`seed ${seedText}: ${cases} wirings: a loop carried at some moment in ${counts.self + counts.ring}, in ${counts.self} on a cable from a bridge to itself alone, and in ${counts.ring} round a ring of bridges. A loop was left when the bridges came to rest in ${counts.rest}`);
for (const kind of ["self", "ring"]) if (first[kind]) console.log(`  first ${kind}, wiring ${first[kind].i}: ${JSON.stringify(first[kind].steps)}`);
