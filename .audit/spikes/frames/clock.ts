// Throwaway. Posts a summary of how late timers were, and what document.visibilityState was, every phase the server asks for.
import { type Late, probe } from "./clock-probe.ts";
const worker = new Worker(new URL("./clock-worker.ts", import.meta.url), { type: "module" });
let main: Late[] = [];
probe((l) => main.push(l));
const states: [number, string][] = [[Date.now(), document.visibilityState]];
document.addEventListener("visibilitychange", () => states.push([Date.now(), document.visibilityState]));
let pings = 0;
let worstPing = 0;
const summary = (all: Late[]) => {
	const by: Record<string, number[]> = {};
	for (const l of all) (by[`${l.kind} ${l.d}`] ??= []).push(l.late);
	return Object.fromEntries(
		Object.entries(by).map(([k, a]) => {
			a.sort((x, y) => x - y);
			const q = (p: number) => +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
			return [k, { n: a.length, p5: q(0.05), p50: q(0.5), p95: q(0.95), max: +a[a.length - 1].toFixed(2) }];
		}),
	);
};
// Two threads' tasks, not timers: what a frame's postMessage round trip sees, with a 10 ms pause in the worker.
const loop = new Worker(URL.createObjectURL(new Blob(["onmessage=e=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);postMessage(e.data)}"])));
let sentAt = performance.now();
loop.onmessage = () => {
	worstPing = Math.max(worstPing, performance.now() - sentAt);
	pings++;
	sentAt = performance.now();
	loop.postMessage(0);
};
loop.postMessage(0);
// The server answers when a phase is over: a hanging fetch, so no timer of the page's is involved.
for (;;) {
	const { phase } = await (await fetch("/phase")).json();
	const collected = new Promise<Late[]>((r) => (worker.onmessage = (e) => r(e.data)));
	worker.postMessage(0);
	const inWorker = await collected;
	await fetch("/report", {
		method: "POST",
		body: JSON.stringify({ phase, now: Date.now(), visibility: document.visibilityState, hasFocus: document.hasFocus(), states, main: summary(main), worker: summary(inWorker), pings, worstPing }),
	});
	main = [];
	pings = 0;
	worstPing = 0;
}
