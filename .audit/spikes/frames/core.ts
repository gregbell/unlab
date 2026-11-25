// Throwaway. One lab network, the same on the page and in a worker.
import { LabSwitch, type TapEvent } from "../../../src/runtime/switch.ts";
import { type Env, LeanCore, type SwitchCore } from "./lean.ts";
import { zigCore } from "./zig-core.ts";
import { build, type Conditions, type Dir, Fabric, type FabricOptions, type Topology } from "./fabric.ts";

export interface CoreOptions extends Omit<FabricOptions, "design"> {
	design: "today" | "A" | "B" | "lean" | "zig";
	topology: Topology;
	machines: number;
	/** Unacknowledged frames a NIC's worker may be given. 0 is no bound, as today. */
	window: number;
	/** Taps copy every frame, as today. */
	capture: boolean;
	/** Once a cut has ended a storm, switches forget their tables. */
	flush?: boolean;
}

export const HOMES: Record<Topology, readonly number[]> = {
	one: [0, 0, 0, 0],
	two: [0, 1, 0, 1],
	triangle: [0, 1, 2, 0],
	mesh: [0, 1, 2, 3],
	"mesh+pair": [4, 5, 0, 1],
};

/** The lean TypeScript core or the Zig one, pumped as Fabric pumps itself. */
async function managed(o: CoreOptions, env: Env) {
	const core: SwitchCore = o.design === "zig" ? await zigCore(env, o.pace ?? 0, o.capture, 1) : new LeanCore(env, o.pace ?? 0, o.capture, 1);
	const ch = new MessageChannel();
	let soon = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pump = () => {
		const t0 = performance.now();
		while (core.drain(performance.now(), 64) > 0) {
			if (performance.now() - t0 < 4) continue;
			soon = true;
			ch.port2.postMessage(0);
			return;
		}
		const at = core.next();
		clearTimeout(timer);
		if (at >= 0) timer = setTimeout(pump, Math.min(30, Math.max(0, Math.ceil(at - performance.now()))));
	};
	ch.port1.onmessage = () => {
		soon = false;
		pump();
	};
	return {
		core,
		receive(sw: number, port: number, frame: Uint8Array) {
			core.receive(sw, port, frame, performance.now());
			if (!soon) pump();
		},
	};
}

export async function createCore(o: CoreOptions, deliver: (m: number, frame: Uint8Array) => void, tap: (sw: number, e: TapEvent) => void) {
	const inflight = new Array<number>(o.machines).fill(0);
	const nicDropped = new Array<number>(o.machines).fill(0);
	const bytes = new Array<number>(o.machines).fill(0);
	const frames = new Array<number>(o.machines).fill(0);
	const first = new Array<number>(o.machines).fill(0);
	const last = new Array<number>(o.machines).fill(0);
	const sizes = new Map<number, number>();
	const give = (m: number, frame: Uint8Array) => {
		if (o.window && inflight[m] >= o.window) {
			nicDropped[m]++;
			return;
		}
		inflight[m]++;
		const t = performance.now();
		if (frame.length > 200 && !first[m]) first[m] = t;
		if (frame.length > 200) last[m] = t;
		bytes[m] += frame.length;
		frames[m]++;
		sizes.set(frame.length, (sizes.get(frame.length) ?? 0) + 1);
		deliver(m, frame);
	};
	let cutAt = 0;
	let wasLooped = -1;
	const forget = () => {
		if (f.stats.looped !== wasLooped) {
			wasLooped = f.stats.looped;
			setTimeout(forget, 100);
			return;
		}
		for (const sw of f.switches)
			for (let p = 1; p <= 8; p++)
				if (sw.isUp(p as never)) {
					sw.setLink(p as never, false);
					sw.setLink(p as never, true);
				}
	};
	const homes = HOMES[o.topology];
	const lean = o.design === "lean" || o.design === "zig" ? await managed(o, { out: (_, port, frame) => give(port, frame), tap: (sw, from, to, flood, frame) => tap(sw, { from: (from + 1) as never, to, flood: flood === 1 ? "group" : flood === 2 ? "unknown" : null, frame: frame.slice() }) }) : undefined;
	if (lean) {
		for (let m = 0; m < o.machines; m++) lean.core.host(homes[m], m, 1);
		if (o.topology === "two") lean.core.cable(0, 7, 1, 7);
		else if (o.topology !== "one") throw new Error("not built");
	}
	const f = new Fabric({ ...o, design: lean || o.design === "today" ? "naive" : (o.design as "A" | "B") });
	const cables = lean ? [] : build(f, o.topology, o.capture ? tap : undefined);

	const up: (Dir | null)[] = [];
	const down: (Dir | null)[] = [];
	for (let m = 0; m < o.machines && !lean; m++) {
		const sw: LabSwitch = f.switches[homes[m]];
		const port = (m + 1) as never;
		if (o.design === "today") {
			up.push(null);
			down.push(null);
			sw.attach(port, { deliver: (frame) => give(m, frame) });
			continue;
		}
		const u = f.dir(`m${m}>sw`, (frame) => sw.receive(port, frame));
		const d = f.dir(`sw>m${m}`, (frame) => give(m, frame));
		up.push(u);
		down.push(d);
		sw.attach(port, { deliver: (frame) => (d.cond || d.waiting ? f.send(d, frame) : d.out(frame)) });
	}
	return {
		receive(m: number, frame: Uint8Array) {
			const u = up[m];
			if (lean) lean.receive(homes[m], m, frame);
			else if (!u) f.switches[homes[m]].receive((m + 1) as never, frame);
			else if (u.cond || u.waiting) f.send(u, frame);
			else u.out(frame);
		},
		ack(m: number, n: number) {
			inflight[m] -= n;
		},
		cut(i: number, isUp: boolean) {
			cutAt = performance.now();
			f.cut(cables[i], isUp);
			// The addresses learned over it go too.
			const name = cables[i][0].name;
			const [x, y] = name.split(">").map((s) => s.split(":").map(Number));
			f.switches[x[0]].setLink(x[1] as never, isUp);
			f.switches[y[0]].setLink(y[1] as never, isUp);
			if (!isUp && o.flush) forget();
		},
		conditions(m: number, c: Conditions | null) {
			for (const d of [up[m], down[m]]) if (d) d.cond = c;
		},
		inject(sw: number, port: number, frame: Uint8Array) {
			if (port) {
				if (!f.switches[sw].isUp(port as never)) f.switches[sw].attach(port as never, { deliver() {} });
				f.switches[sw].receive(port as never, frame);
			}
		},
		stats() {
			return { ...f.stats, stormOverMs: Math.max(0, f.stats.lastLooped - cutAt), waiting: f.waiting, dropped: f.dropped(), nicDropped: [...nicDropped], inflight: [...inflight], bytes: [...bytes], frames: [...frames], first: [...first], last: [...last], sizes: [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 8), maxSize: Math.max(0, ...sizes.keys()), cableDrop: f.dirs.map((d) => [d.name, d.carried, d.drop] as const).filter(([, c]) => c > 0) };
		},
		macs() {
			return f.switches.map((sw) => sw.macTable().map((e) => `${e.mac.slice(-2)}@${e.port}${e.flushed ? "x" : ""}`).join(" "));
		},
		reset() {
			bytes.fill(0);
			frames.fill(0);
			first.fill(0);
			last.fill(0);
			sizes.clear();
			Object.assign(f.stats, { hops: 0, turns: 0, fullTurns: 0, maxWaiting: 0, maxDrainMs: 0, sumLate: 0, late: 0, maxLate: 0, looped: 0 });
		},
	};
}
export type Core = Awaited<ReturnType<typeof createCore>>;
