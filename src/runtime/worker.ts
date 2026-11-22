import type { FromVm } from "./protocol.ts";
import type { VmDeps } from "./vm.ts";

/** One module worker per boot attempt, running vm-worker.ts. */
export const spawnVmWorker: VmDeps["createWorker"] = (name, on) => {
	// The new URL(...) must sit inside the new Worker(...) call: that literal
	// form is what the bundler recognises, and anything else ships the
	// worker as an unprocessed source file.
	const worker = new Worker(new URL("./vm-worker.ts", import.meta.url), { type: "module", name: `unlab:${name}` });
	// The worker is this repo's vm-worker.ts, built against the same protocol.ts, so what it posts is a FromVm.
	worker.addEventListener("message", (event: MessageEvent<FromVm>) => on.message(event.data));
	worker.addEventListener("error", (event) => on.error(event.message || "The machine's worker failed."));
	return worker;
};
