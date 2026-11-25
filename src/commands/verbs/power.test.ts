import { describe, expect, it } from "vitest";
import { storeLab } from "../testing/store.ts";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reboot and poweroff", () => {
	it("say what they will do, with the shells it closes and the machines it leaves out", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("sh node1");
		await lab.run("spawn 1 alpine");
		const will = (line: string) => lab.parsed(line).preview(lab.store.state);
		expect(will("reboot node1")).toMatchObject({ will: "reboot node1 · closes 1 shell", tone: "plain" });
		expect(will("poweroff all")).toMatchObject({
			will: "power off node1 and node2 · closes 1 shell · skipped node3: still booting",
		});
	});

	it("leave a machine off with its name, ports and sessions, and refuse one that is off already", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await lab.run("poweroff node2");
		expect(lab.store.state.machines.node2?.life).toMatchObject({ phase: "off", plugs: [{ port: 2 }] });
		for (const line of ["poweroff node2", "reboot node2", "exec node2 -- ls"]) {
			expect(lab.parse(line)).toMatchObject({ message: expect.stringContaining("Skipped node2: off.") });
		}
		expect(lab.parse("sh node2")).toMatchObject({
			message: "sh wants a ready machine here, and node2 is off. Nothing was changed.",
		});
		const listed = await lab.run("ls");
		expect(listed).toMatchObject({
			header: "2 machines · 1 ready, 1 off",
			data: [{ state: "ready" }, { state: "off", nics: [{ port: 2, link: "off" }] }],
		});
		expect(listed).toMatchObject({ blocks: [{}, { lastLine: expect.stringContaining("plugged into port 2") }] });
	});

	it("are done for a person when they start, and for an agent when the machine is where it was going", async () => {
		const lab = storeLab();
		await lab.lab(2);
		expect(await lab.run("reboot node1")).toMatchObject({ kind: "visible", text: "rebooting node1" });
		lab.runtime({ type: "vm/ready", machine: "node1", attempt: 2, bootMs: 1 });

		let answer: unknown;
		void lab.run("reboot node1", "agent").then((result) => {
			answer = result;
		});
		await turn();
		expect(lab.store.state.machines.node1?.life).toMatchObject({ phase: "booting", attempt: 3 });
		expect(answer).toBeUndefined();
		lab.runtime({ type: "vm/ready", machine: "node1", attempt: 3, bootMs: 1 });
		await turn();
		expect(answer).toEqual({ kind: "visible", text: "node1 ready", data: [{ name: "node1", state: "ready" }] });
	});

	it("stop waiting when the agent does, and answer for a machine that someone removes meanwhile", async () => {
		const lab = storeLab();
		await lab.lab(2);
		const controller = new AbortController();
		const line = lab.parsed("reboot node1");
		if (line.danger) throw new Error("reboot is safe");
		const given = line.run({ source: "agent", signal: controller.signal });
		controller.abort(new Error("gave up"));
		await expect(given).rejects.toThrow("gave up");

		const waiting = lab.run("reboot node2", "agent");
		await turn();
		lab.store.dispatchCommand({ type: "cmd/remove", machines: ["node2"], cause: "bar" });
		expect(await waiting).toMatchObject({ data: [{ name: "node2", state: "removed" }] });
	});
});
