// Throwaway. The product's vm-worker, with its frames on a port, acknowledged, and its receive backlog readable.
import "../../../src/runtime/vm-worker.ts";
import type { Kernel } from "unkernel";
import { LabNic } from "../../../src/runtime/nic.ts";

const post = self.postMessage.bind(self) as (m: unknown, t?: Transferable[]) => void;
let kernel: Kernel | undefined;
let rxLimit = 0;
let acks = false;
let port: MessagePort | undefined;
let got = 0;
let owed = 0;
let rxDropped = 0;
let maxRx = 0;
const { attach, deliver } = LabNic.prototype;
LabNic.prototype.attach = function (k) {
	kernel = k;
	attach.call(this, k);
};
LabNic.prototype.deliver = function (frame) {
	const rx = kernel?.netRx.length ?? 0;
	if (rx > maxRx) maxRx = rx;
	if (rxLimit && rx >= rxLimit) rxDropped++;
	else deliver.call(this, frame);
};
self.postMessage = ((m: { type: string }, t?: Transferable[]) => {
	if (port && m.type === "frame") port.postMessage(m, t ?? []);
	else post(m, t);
}) as never;
const took = () => {
	got++;
	if (acks && ++owed >= 32) {
		(port ?? { postMessage: post }).postMessage({ type: "ack", n: owed });
		owed = 0;
	}
};
self.addEventListener("message", (ev: MessageEvent) => {
	const m = ev.data;
	if (m.type === "frame") took();
	else if (m.type === "spike") {
		rxLimit = m.rxLimit;
		acks = m.acks;
		port = m.port;
		if (port)
			port.onmessage = (e) => {
				self.dispatchEvent(new MessageEvent("message", { data: e.data }));
			};
	} else if (m.type === "probe") post({ type: "probe", id: m.id, got, rx: kernel?.netRx.length ?? 0, maxRx, rxDropped });
});
