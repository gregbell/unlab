// Throwaway. How late timers fire, in whichever thread this runs.
export interface Late {
	kind: "timeout" | "interval" | "chained";
	d: number;
	at: number;
	late: number;
}
export function probe(report: (l: Late) => void): void {
	const abs = () => performance.timeOrigin + performance.now();
	for (const d of [5, 20, 30, 40, 100, 1000]) {
		// Armed from a message, as a frame's arrival would arm it.
		const ch = new MessageChannel();
		ch.port1.onmessage = () => {
			const due = abs() + d;
			setTimeout(() => {
				report({ kind: "timeout", d, at: abs(), late: abs() - due });
				ch.port2.postMessage(0);
			}, d);
		};
		ch.port2.postMessage(0);
		let due = abs() + d;
		const chain = () => {
			report({ kind: "chained", d, at: abs(), late: abs() - due });
			due = abs() + d;
			setTimeout(chain, d);
		};
		setTimeout(chain, d);
		let k = 1;
		const t0 = abs();
		setInterval(() => report({ kind: "interval", d, at: abs(), late: abs() - (t0 + k++ * d) }), d);
	}
}
