// Saves a machine's disks, or makes a set of them from a checkpoint, while no guest has them open.

import { copyDisks } from "./disk-copy.ts";
import type { CopyJob, CopyReport } from "./protocol.ts";
import { copyFailure } from "./shortage.ts";

const report = (said: CopyReport) => self.postMessage(said);

self.addEventListener("message", ({ data: { copy, why } }: MessageEvent<CopyJob>) => {
	copyDisks(why, copy, (percent) => report({ kind: "progress", percent })).then(
		(bytes) => report({ kind: "done", bytes }),
		(error: unknown) => report({ kind: "failed", reason: copyFailure(copy, why, error) }),
	);
});
