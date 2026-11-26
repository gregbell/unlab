// What keeps time for the lab's network. A page's own timers are held to one a
// second while its tab is hidden, and then to one a minute, so the page's
// timers are kept by a worker that does nothing else.

/** Time, and what runs later. Delays and spanning tree's timers are to use it too. */
export interface Clock {
	/** ms since the lab started. */
	now(): number;
	/** Calls fn once, about ms from now, however hidden the page is. Returns what cancels it. */
	after(ms: number, fn: () => void): () => void;
	/** Calls fn in a task of its own, after those that already wait. */
	soon(fn: () => void): void;
	/** Lets go of what it holds. */
	stop(): void;
}

/** The page's clock. Its worker starts with the first timer, so a lab that needs none has none. */
export function browserClock(now: () => number): Clock {
	let worker: Worker | null = null;
	let ids = 0;
	const due = new Map<number, () => void>();
	const alarms = (): Worker => {
		if (worker) return worker;
		worker = new Worker(new URL("./alarm-worker.ts", import.meta.url), { type: "module", name: "unlab-alarm" });
		worker.onmessage = ({ data }: MessageEvent<number>) => {
			const fn = due.get(data);
			due.delete(data);
			fn?.();
		};
		return worker;
	};
	const channel = new MessageChannel();
	const tasks: (() => void)[] = [];
	channel.port1.onmessage = () => tasks.shift()?.();
	return {
		now,
		after(ms, fn) {
			const id = ++ids;
			due.set(id, fn);
			alarms().postMessage({ id, ms });
			return () => {
				if (due.delete(id)) worker?.postMessage({ id, ms: -1 });
			};
		},
		soon(fn) {
			tasks.push(fn);
			channel.port2.postMessage(null);
		},
		stop() {
			worker?.terminate();
			worker = null;
			due.clear();
			tasks.length = 0;
			channel.port1.close();
		},
	};
}

/**
 * Node's clock, for the lab on real kernels in tests. A chain of MessagePort
 * messages there runs ahead of every timer, so a task of its own is an immediate.
 */
export function nodeClock(now: () => number = () => performance.now()): Clock {
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let stopped = false;
	return {
		now,
		after(ms, fn) {
			const id = setTimeout(() => {
				timers.delete(id);
				fn();
			}, ms);
			timers.add(id);
			return () => {
				clearTimeout(id);
				timers.delete(id);
			};
		},
		soon(fn) {
			setImmediate(() => {
				if (!stopped) fn();
			});
		},
		stop() {
			stopped = true;
			for (const id of timers) clearTimeout(id);
			timers.clear();
		},
	};
}
