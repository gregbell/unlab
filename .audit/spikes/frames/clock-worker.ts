import { type Late, probe } from "./clock-probe.ts";
let got: Late[] = [];
probe((l) => got.push(l));
self.onmessage = () => {
	self.postMessage(got);
	got = [];
};
