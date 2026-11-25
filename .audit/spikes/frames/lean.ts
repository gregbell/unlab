// Throwaway. zig/core.zig's behaviour in TypeScript, tuned the same way: no strings, no closures per frame.
export interface Env {
	out(sw: number, port: number, frame: Uint8Array): void;
	tap(sw: number, from: number, to: number, flood: number, frame: Uint8Array): void;
}
export interface SwitchCore {
	host(sw: number, port: number, vlan: number): void;
	cable(a: number, pa: number, b: number, pb: number): number;
	conditions(dir: number, delay: number, loss: number): void;
	receive(sw: number, port: number, frame: Uint8Array, now: number): void;
	drain(now: number, most: number): number;
	next(): number;
	hops(): number;
	dropped(): number;
}

const PORTS = 8;
const LIMIT = 256;
const LOOPED_LIMIT = 64;
interface Port {
	kind: "host" | "cable";
	up: boolean;
	vlan: number;
	dir: number;
}
interface Entry {
	port: number;
	seen: number;
}
interface Item {
	due: number;
	frame: Uint8Array;
	vlan: number;
	visited: number;
	looped: boolean;
}
class Dir {
	q: Item[] = [];
	head = 0;
	up = true;
	ready = false;
	waitingLooped = 0;
	paced = 0;
	delay = 0;
	loss = 0;
	full = 0;
	lost = 0;
	storm = 0;
	carried = 0;
	from: number;
	to: number;
	toPort: number;
	constructor(from: number, to: number, toPort: number) {
		this.from = from;
		this.to = to;
		this.toPort = toPort;
	}
}
const mac = (f: Uint8Array, at: number) => ((f[at] << 8) | f[at + 1]) * 4294967296 + (((f[at + 2] << 24) | (f[at + 3] << 16) | (f[at + 4] << 8) | f[at + 5]) >>> 0);

export class LeanCore implements SwitchCore {
	#env: Env;
	#paceMs: number;
	#taps: boolean;
	#seed: number;
	#ports: (Port | undefined)[][] = Array.from({ length: 8 }, () => new Array<Port | undefined>(PORTS).fill(undefined));
	/** By VLAN, then by address: the two do not fit one double together. */
	#tables: Map<number, Map<number, Entry>>[] = Array.from({ length: 8 }, () => new Map());
	#dirs: Dir[] = [];
	#ready: number[] = [];
	#readyHead = 0;
	#hops = 0;
	constructor(env: Env, pace: number, taps: boolean, seed: number) {
		this.#env = env;
		this.#paceMs = pace > 0 ? 1000 / pace : 0;
		this.#taps = taps;
		this.#seed = seed;
	}
	host(sw: number, port: number, vlan: number): void {
		this.#ports[sw][port] = { kind: "host", up: true, vlan, dir: 0 };
	}
	cable(a: number, pa: number, b: number, pb: number): number {
		const i = this.#dirs.length;
		this.#dirs.push(new Dir(a, b, pb), new Dir(b, a, pa));
		this.#ports[a][pa] = { kind: "cable", up: true, vlan: 1, dir: i };
		this.#ports[b][pb] = { kind: "cable", up: true, vlan: 1, dir: i + 1 };
		return i;
	}
	conditions(dir: number, delay: number, loss: number): void {
		this.#dirs[dir].delay = delay;
		this.#dirs[dir].loss = loss;
	}
	receive(sw: number, port: number, frame: Uint8Array, now: number): void {
		const p = this.#ports[sw][port];
		if (p) this.#forward(sw, port, p.vlan, frame, now, 0, false);
	}
	#forward(sw: number, inPort: number, vlan: number, frame: Uint8Array, now: number, visited: number, looped: boolean): void {
		const ports = this.#ports[sw];
		if (!ports[inPort]?.up || frame.length < 14) return;
		let table = this.#tables[sw].get(vlan);
		if (!table) this.#tables[sw].set(vlan, (table = new Map()));
		const src = mac(frame, 6);
		const known = table.get(src);
		if (known) {
			known.port = inPort;
			known.seen = now;
		} else table.set(src, { port: inPort, seen: now });

		let to = 0;
		let flood = 0;
		if (frame[0] & 1) flood = 1;
		else {
			const d = table.get(mac(frame, 0));
			if (!d || !ports[d.port]?.up || now - d.seen > 300_000) flood = 2;
			else if (d.port !== inPort && this.#send(sw, d.port, ports[d.port] as Port, vlan, frame, now, visited, looped)) to = 1 << d.port;
		}
		if (flood)
			for (let p = 0; p < PORTS; p++) {
				const port = ports[p];
				if (p === inPort || !port || !port.up || (port.kind === "host" && port.vlan !== vlan)) continue;
				if (this.#send(sw, p, port, vlan, frame, now, visited, looped)) to |= 1 << p;
			}
		if (this.#taps) this.#env.tap(sw, inPort, to, flood, frame);
	}
	#send(sw: number, p: number, port: Port, vlan: number, frame: Uint8Array, now: number, visited: number, looped: boolean): boolean {
		if (port.kind === "host") {
			this.#env.out(sw, p, frame);
			return true;
		}
		const d = this.#dirs[port.dir];
		if (!d.up) return false;
		if (d.loss && this.#random() < d.loss) {
			d.lost++;
			return true;
		}
		let due = d.delay ? now + d.delay : 0;
		const waiting = d.q.length - d.head;
		if (looped && this.#paceMs) {
			if (d.waitingLooped >= LOOPED_LIMIT) {
				d.storm++;
				return true;
			}
			d.waitingLooped++;
			d.paced = Math.max(now, d.paced) + this.#paceMs;
			due = Math.max(due, d.paced);
		} else if (waiting >= (d.delay ? 1024 : LIMIT)) {
			d.full++;
			return true;
		}
		const item: Item = { due, frame, vlan, visited: visited | (1 << sw), looped };
		const { q } = d;
		q.push(item);
		for (let i = q.length - 1; i > d.head && q[i - 1].due > due; i--) {
			q[i] = q[i - 1];
			q[i - 1] = item;
		}
		this.#arm(port.dir, now);
		return true;
	}
	#arm(i: number, now: number): void {
		const d = this.#dirs[i];
		if (d.ready || d.head === d.q.length || d.q[d.head].due > now) return;
		d.ready = true;
		this.#ready.push(i);
	}
	#random(): number {
		let s = this.#seed;
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		this.#seed = s;
		return (s >>> 0) / 4294967296;
	}
	drain(now: number, most: number): number {
		for (let i = 0; i < this.#dirs.length; i++) this.#arm(i, now);
		let n = 0;
		for (; n < most && this.#readyHead < this.#ready.length; n++) {
			const i = this.#ready[this.#readyHead++];
			if (this.#readyHead === this.#ready.length) {
				this.#ready.length = 0;
				this.#readyHead = 0;
			} else if (this.#readyHead > 1024) {
				this.#ready.splice(0, this.#readyHead);
				this.#readyHead = 0;
			}
			const d = this.#dirs[i];
			d.ready = false;
			if (d.head === d.q.length) continue;
			const item = d.q[d.head];
			if (item.due > now) continue;
			d.head++;
			if (d.head === d.q.length) {
				d.q.length = 0;
				d.head = 0;
			} else if (d.head > 256) {
				d.q.splice(0, d.head);
				d.head = 0;
			}
			this.#arm(i, now);
			if (item.looped && this.#paceMs) d.waitingLooped--;
			d.carried++;
			this.#hops++;
			this.#forward(d.to, d.toPort, item.vlan, item.frame, now, item.visited, item.looped || (item.visited & (1 << d.to)) !== 0);
		}
		return n;
	}
	next(): number {
		if (this.#readyHead < this.#ready.length) return 0;
		let at = -1;
		for (const d of this.#dirs) if (d.head < d.q.length && (at < 0 || d.q[d.head].due < at)) at = d.q[d.head].due;
		return at;
	}
	hops(): number {
		return this.#hops;
	}
	dropped(): number {
		return this.#dirs.reduce((n, d) => n + d.full + d.storm + d.lost, 0);
	}
}
