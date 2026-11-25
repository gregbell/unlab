import { describe, expect, it } from "vitest";
import type { ParsedLine } from "../index.ts";
import { storeLab } from "../testing/store.ts";
import { yesTo } from "../testing/verbs.ts";

function danger(line: ParsedLine) {
	if (!line.danger) throw new Error(`${line.line} should be dangerous`);
	return line;
}

describe("rm", () => {
	it("asks a question naming the machine, what is lost and who else is affected", async () => {
		const lab = storeLab();
		await lab.lab(3);
		expect(danger(lab.parsed("rm node3")).confirm(lab.store.state)).toEqual({
			question: "Remove node3?",
			detail:
				"Its console closes and everything on its 4 GiB disk is gone. There is no undo. " +
				"Port 3 on switch0 frees up. node1 and node2 will stop getting answers from 10.88.0.13.",
			actionLabel: "Remove node3",
			machines: [{ n: 3, name: "node3" }],
		});
	});

	it("counts shells, plural machines and leaves out peers that hear nothing from it", async () => {
		const lab = storeLab();
		await lab.lab(3);
		await lab.run("sh node3");
		await lab.run("link down node2");
		expect(danger(lab.parsed("rm node2,node3")).confirm(lab.store.state)).toEqual({
			question: "Remove node2 and node3?",
			detail:
				"Their consoles and 1 shell close and everything on their disks is gone: node2's 4 GiB; node3's 4 GiB. There is no undo. " +
				"Ports 2 and 3 on switch0 free up. node1 will stop getting answers from 10.88.0.13.",
			actionLabel: "Remove node2 and node3",
			machines: [
				{ n: 2, name: "node2" },
				{ n: 3, name: "node3" },
			],
		});
		expect(danger(lab.parsed("rm node2")).confirm(lab.store.state)).toMatchObject({
			detail:
				"Its console closes and everything on its 4 GiB disk is gone. There is no undo. Port 2 on switch0 frees up.",
		});
	});

	it("lists every disk that goes, in one question", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --extra-disk 1,16");
		await lab.run("spawn 1 alpine --disk 8");
		const asks = (line: string) => danger(lab.parsed(line)).confirm(lab.store.state);
		expect(asks("rm node1")).toMatchObject({
			detail: expect.stringContaining(
				"everything on its 3 disks is gone: /dev/wdb 4 GiB, /dev/wdc 1 GiB, /dev/wdd 16 GiB. There is no undo.",
			),
		});
		expect(asks("rm all")).toMatchObject({
			detail: expect.stringContaining(
				"everything on their disks is gone: node1's /dev/wdb 4 GiB, /dev/wdc 1 GiB, /dev/wdd 16 GiB; node2's 8 GiB. There",
			),
		});
		expect(lab.parsed("rm node1").preview(lab.store.state)).toMatchObject({
			will: "remove node1 with its 3 disks · frees port 1",
		});
	});

	it("names every address that stops answering, and no one who has none", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --nics 2 --addr 10.1.0.1/24,10.2.0.1/24");
		await lab.run("spawn 1 alpine --addr 10.1.0.2/24");
		await lab.run("spawn 1 alpine --addr none");
		for (const name of ["node1", "node2", "node3"] as const) lab.ready(name);
		const detail = (line: string) => danger(lab.parsed(line)).confirm(lab.store.state);
		expect(detail("rm node1")).toMatchObject({
			detail: expect.stringContaining("node2 will stop getting answers from 10.1.0.1 and 10.2.0.1."),
		});
		expect(detail("rm node3")).toMatchObject({ detail: expect.stringMatching(/Port 4 on switch0 frees up\.$/) });
	});

	it("previews in the warn tone, naming the port it frees", async () => {
		const lab = storeLab();
		await lab.lab(3);
		expect(lab.parsed("rm node3").preview(lab.store.state)).toEqual({
			will: "remove node3 with its disk · frees port 3",
			assumed: null,
			tone: "warn",
		});
	});

	it("takes booting and failed machines, which hold no port once failed", async () => {
		const lab = storeLab();
		await lab.lab(1);
		await lab.run("spawn 2 alpine");
		lab.runtime({ type: "vm/failed", machine: "node3", attempt: 1, reason: "Kernel panic." });
		expect(lab.parsed("rm node2,node3").preview(lab.store.state)).toMatchObject({
			will: "remove node2 and node3 with their disks · frees port 2",
		});
	});

	it("says which machines there are when it names one that is not", async () => {
		const lab = storeLab();
		await lab.lab(3);
		expect(lab.parse("rm node7")).toEqual({
			message: "No machine is called node7, so use node1, node2 or node3. Nothing was changed.",
			token: 1,
		});
		expect(lab.parse("rm")).toEqual({ message: "rm needs machines such as node1,node3 or all. Nothing was changed." });
	});

	it("runs only with a yes for this exact line", async () => {
		const lab = storeLab();
		await lab.lab(3);
		const line = danger(lab.parsed("rm node3"));
		const { approval } = yesTo(lab.parsed("rm node2"), lab.store.state);
		const refused = await line.run({ source: "bar", signal: lab.signal, approval });
		expect(refused).toEqual({
			kind: "failed",
			error: { message: "That approval was for rm node2, not rm node3. Nothing was changed." },
		});
		expect(lab.store.state.rail).toEqual(["node1", "node2", "node3"]);
	});

	it("does not remove a machine that took the name of the one it was asked about", async () => {
		const lab = storeLab();
		await lab.run("spawn 1 alpine --name web");
		const [web] = lab.store.state.rail;
		lab.ready(web);
		const asked = yesTo(lab.parsed("rm web"), lab.store.state);
		const first = yesTo(lab.parsed("rm web"), lab.store.state);
		await first.line.run({ source: "bar", signal: lab.signal, approval: first.approval });
		await lab.run("spawn 1 alpine --name web");
		expect(await asked.line.run({ source: "agent", signal: lab.signal, approval: asked.approval })).toEqual({
			kind: "failed",
			error: { message: "What this does to web has changed since it was asked, so ask again. Nothing was changed." },
		});
		expect(lab.store.state.machines[web]).toMatchObject({ n: 2, life: { phase: "booting" } });
	});

	it("drops the link first, then closes the bar once teardown ends and the record is gone", async () => {
		const lab = storeLab();
		await lab.lab(3);
		const line = danger(lab.parsed("rm node3"));
		const { approval } = yesTo(line, lab.store.state);
		const result = await line.run({ source: "agent", signal: lab.signal, approval });
		expect(result).toEqual({ kind: "visible", text: "removed node3", data: { removed: ["node3"] } });
		expect(lab.store.state.rail).toEqual(["node1", "node2"]);
		expect(lab.events).toEqual([
			{ type: "cmd/remove", machines: ["node3"], cause: "agent" },
			{ type: "cmd/logged", line: "rm node3", source: "agent", at: 0, outcome: "ok" },
		]);
		expect(lab.effects.map((e) => e.type).slice(0, 2)).toEqual(["link/set", "vm/stop"]);
	});

	it("is the machines_remove tool, asked first and marked consequential", () => {
		const { tool } = storeLab().registry.find("rm") ?? {};
		expect(tool).toMatchObject({ name: "machines_remove", policy: "ask", annotations: { consequentialHint: true } });
		expect(tool?.toLine({ names: "node3" })).toBe("rm node3");
	});
});
