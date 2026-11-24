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
		expect(await lab.run("boot node3", "button")).toEqual({
			kind: "visible",
			text: "booting node3 again",
			data: null,
		});
		expect(lab.store.state.machines.node3?.life).toMatchObject({ phase: "booting", attempt: 2 });
		expect(lab.events).toContainEqual({ type: "cmd/boot-again", machine: "node3", ports: [3], at: 0 });
	});

	it("wants a failed machine, and has no agent tool", async () => {
		const lab = storeLab();
		await lab.lab(1);
		expect(lab.parse("boot node1")).toEqual({
			message: "boot wants a failed machine here, and node1 is already running. Nothing was changed.",
			token: 1,
		});
		expect(lab.registry.find("boot")?.tool).toBeNull();
	});
});
