// Throwaway. zig/core.wasm behind lean.ts's interface. The boundary is frame copies in, one call each way, and copies out.
import type { Env, SwitchCore } from "./lean.ts";
import wasmUrl from "./zig/core.wasm?url";

let module: Promise<WebAssembly.Module> | undefined;
export async function zigCore(env: Env, pace: number, taps: boolean, seed: number): Promise<SwitchCore> {
	module ??= fetch(wasmUrl).then(async (r) => WebAssembly.compile(await r.arrayBuffer()));
	let heap: Uint8Array;
	const instance = await WebAssembly.instantiate(await module, {
		env: {
			// A view of wasm memory: what keeps it copies it, as today's deliver and tap do.
			out: (sw: number, port: number, ptr: number, len: number) => env.out(sw, port, heap.subarray(ptr, ptr + len)),
			tap: (sw: number, from: number, to: number, flood: number, ptr: number, len: number) => env.tap(sw, from, to, flood, heap.subarray(ptr, ptr + len)),
		},
	});
	const x = instance.exports as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
	heap = new Uint8Array(x.memory.buffer);
	x.init(pace, taps ? 1 : 0, seed);
	return {
		host: (sw, port, vlan) => void x.host(sw, port, vlan),
		cable: (a, pa, b, pb) => x.cable(a, pa, b, pb),
		conditions: (dir, delay, loss) => void x.conditions(dir, delay, loss),
		receive(sw, port, frame, now) {
			if (frame.length > 2048) return;
			const slot = x.take();
			if (slot === 0xffff) return;
			heap.set(frame, x.address(slot));
			x.receive(sw, port, slot, frame.length, now);
		},
		drain: (now, most) => x.drain(now, most),
		next: () => x.next(),
		hops: () => x.hops(),
		dropped: () => x.dropped(),
	};
}
