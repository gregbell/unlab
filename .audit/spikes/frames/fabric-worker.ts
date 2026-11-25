// Throwaway. The lab network in a worker of its own, with a port to each machine.
import { type Core, type CoreOptions, createCore } from "./core.ts";

let core: Core;
let ports: MessagePort[] = [];
let batch: { sw: number; from: number; to: number; flood: unknown; frame: Uint8Array }[] = [];
let skipped = 0;
let armed = false;
const flush = () => {
	armed = false;
	const transfer = batch.map((e) => e.frame.buffer as ArrayBuffer);
	(self as unknown as Worker).postMessage({ type: "taps", batch, skipped }, transfer);
	batch = [];
	skipped = 0;
};
self.onmessage = async (ev) => {
	const m = ev.data;
	if (m.type === "init") {
		ports = m.ports;
		const o: CoreOptions = m.options;
		core = await createCore(
			o,
			(i, frame) => {
				const copy = frame.slice();
				ports[i].postMessage({ type: "frame", nic: 0, frame: copy }, [copy.buffer]);
			},
			(sw, e) => {
				if (batch.length >= 1000) skipped++;
				else batch.push({ sw, from: e.from, to: e.to, flood: e.flood, frame: e.frame });
				if (!armed) {
					armed = true;
					setTimeout(flush, 16);
				}
			},
		);
		ports.forEach((p, i) => {
			p.onmessage = ({ data }) => {
				if (data.type === "ack") core.ack(i, data.n);
				else core.receive(i, data.frame);
			};
		});
		return;
	}
	const result = (core as unknown as Record<string, (...a: unknown[]) => unknown>)[m.call](...m.args);
	self.postMessage({ type: "result", id: m.id, result });
};
