import type { CopyJob, CopyReport, FromVm } from "./protocol.ts";
import { copyFailure } from "./shortage.ts";
import type { VmDeps } from "./vm.ts";

// The new URL(...) must sit inside the new Worker(...) call: that literal form
// is what the bundler recognises, and anything else ships the worker as an
// unprocessed source file.

/** One module worker per boot attempt, running vm-worker.ts. */
export const spawnVmWorker: VmDeps["createWorker"] = (name, on) => {
	const worker = new Worker(new URL("./vm-worker.ts", import.meta.url), { type: "module", name: `unlab:${name}` });
	// The worker is this repo's vm-worker.ts, built against the same protocol.ts, so what it posts is a FromVm.
	worker.addEventListener("message", (event: MessageEvent<FromVm>) => on.message(event.data));
	worker.addEventListener("error", (event) => on.error(event.message || "The machine's worker failed."));
	return worker;
};

/** One module worker per copy, running disk-worker.ts. Returns what drops it. */
export function startCopy(job: CopyJob, on: (report: CopyReport) => void): () => void {
	const name = `unlab-disks:${job.copy.machine}`;
	const worker = new Worker(new URL("./disk-worker.ts", import.meta.url), { type: "module", name });
	const said = (report: CopyReport) => {
		if (report.kind !== "progress") worker.terminate();
		on(report);
	};
	// As above, with disk-worker.ts and CopyReport.
	worker.addEventListener("message", (event: MessageEvent<CopyReport>) => said(event.data));
	worker.addEventListener("error", ({ message }) =>
		said({ kind: "failed", reason: copyFailure(job.copy, job.why, message || "Its worker failed.") }),
	);
	worker.postMessage(job);
	return () => worker.terminate();
}
