// A learning layer-2 switch. Ports are transport agnostic: a port is just
// something that can be handed an Ethernet frame, so the same switch runs
// over Web Worker messages in the browser and worker_threads in Node.

import { BROADCAST_MAC, dstMac, isGroupMac, srcMac } from "./frames.ts";

export interface PortCounters {
	rxFrames: number;
	rxBytes: number;
	txFrames: number;
	txBytes: number;
	dropped: number;
	flooded: number;
}

export interface PortOptions {
	/** Human name, e.g. the machine's hostname. */
	name: string;
	/**
	 * Hand a frame to the attached machine. The frame is shared with every
	 * other recipient of this flood, so a port must neither retain it nor
	 * detach its buffer: copy first if it transfers the bytes elsewhere.
	 */
	deliver: (frame: Uint8Array) => void;
}

interface Port extends PortOptions {
	id: string;
	up: boolean;
	counters: PortCounters;
}

/** One frame crossing the switch, for the packet inspector. */
export interface TapEvent {
	seq: number;
	/** Milliseconds since the switch was created. */
	t: number;
	fromPort: string;
	fromName: string;
	/** Ports it was delivered to. */
	toPorts: string[];
	flooded: boolean;
	frame: Uint8Array;
}

export interface SwitchOptions {
	/** Age out MAC table entries after this long. Default 5 minutes. */
	macAgeMs?: number;
	/** Monotonic clock, injectable for tests. */
	now?: () => number;
}

function zeroCounters(): PortCounters {
	return { rxFrames: 0, rxBytes: 0, txFrames: 0, txBytes: 0, dropped: 0, flooded: 0 };
}

export class LabSwitch {
	readonly #ports = new Map<string, Port>();
	/** MAC -> { port, seen }: learned from source addresses. */
	readonly #macTable = new Map<string, { port: string; seen: number }>();
	readonly #taps = new Set<(e: TapEvent) => void>();
	readonly #macAgeMs: number;
	readonly #now: () => number;
	readonly #t0: number;
	#seq = 0;

	constructor(opts: SwitchOptions = {}) {
		this.#macAgeMs = opts.macAgeMs ?? 5 * 60_000;
		this.#now = opts.now ?? (() => Date.now());
		this.#t0 = this.#now();
	}

	addPort(id: string, opts: PortOptions): void {
		if (this.#ports.has(id)) throw new Error(`port already attached: ${id}`);
		this.#ports.set(id, { ...opts, id, up: true, counters: zeroCounters() });
	}

	removePort(id: string): void {
		this.#ports.delete(id);
		for (const [mac, e] of this.#macTable) if (e.port === id) this.#macTable.delete(mac);
	}

	hasPort(id: string): boolean {
		return this.#ports.has(id);
	}

	/** Pull a cable: frames to and from a downed port are dropped. */
	setLink(id: string, up: boolean): void {
		const p = this.#ports.get(id);
		if (!p) return;
		p.up = up;
		if (!up) for (const [mac, e] of this.#macTable) if (e.port === id) this.#macTable.delete(mac);
	}

	isUp(id: string): boolean {
		return this.#ports.get(id)?.up ?? false;
	}

	onTap(fn: (e: TapEvent) => void): () => void {
		this.#taps.add(fn);
		return () => this.#taps.delete(fn);
	}

	counters(id: string): PortCounters | undefined {
		return this.#ports.get(id)?.counters;
	}

	/** MAC address table: MAC -> port id. */
	macTable(): Array<{ mac: string; port: string; name: string; ageMs: number }> {
		const now = this.#now();
		const out: Array<{ mac: string; port: string; name: string; ageMs: number }> = [];
		for (const [mac, e] of this.#macTable) {
			out.push({ mac, port: e.port, name: this.#ports.get(e.port)?.name ?? "?", ageMs: now - e.seen });
		}
		return out;
	}

	/** A machine put a frame on the wire. */
	receive(fromPort: string, frame: Uint8Array): void {
		const src = this.#ports.get(fromPort);
		if (!src) return;
		src.counters.rxFrames++;
		src.counters.rxBytes += frame.length;
		if (!src.up || frame.length < 14) {
			src.counters.dropped++;
			return;
		}

		const now = this.#now();
		// Taken before delivery: a port is free to copy or transfer the frame,
		// and the inspector must still see what was actually on the wire.
		const snapshot = this.#taps.size ? frame.slice() : frame;
		this.#learn(srcMac(frame), fromPort, now);

		const dst = dstMac(frame);
		const group = isGroupMac(frame);
		const entry = group ? undefined : this.#macTable.get(dst);
		const target = entry && entry.port !== fromPort ? this.#ports.get(entry.port) : undefined;

		const toPorts: string[] = [];
		let flooded = false;

		if (target) {
			if (this.#send(target, frame)) toPorts.push(target.id);
		} else if (group || !entry) {
			// Broadcast, multicast, or an address we have not learned yet: flood
			// to every other live port, as a real switch does.
			flooded = true;
			src.counters.flooded++;
			for (const p of this.#ports.values()) {
				if (p.id === fromPort) continue;
				if (this.#send(p, frame)) toPorts.push(p.id);
			}
		}

		if (this.#taps.size) {
			const e: TapEvent = {
				seq: ++this.#seq,
				t: now - this.#t0,
				fromPort,
				fromName: src.name,
				toPorts,
				flooded,
				frame: snapshot,
			};
			for (const tap of this.#taps) {
				try {
					tap(e);
				} catch {
					// A broken inspector must never break the wire.
				}
			}
		}
	}

	#learn(mac: string, port: string, now: number): void {
		if (mac === BROADCAST_MAC) return;
		const prev = this.#macTable.get(mac);
		if (prev && prev.port === port) {
			prev.seen = now;
			return;
		}
		this.#macTable.set(mac, { port, seen: now });
		if (this.#macAgeMs > 0 && this.#macTable.size > 1) this.#age(now);
	}

	#age(now: number): void {
		for (const [mac, e] of this.#macTable) {
			if (now - e.seen > this.#macAgeMs) this.#macTable.delete(mac);
		}
	}

	#send(p: Port, frame: Uint8Array): boolean {
		if (!p.up) {
			p.counters.dropped++;
			return false;
		}
		p.counters.txFrames++;
		p.counters.txBytes += frame.length;
		try {
			p.deliver(frame);
		} catch {
			p.counters.dropped++;
			return false;
		}
		return true;
	}
}
