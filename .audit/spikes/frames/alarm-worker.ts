// Throwaway. A page's timers, kept by a thread that is not throttled while the tab is hidden.
const armed = new Map<number, ReturnType<typeof setTimeout>>();
self.onmessage = ({ data: { id, ms } }) => {
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
