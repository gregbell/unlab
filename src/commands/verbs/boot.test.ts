import { describe, expect, it } from "vitest";
import { storeLab } from "../testing/store.ts";

describe("boot", () => {
	it("boots a failed machine again on the lowest free port", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("spawn 1 alpine");
		lab.runtime({ type: "vm/failed", machine: "node3", attempt: 1, reason: "Kernel panic." });
		expect(lab.parsed("boot node3").preview(lab.store.state)).toMatchObject({
			will: "boot node3 again · alpine 3.24 · 256 MiB · plugged into switch0 on port 3",
		});
		expect(await lab.run("boot node3", "button")).toMatchObject({ kind: "visible", text: "booting node3" });
		expect(lab.store.state.machines.node3?.life).toMatchObject({ phase: "booting", attempt: 2 });
	});

	it("boots every machine that is off or failed, the off ones on the ports they hold", async () => {
		const lab = storeLab();
		await lab.lab(3);
		await lab.run("poweroff node2");
		lab.runtime({ type: "vm/failed", machine: "node3", attempt: 1, reason: "Kernel panic." });
		expect(lab.parsed("boot all").preview(lab.store.state)).toMatchObject({
			will: "boot node2 and node3 · alpine 3.24 · 256 MiB each · plugged into switch0 on ports 2 and 3 · skipped node1: already running",
		});
		await lab.run("boot all");
		expect(["node1", "node2", "node3"].map((name) => lab.store.state.machines[name as "node1"]?.life)).toMatchObject([
			{ phase: "ready" },
			{ phase: "booting", attempt: 2, plugs: [{ port: 2 }] },
			{ phase: "booting", attempt: 2, plugs: [{ port: 3 }] },
		]);
	});

	it("says why it has nothing to boot", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(lab.parse("boot node1")).toEqual({
			message: "boot has no machine to act on. Skipped node1: already running. Nothing was changed.",
			token: 1,
		});
	});

	it("gives an agent its answer once each machine is ready, or failed and why", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("poweroff all");
		let answer: unknown;
		const done = lab.run("boot all", "agent").then((result) => {
			answer = result;
		});
		lab.runtime({ type: "vm/ready", machine: "node1", attempt: 2, bootMs: 1 });
		await Promise.resolve();
		expect(answer).toBeUndefined();
		lab.runtime({ type: "vm/failed", machine: "node2", attempt: 2, reason: "Kernel panic." });
		await done;
		expect(answer).toEqual({
			kind: "visible",
			text: "node1 ready, node2 failed: Kernel panic.",
			data: [
				{ name: "node1", state: "ready" },
				{ name: "node2", state: "failed", reason: "Kernel panic." },
			],
		});
	});
});
