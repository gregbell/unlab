// A learning layer-2 switch with eight numbered ports, the faceplate's
// numbers. Ports are transport agnostic: a port is just something that can be
// handed an Ethernet frame, so the same switch runs over Web Worker messages
// in the browser and worker_threads in Node.

import type { PortNo } from "../model/index.ts";
import { BROADCAST_MAC, dstMac, type Flood, isGroupMac, srcMac } from "../net/index.ts";

export interface PortCounters {
	rxFrames: number;
	rxBytes: number;
	txFrames: number;
	txBytes: number;
	dropped: number;
	flooded: number;
}

export interface SwitchPort {
	/**
	 * Hand a frame to the attached machine. The frame is shared with every
	 * other recipient of this flood, so a port must neither retain it nor
	 * detach its buffer: copy first if it transfers the bytes elsewhere.
	 */
	deliver(frame: Uint8Array): void;
}

/** One frame the switch accepted, for capture. */
export interface TapEvent {
	readonly from: PortNo;
	/** The ports it was delivered to, as a mask: bit p-1 for port p. */
	readonly to: number;
	/** Why it went to every other port, or null when it was forwarded (or filtered) by the table. */
	readonly flood: Flood | null;
	/** Taken before delivery, so a port that transfers its copy cannot change what capture sees. */
	readonly frame: Uint8Array;
}

export interface MacEntry {
	readonly mac: string;
	readonly port: PortNo;
	/** When the address was last seen, on the switch's clock. */
	readonly seen: number;
	/** Learned on a port whose link went down. Kept for the table, never used for forwarding. */
	readonly flushed: boolean;
}

export interface SwitchOptions {
	/** Age out MAC table entries after this long. Default 5 minutes. Flushed entries never age. */
	macAgeMs?: number;
	/** Monotonic clock, injectable for tests. */
	now?: () => number;
}

interface Port {
	readonly no: PortNo;
	readonly sink: SwitchPort;
	up: boolean;
	readonly counters: PortCounters;
}

interface Learned {
	port: PortNo;
	seen: number;
	flushed: boolean;
}

export class LabSwitch {
	readonly #ports = new Map<PortNo, Port>();
	readonly #macTable = new Map<string, Learned>();
	readonly #taps = new Set<(e: TapEvent) => void>();
	readonly #macAgeMs: number;
	readonly #now: () => number;

	constructor(opts: SwitchOptions = {}) {
		this.#macAgeMs = opts.macAgeMs ?? 5 * 60_000;
		this.#now = opts.now ?? (() => Date.now());
	}

	/** Plug a machine into a port, link up. */
	attach(port: PortNo, sink: SwitchPort): void {
		if (this.#ports.has(port)) throw new Error(`port ${port} is already attached`);
		this.#ports.set(port, {
			no: port,
			sink,
			up: true,
			counters: { rxFrames: 0, rxBytes: 0, txFrames: 0, txBytes: 0, dropped: 0, flooded: 0 },
		});
	}

	/** Unplug the port and forget every address learned on it. */
	detach(port: PortNo): void {
		this.#ports.delete(port);
		for (const [mac, e] of this.#macTable) if (e.port === port) this.#macTable.delete(mac);
	}

	/** Cut or reconnect the cable. A cut flushes the port's addresses; relearning waits for the machine's next frame. */
	setLink(port: PortNo, up: boolean): void {
		const p = this.#ports.get(port);
		if (!p) return;
		p.up = up;
		if (!up) for (const e of this.#macTable.values()) if (e.port === port) e.flushed = true;
	}

	isUp(port: PortNo): boolean {
		return this.#ports.get(port)?.up ?? false;
	}

	onTap(fn: (e: TapEvent) => void): () => void {
		this.#taps.add(fn);
		return () => this.#taps.delete(fn);
	}

	counters(port: PortNo): PortCounters | undefined {
		return this.#ports.get(port)?.counters;
	}

	macTable(): readonly MacEntry[] {
		return Array.from(this.#macTable, ([mac, e]) => ({ mac, port: e.port, seen: e.seen, flushed: e.flushed }));
	}

	/** A machine put a frame on the wire. */
	receive(from: PortNo, frame: Uint8Array): void {
		const src = this.#ports.get(from);
		if (!src) return;
		src.counters.rxFrames++;
		src.counters.rxBytes += frame.length;
		if (!src.up || frame.length < 14) {
			src.counters.dropped++;
			return;
		}

		const snapshot = this.#taps.size ? frame.slice() : frame;
		this.#learn(srcMac(frame), from, this.#now());

		const entry = isGroupMac(frame) ? undefined : this.#macTable.get(dstMac(frame));
		const flood: Flood | null = isGroupMac(frame) ? "group" : !entry || entry.flushed ? "unknown" : null;

		let to = 0;
		if (flood) {
			src.counters.flooded++;
			for (const p of this.#ports.values()) if (p.no !== from && this.#send(p, frame)) to |= 1 << (p.no - 1);
		} else if (entry && entry.port !== from) {
			const target = this.#ports.get(entry.port);
			if (target && this.#send(target, frame)) to = 1 << (target.no - 1);
		}

		if (!this.#taps.size) return;
		const e: TapEvent = { from, to, flood, frame: snapshot };
		for (const tap of this.#taps) {
			try {
				tap(e);
			} catch {
				// A broken inspector must never break the wire.
			}
		}
	}

	#learn(mac: string, port: PortNo, now: number): void {
		if (mac === BROADCAST_MAC) return;
		const prev = this.#macTable.get(mac);
		if (prev) {
			const moved = prev.port !== port;
			prev.port = port;
			prev.seen = now;
			prev.flushed = false;
			if (!moved) return;
		} else {
			this.#macTable.set(mac, { port, seen: now, flushed: false });
		}
		if (this.#macAgeMs > 0 && this.#macTable.size > 1) this.#age(now);
	}

	#age(now: number): void {
		for (const [mac, e] of this.#macTable) {
			if (!e.flushed && now - e.seen > this.#macAgeMs) this.#macTable.delete(mac);
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
			p.sink.deliver(frame);
		} catch {
			p.counters.dropped++;
			return false;
		}
		return true;
	}
}
