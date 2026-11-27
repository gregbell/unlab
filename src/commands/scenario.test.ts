import { describe, expect, it } from "vitest";
import { scenarioLines, THREE_SUBNETS_WIRING, waitsForMachines, wiringOf } from "../../test/support/scenario.ts";
import { machineList } from "../model/index.ts";
import { addressStr } from "../net/index.ts";
import type { ExecPort } from "./index.ts";
import { storeLab } from "./testing/store.ts";
import type { Topology } from "./verbs/index.ts";

const LINES = scenarioLines("three-subnets");

/** The recorded lines, run one at a time from the bar, with every machine ready before a line that waits for it. */
async function built() {
	const typed: string[] = [];
	const exec: ExecPort = {
		inject: async (session, line) => {
			typed.push(`${session} ${line}`);
			return { exitCode: 0, output: "", truncated: false, lastLine: "", ms: 1 };
		},
	};
	const lab = storeLab(exec);
	const answers: string[] = [];
	for (const line of LINES) {
		if (waitsForMachines(line)) lab.ready(...machineList(lab.store.state).map(({ name }) => name));
		const result = await lab.run(line);
		expect(result.kind, line).not.toBe("failed");
		answers.push(result.kind === "visible" ? result.text : String(result.kind === "report" && result.header));
	}
	return { lab, typed, answers };
}

describe("the recorded command set of three-subnets.md", () => {
	it("runs line by line from the bar, and each line has the agent tool that an agent would call instead", async () => {
		const { lab, typed } = await built();
		expect(LINES.map((line) => lab.registry.find(line.split(" ")[0])?.tool?.name)).not.toContain(undefined);
		expect(typed).toEqual([
			"r1:console sudo sysctl -w net.ipv4.ip_forward=1",
			"r2:console sudo sysctl -w net.ipv4.ip_forward=1",
			"alice:console sudo ip route replace default via 10.1.0.1",
			"bob:console sudo ip route replace default via 10.3.0.1",
			"r1:console sudo ip route replace 10.3.0.0/24 via 10.2.0.2",
			"r2:console sudo ip route replace 10.1.0.0/24 via 10.2.0.1",
		]);
	});

	it("builds three subnets, two routers, a trunk of VLANs 10 and 20 between two switches, and one cable that loses frames", async () => {
		const { lab } = await built();
		const report = await lab.run("topology");
		if (report.kind !== "report") throw new Error("topology answers with a report");
		expect(report.header).toBe("3 switches · 8 of 24 ports taken · 1 cable with conditions");
		expect(report.rows).toEqual([
			{ term: "switch0", text: "ports 1, 2, 3, 4, 5, 6, 7 and 8 · free" },
			{
				term: "core",
				text: [
					"port 1 · r1:eth0 · up · vlan 10",
					"port 2 · r1:eth1 · up · vlan 20",
					"port 8 · edge:8 · up · trunk of 10 and 20, native 1",
					"ports 3, 4, 5, 6 and 7 · free",
				].join("\n"),
			},
			{
				term: "edge",
				text: [
					"port 1 · alice · up · vlan 10",
					"port 2 · r2:eth0 · up · vlan 20",
					"port 3 · r2:eth1 · up · vlan 30 · loss 10% · 0 delivered · 0 dropped",
					"port 4 · bob · up · vlan 30",
					"port 8 · core:8 · up · trunk of 10 and 20, native 1",
					"ports 5, 6 and 7 · free",
				].join("\n"),
			},
		]);

		// The agent's tool returns the same, as data.
		expect(wiringOf(report.data as Topology)).toEqual(THREE_SUBNETS_WIRING);

		const subnets = machineList(lab.store.state).map(({ name, spec }) => [
			name,
			spec.gateway,
			spec.nics.map(({ net, address }) => `${net} ${address && addressStr(address)}`),
		]);
		expect(subnets).toEqual([
			["alice", false, ["edge 10.1.0.10/24"]],
			["r1", false, ["core 10.1.0.1/24", "core 10.2.0.1/24"]],
			["r2", false, ["edge 10.2.0.2/24", "edge 10.3.0.1/24"]],
			["bob", false, ["edge 10.3.0.10/24"]],
		]);
	});
});
