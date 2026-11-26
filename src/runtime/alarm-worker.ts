// The page's timers, kept on a thread that a hidden tab does not slow down.
// It is told `{ id, ms }` and answers `id` when the time has passed. A
// negative `ms` takes the timer back.

const armed = new Map<number, ReturnType<typeof setTimeout>>();

self.onmessage = ({ data: { id, ms } }: MessageEvent<{ id: number; ms: number }>) => {
	if (ms < 0) {
		clearTimeout(armed.get(id));
		armed.delete(id);
		return;
	}
	armed.set(
		id,
		setTimeout(() => {
			armed.delete(id);
			self.postMessage(id);
		}, ms),
	);
};
