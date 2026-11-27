// Random wirings of switches that all take part in the spanning tree, with cables put in, cut, reconnected and taken
// out, time that passes, and broadcasts in between, on the fabric with no kernel.
//
//   node .audit/phase2/spanning-tree/fuzz.mjs [labs, 2000 by default] [seed, 20261127 by default] [busy]
//
// After every step it checks that no frame has come back to a switch that it had left, and that no switch storms.
// When a lab has been left alone for forty seconds, one broadcast from each machine has to reach every machine that
// cables join it to once, and no other. It prints how many labs failed each, and the first that did.
//
// With busy, every machine sends a broadcast in the instant of each change to a cable, before the switches have said a
// word about it, so those frames cross the cables among the tree's own messages. A frame that comes round then fails
// no lab, though the fabric begins a storm with the first: it prints after how many of the changes one did, and how
// many frames. A lab fails when a storm is still on 150 ms later, where one is over after 100 ms with no such frame.

import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const { Fabric } = await import(join(root, "src/runtime/fabric.ts"));
const { isForBridges } = await import(join(root, "src/net/index.ts"));
const frames = await import(join(root, "test/support/frames.ts"));

const labs = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 20261127);
const busy = process.argv[4] === "busy";

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
	const count = 2 + pick(5);
	let now = 0;
	let looped = 0;
	const fabric = new Fabric({ tap: (_slot, e) => void (looped += e.looped ? 1 : 0) });
	const got = [];
	// Addresses in a random order, so that the root is any of them.
	const order = Array.from({ length: count }, (_, i) => i).sort(() => random() - 0.5);
	for (let slot = 0; slot < count; slot++) {
		fabric.addSwitch();
		got.push([]);
		fabric.attach(slot, 1, { deliver: (frame) => void (isForBridges(frame) || got[slot].push(frame)) });
		fabric.setTree(slot, { address: 0x0200_0000_0001 + order[slot] });
	}
	const cables = [];
	const taken = new Set();
	const key = (slot, port) => `${slot}:${port}`;
	const drain = () => {
		for (let turns = 0; fabric.drain(now, 64) > 0; turns++) if (turns > 100_000) throw new Error("never quiet");
	};
	const pass = (ms) => {
		const end = now + ms;
		for (;;) {
			const due = [fabric.next(), fabric.timer()].filter((at) => at >= 0);
			const at = Math.min(...due);
			if (due.length === 0 || at > end) break;
			now = Math.max(now, at);
			drain();
		}
		now = end;
		drain();
	};
	const log = [];
	const round = { frames: 0, changes: 0, sent: 0 };
	/** In the instant of a change, with busy: a broadcast from each machine. */
	const send = () => {
		if (!busy) return;
		round.sent++;
		for (let from = 0; from < count; from++) fabric.receive(from, 1, frames.arpRequest(from + 1, 97), now);
	};
	const storms = () => got.some((_, slot) => fabric.storm(slot, now) !== null);
	const check = (what) => {
		let storming = storms();
		if (busy) {
			if (storming) pass(150);
			round.frames += looped;
			round.changes += looped > 0 ? 1 : 0;
			looped = 0;
			storming = storms();
		}
		if (looped > 0 || storming) return `${what}: ${looped} looped frames${storming ? ", and a storm" : ""}`;
		return null;
	};
	drain();
	for (let step = 0; step < 60; step++) {
		const what = pick(10);
		if (what < 4) {
			const a = { slot: pick(count), port: 2 + pick(7) };
			const b = { slot: pick(count), port: 2 + pick(7) };
			if (taken.has(key(a.slot, a.port)) || taken.has(key(b.slot, b.port)) || key(a.slot, a.port) === key(b.slot, b.port)) continue;
			fabric.cable(a, b);
			taken.add(key(a.slot, a.port)).add(key(b.slot, b.port));
			send();
			cables.push({ a, b, up: true });
			log.push(`cable ${key(a.slot, a.port)}-${key(b.slot, b.port)}`);
		} else if (what < 6 && cables.length > 0) {
			const cable = cables[pick(cables.length)];
			cable.up = !cable.up;
			fabric.setLink(cable.a.slot, cable.a.port, cable.up);
			send();
			log.push(`${cable.up ? "reconnect" : "cut"} ${key(cable.a.slot, cable.a.port)}`);
		} else if (what < 7 && cables.length > 0) {
			const [cable] = cables.splice(pick(cables.length), 1);
			fabric.detach(cable.a.slot, cable.a.port);
			send();
			taken.delete(key(cable.a.slot, cable.a.port));
			taken.delete(key(cable.b.slot, cable.b.port));
			log.push(`uncable ${key(cable.a.slot, cable.a.port)}`);
		} else if (what < 9) {
			const ms = pick(4) === 0 ? pick(8000) : pick(30);
			pass(ms);
			log.push(`pass ${ms}`);
		} else {
			const from = pick(count);
			fabric.receive(from, 1, frames.arpRequest(from + 1, 99), now);
			log.push(`broadcast ${from}`);
		}
		drain();
		const failed = check(log.at(-1));
		if (failed) return { kind: "loop", failed, log };
	}
	pass(40_000);
	const failed = check("left alone");
	if (failed) return { kind: "loop", failed, log };
	// Which switches the cables that are up join.
	const group = got.map((_, i) => i);
	const find = (i) => (group[i] === i ? i : find(group[i]));
	for (const { a, b, up } of cables) if (up) group[find(a.slot)] = find(b.slot);
	for (let from = 0; from < count; from++) {
		for (const frames of got) frames.length = 0;
		fabric.receive(from, 1, frames.arpRequest(from + 1, 98), now);
		pass(50);
		for (let to = 0; to < count; to++) {
			const wanted = to !== from && find(to) === find(from) ? 1 : 0;
			if (got[to].length !== wanted) {
				return { kind: "reach", failed: `a broadcast from ${from} reached ${to} ${got[to].length} times, not ${wanted}`, log };
			}
		}
	}
	const whole = check("after the broadcasts");
	if (whole) return { kind: "loop", failed: whole, log };
	// What the lab came to, for what the run was worth: its cables that are up, and the ports that the tree keeps out of use.
	const blocked = got.reduce(
		(sum, _, slot) => sum + (fabric.tree(slot)?.ports ?? []).filter(({ state }) => state !== "forwarding").length,
		0,
	);
	return { kind: "fine", up: cables.filter(({ up }) => up).length, blocked, round };
}

const random = mulberry32(seed);
const failures = { loop: 0, reach: 0, threw: 0 };
const came = { up: 0, blocked: 0, looped: 0, frames: 0, changes: 0, sent: 0, labs: 0 };
let first = null;
const started = performance.now();
for (let lab = 0; lab < labs; lab++) {
	let result;
	try {
		result = one(random);
	} catch (error) {
		result = { kind: "threw", failed: String(error), log: [] };
	}
	if (result.kind === "fine") {
		came.up += result.up;
		came.blocked += result.blocked;
		came.looped += result.blocked > 0 ? 1 : 0;
		came.frames += result.round.frames;
		came.changes += result.round.changes;
		came.sent += result.round.sent;
		came.labs += result.round.frames > 0 ? 1 : 0;
		continue;
	}
	failures[result.kind]++;
	first ??= { lab, ...result };
}
console.log(`${labs} labs of 2 to 6 switches, 60 steps each, seed ${seed}, in ${((performance.now() - started) / 1000).toFixed(1)} s`);
console.log(`${came.looped} labs ended with a loop of cables, ${came.up} cables up in all and ${came.blocked} ports blocked`);
if (busy) console.log(`with a broadcast from each machine in the instant of each change: a frame came round after ${came.changes} of ${came.sent} changes, in ${came.labs} labs, ${came.frames} frames in all`);
console.log(`${busy ? "a storm went on" : "a frame looped or a switch stormed"} in ${failures.loop}, a broadcast missed a machine or came twice in ${failures.reach}, and ${failures.threw} threw`);
if (first) console.log(`the first, lab ${first.lab}: ${first.failed}\n  ${first.log.join("; ")}`);
process.exitCode = first ? 1 : 0;
