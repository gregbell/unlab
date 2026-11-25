// Throwaway. Two frame queues between unchanged LabSwitches.
//   A  one lab-wide FIFO with a lab-wide bound; a lab-wide heap for delayed frames
//   B  a bounded queue per cable direction, served round-robin; a heap of directions by their head's due time
// A cable's end is an ordinary SwitchPort whose deliver() queues instead of calling the other switch.
import { LabSwitch, type TapEvent } from "../../../src/runtime/switch.ts";

export interface Conditions {
	delayMs?: number;
	loss?: number;
	/** Share of frames that skip the delay, so they overtake. */
	reorder?: number;
	rate?: number;
	mtu?: number;
}

export interface FabricOptions {
	design: "naive" | "A" | "B";
	now?: () => number;
	random?: () => number;
	/** Main-thread time a drain may take before it yields. */
	budgetMs?: number;
	/** After a drain that used its whole budget, how long to rest. 0 yields one task. */
	restMs?: number;
	/** Frames waiting: in the lab for A, on one cable direction for B. */
	limit?: number;
	/** Bytes waiting for a rate. */
	rateQueueBytes?: number;
	/** Group frames a second one direction of a cable between switches carries. They wait for it, and others overtake them. 0 is no ceiling. */
	ceiling?: number;
	/** Frames a second one direction carries of those that have come back to a switch they had been to. 0 is no pace. */
	pace?: number;
	/** How many of those wait on one direction. */
	loopedLimit?: number;
	/** Who wakes the fabric when a frame is due. Absent, setTimeout here. */
	alarm?: (ms: number, fn: () => void) => () => void;
	/** Timers are armed for no longer than this, since Chromium lets a longer one be 8 ms late. 0 is no cap. */
	stepMs?: number;
}

interface Item {
	frame: Uint8Array;
	due: number;
	dir: Dir;
	gen: number;
	seq: number;
	/** The switches it has been to, as a mask, and whether it has been to one of them twice. */
	visited: number;
	looped: boolean;
}

export class Dir {
	up = true;
	gen = 0;
	cond: Conditions | null = null;
	busyUntil = 0;
	q: Item[] = [];
	head = 0;
	inReady = false;
	between = false;
	from = 0;
	to = 0;
	paced = 0;
	waitingLooped = 0;
	heapDue = Infinity;
	carried = 0;
	drop = { loss: 0, mtu: 0, rate: 0, full: 0, cut: 0, storm: 0 };
	name: string;
	out: (frame: Uint8Array) => void;
	constructor(name: string, out: (frame: Uint8Array) => void) {
		this.name = name;
		this.out = out;
	}
	get waiting(): number {
		return this.q.length - this.head;
	}
}

class Heap<T> {
	a: T[] = [];
	less: (x: T, y: T) => boolean;
	constructor(less: (x: T, y: T) => boolean) {
		this.less = less;
	}
	push(x: T): void {
		const { a, less } = this;
		let i = a.push(x) - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!less(a[i], a[p])) break;
			[a[i], a[p]] = [a[p], a[i]];
			i = p;
		}
	}
	pop(): T | undefined {
		const { a, less } = this;
		const top = a[0];
		const last = a.pop();
		if (a.length && last !== undefined) {
			a[0] = last;
			for (let i = 0; ; ) {
				let m = i;
				for (const c of [2 * i + 1, 2 * i + 2]) if (c < a.length && less(a[c], a[m])) m = c;
				if (m === i) break;
				[a[i], a[m]] = [a[m], a[i]];
				i = m;
			}
		}
		return top;
	}
}

export class Fabric {
	readonly switches: LabSwitch[] = [];
	readonly dirs: Dir[] = [];
	readonly o: Required<FabricOptions>;
	stats = { hops: 0, turns: 0, fullTurns: 0, maxWaiting: 0, maxDrainMs: 0, lastHop: 0, sumLate: 0, late: 0, maxLate: 0, looped: 0, lastLooped: 0 };
	#fifo: Item[] = [];
	#fifoHead = 0;
	#delayed = new Heap<Item>((x, y) => x.due < y.due || (x.due === y.due && x.seq < y.seq));
	#ready: Dir[] = [];
	#readyHead = 0;
	#later = new Heap<{ due: number; dir: Dir }>((x, y) => x.due < y.due);
	#seq = 0;
	#visited = 0;
	#looped = false;
	#draining = false;
	#soon = false;
	#timer: (() => void) | undefined;
	#timerAt = Infinity;
	#ch = new MessageChannel();
	#waiting = 0;

	constructor(o: FabricOptions) {
		this.o = {
			now: () => performance.now(),
			random: Math.random,
			budgetMs: 4,
			restMs: 0,
			limit: o.design === "A" ? 4096 : 256,
			rateQueueBytes: 64 * 1024,
			ceiling: 0,
			pace: 0,
			loopedLimit: 64,
			stepMs: 30,
			alarm: (ms, fn) => {
				const id = setTimeout(fn, ms);
				return () => clearTimeout(id);
			},
			...o,
		};
		this.#ch.port1.onmessage = () => {
			this.#soon = false;
			this.#drain();
		};
	}

	addSwitch(tap?: (sw: number, e: TapEvent) => void): number {
		const sw = new LabSwitch({ now: this.o.now });
		const n = this.switches.push(sw) - 1;
		if (tap) sw.onTap((e) => tap(n, e));
		return n;
	}

	dir(name: string, out: (frame: Uint8Array) => void): Dir {
		const d = new Dir(name, out);
		this.dirs.push(d);
		return d;
	}

	cable(a: number, pa: number, b: number, pb: number): readonly [Dir, Dir] {
		const A = this.switches[a];
		const B = this.switches[b];
		const ab = this.dir(`${a}:${pa}>${b}:${pb}`, (f) => B.receive(pb as never, f));
		const ba = this.dir(`${b}:${pb}>${a}:${pa}`, (f) => A.receive(pa as never, f));
		ab.between = ba.between = true;
		ab.from = ba.to = a;
		ab.to = ba.from = b;
		A.attach(pa as never, { deliver: (f) => this.send(ab, f) });
		B.attach(pb as never, { deliver: (f) => this.send(ba, f) });
		return [ab, ba];
	}

	cut(dirs: readonly Dir[], up: boolean): void {
		for (const d of dirs) {
			d.up = up;
			d.gen++;
			this.#waiting -= d.waiting;
			d.drop.cut += d.waiting;
			d.q = [];
			d.head = 0;
			d.busyUntil = 0;
			d.waitingLooped = 0;
			d.paced = 0;
		}
	}

	/** Put a frame on one direction of a cable. */
	send(d: Dir, frame: Uint8Array): void {
		const { o } = this;
		if (o.design === "naive") {
			this.stats.hops++;
			d.carried++;
			d.out(frame);
			return;
		}
		if (!d.up) {
			d.drop.cut++;
			return;
		}
		const c = d.cond;
		const now = o.now();
		const looped = d.between && this.#looped;
		// Zero conditions: due at once, whatever a drain already running took for now.
		let due = 0;
		if (c) {
			due = now;
			if (c.mtu && frame.length - 14 > c.mtu) {
				d.drop.mtu++;
				return;
			}
			if (c.loss && o.random() < c.loss) {
				d.drop.loss++;
				return;
			}
			if (c.rate) {
				const start = Math.max(now, d.busyUntil);
				if (((start - now) * c.rate) / 8000 + frame.length > o.rateQueueBytes) {
					d.drop.rate++;
					return;
				}
				d.busyUntil = start + (frame.length * 8000) / c.rate;
				due = d.busyUntil;
			}
			if (c.delayMs && !(c.reorder && o.random() < c.reorder)) due += c.delayMs;
		} else if (o.ceiling && frame[0] & 1 && d.between) {
			d.busyUntil = Math.max(now, d.busyUntil) + 1000 / o.ceiling;
			due = d.busyUntil;
		}
		if (looped && o.pace) {
			if (d.waitingLooped >= o.loopedLimit) {
				d.drop.storm++;
				return;
			}
			d.waitingLooped++;
			d.paced = Math.max(now, d.paced) + 1000 / o.pace;
			due = Math.max(due, d.paced);
		}
		const item: Item = { frame, due, dir: d, gen: d.gen, seq: this.#seq++, visited: d.between ? this.#visited | (1 << d.from) : 0, looped };
		if (o.design === "A") {
			if (this.#waiting >= o.limit) {
				d.drop.full++;
				return;
			}
			this.#waiting++;
			if (due > now) this.#delayed.push(item);
			else this.#fifo.push(item);
		} else {
			// What waits for its delay does not count against the bound of what waits to be carried.
			if (d.waiting - d.waitingLooped >= (c ? 1 << 16 : o.limit) && !(looped && o.pace)) {
				d.drop.full++;
				return;
			}
			this.#waiting++;
			const q = d.q;
			q.push(item);
			for (let i = q.length - 1; i > d.head && q[i - 1].due > due; i--) {
				q[i] = q[i - 1];
				q[i - 1] = item;
			}
			this.#arm(d, now);
		}
		if (this.#waiting > this.stats.maxWaiting) this.stats.maxWaiting = this.#waiting;
		if (!this.#draining && !this.#soon) this.#drain();
	}

	#arm(d: Dir, now: number): void {
		if (d.inReady || !d.waiting) return;
		const { due } = d.q[d.head];
		if (due <= now) {
			d.inReady = true;
			this.#ready.push(d);
		} else if (due < d.heapDue) {
			d.heapDue = due;
			this.#later.push({ due, dir: d });
		}
	}

	#carry(item: Item): void {
		const { dir } = item;
		this.#waiting--;
		if (item.gen !== dir.gen) return;
		dir.carried++;
		this.stats.hops++;
		if (item.looped && this.o.pace) dir.waitingLooped--;
		if (dir.between) {
			this.#visited = item.visited;
			this.#looped = item.looped || (item.visited & (1 << dir.to)) !== 0;
			if (this.#looped) {
				this.stats.looped++;
				this.stats.lastLooped = this.o.now();
			}
		}
		dir.out(item.frame);
		this.#visited = 0;
		this.#looped = false;
	}

	#drain(): void {
		const { o, stats } = this;
		this.#draining = true;
		stats.turns++;
		const started = o.now();
		let now = started;
		let more = false;
		for (let n = 0; ; n++) {
			if ((n & 7) === 7) {
				now = o.now();
				if (now - started > o.budgetMs) {
					more = true;
					break;
				}
			}
			if (o.design === "A") {
				while (this.#delayed.a.length && this.#delayed.a[0].due <= now) {
					const item = this.#delayed.pop() as Item;
					this.#note(now - item.due);
					this.#fifo.push(item);
				}
				if (this.#fifoHead >= this.#fifo.length) {
					this.#fifo.length = 0;
					this.#fifoHead = 0;
					break;
				}
				const item = this.#fifo[this.#fifoHead++];
				if (this.#fifoHead > 1024 && this.#fifoHead * 2 > this.#fifo.length) {
					this.#fifo.splice(0, this.#fifoHead);
					this.#fifoHead = 0;
				}
				this.#carry(item);
			} else {
				while (this.#later.a.length && this.#later.a[0].due <= now) {
					const { due, dir } = this.#later.pop() as { due: number; dir: Dir };
					if (dir.heapDue === due) {
						dir.heapDue = Infinity;
						this.#note(now - due);
					}
					this.#arm(dir, now);
				}
				if (this.#readyHead >= this.#ready.length) {
					this.#ready.length = 0;
					this.#readyHead = 0;
					break;
				}
				const d = this.#ready[this.#readyHead++];
				if (this.#readyHead > 1024 && this.#readyHead * 2 > this.#ready.length) {
					this.#ready.splice(0, this.#readyHead);
					this.#readyHead = 0;
				}
				d.inReady = false;
				if (!d.waiting) continue;
				if (d.q[d.head].due > now) {
					this.#arm(d, now);
					continue;
				}
				const item = d.q[d.head++];
				if (d.head === d.q.length) {
					d.q.length = 0;
					d.head = 0;
				} else if (d.head > 256 && d.head * 2 > d.q.length) {
					d.q.splice(0, d.head);
					d.head = 0;
				}
				this.#carry(item);
				this.#arm(d, now);
			}
		}
		this.#draining = false;
		const took = o.now() - started;
		if (took > stats.maxDrainMs) stats.maxDrainMs = took;
		stats.lastHop = o.now();
		if (more) {
			stats.fullTurns++;
			this.#soon = true;
			if (o.restMs) setTimeout(() => { this.#soon = false; this.#drain(); }, o.restMs);
			else this.#yield();
			return;
		}
		const next = o.design === "A" ? this.#delayed.a[0]?.due : this.#later.a[0]?.due;
		if (next === undefined || (next >= this.#timerAt && this.#timer)) return;
		this.#timer?.();
		this.#timerAt = next;
		// Whole milliseconds, rounded up: Chromium truncates, so a timer would wake early and re-arm until nesting clamps it to 4 ms.
		const wait = Math.max(0, Math.ceil(next - o.now()));
		this.#timer = o.alarm(o.stepMs ? Math.min(wait, o.stepMs) : wait, () => {
			this.#timer = undefined;
			this.#timerAt = Infinity;
			if (!this.#soon) this.#drain();
		});
	}

	// Node delivers a whole chain of MessagePort messages before any timer, so it needs setImmediate there.
	#yield(): void {
		const immediate = (globalThis as { setImmediate?: (fn: () => void) => void }).setImmediate;
		if (immediate)
			immediate(() => {
				this.#soon = false;
				this.#drain();
			});
		else this.#ch.port2.postMessage(0);
	}

	#note(late: number): void {
		this.stats.late++;
		this.stats.sumLate += late;
		if (late > this.stats.maxLate) this.stats.maxLate = late;
	}

	get waiting(): number {
		return this.#waiting;
	}
	dropped(): Record<string, number> {
		const sum: Record<string, number> = {};
		for (const d of this.dirs) for (const [k, v] of Object.entries(d.drop)) sum[k] = (sum[k] ?? 0) + v;
		return sum;
	}
}

export type Topology = "one" | "two" | "triangle" | "mesh" | "mesh+pair";

/** Switches and the cables between them. Machine m is on switch `home[m]`, port 1 + m. */
export function build(f: Fabric, t: Topology, tap?: (sw: number, e: TapEvent) => void): (readonly [Dir, Dir])[] {
	const links: Record<Topology, [number, number][]> = {
		one: [],
		two: [[0, 1]],
		triangle: [[0, 1], [1, 2], [2, 0]],
		mesh: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
		"mesh+pair": [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3], [4, 5]],
	};
	const count = { one: 1, two: 2, triangle: 3, mesh: 4, "mesh+pair": 6 }[t];
	for (let i = 0; i < count; i++) f.addSwitch(tap);
	const free = Array.from({ length: count }, () => 8);
	return links[t].map(([a, b]) => f.cable(a, free[a]--, b, free[b]--));
}
