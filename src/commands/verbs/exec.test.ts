import { describe, expect, it } from "vitest";
import { completeLine, type Result } from "../index.ts";
import { manualExec, storeLab } from "../testing/store.ts";

const PING = "ping -c 1 -W 1 10.88.0.13";
const LOSS = "1 packets transmitted, 0 packets received, 100% packet loss";
const OK = "1 packets transmitted, 1 packets received, 0% packet loss";

function report(result: Result) {
	if (result.kind !== "report") throw new Error(`expected a report, got ${result.kind}`);
	return result;
}

async function threeReady() {
	const exec = manualExec();
	const lab = storeLab(exec.port);
	await lab.lab(3);
	return { lab, calls: exec.calls };
}

describe("exec", () => {
	it("types into every console at once and sums up exit codes, last lines and time", async () => {
		const { lab, calls } = await threeReady();
		await lab.run("spawn 1 alpine");
		const pending = lab.run(`exec all -- ${PING}`);
		expect(calls.map((c) => [c.session, c.line, c.source])).toEqual([
			["node1:console", PING, "bar"],
			["node2:console", PING, "bar"],
			["node3:console", PING, "bar"],
		]);
		lab.advance(1000);
		calls[2].resolve({ exitCode: 0, output: `PING\n${OK}`, truncated: false, lastLine: OK, ms: 40 });
		calls[0].resolve({ exitCode: 1, output: LOSS, truncated: false, lastLine: LOSS, ms: 1000 });
		calls[1].resolve({ exitCode: 1, output: LOSS, truncated: false, lastLine: LOSS, ms: 1000 });

		const result = report(await pending);
		expect(result.header).toBe("ran in 3 consoles in 1.0 s · 2 failed");
		expect(result.blocks).toEqual([
			{ machine: "node1", hue: 1, status: { kind: "exit", code: 1 }, lastLine: LOSS, focus: "node1:console" },
			{ machine: "node2", hue: 2, status: { kind: "exit", code: 1 }, lastLine: LOSS, focus: "node2:console" },
			{ machine: "node3", hue: 3, status: { kind: "exit", code: 0 }, lastLine: OK, focus: "node3:console" },
			{ machine: "node4", hue: 4, status: { kind: "skipped", reason: "still booting" }, lastLine: "", focus: null },
		]);
		expect(result.data).toMatchObject({
			ran: [{ session: "node1:console", exitCode: 1, output: LOSS, ms: 1000 }, {}, {}],
			skipped: [{ target: "node4", reason: "still booting" }],
		});
		expect(lab.events).toContainEqual(expect.objectContaining({ type: "cmd/logged", line: `exec all -- ${PING}` }));
	});

	it("skips a session that is running a program, and says so in the preview", async () => {
		const { lab } = await threeReady();
		lab.runtime({ type: "session/shell", session: "node2:console", shell: "running" });
		expect(lab.parsed("exec all -- uname").preview(lab.store.state)).toEqual({
			will: "run `uname` in node1 and node3 · skipped node2:console: running a program",
			assumed: null,
			tone: "plain",
		});
		lab.runtime(
			{ type: "session/shell", session: "node1:console", shell: "running" },
			{ type: "session/shell", session: "node3:console", shell: "running" },
		);
		expect(lab.parsed("exec all -- uname").validate(lab.store.state)).toEqual({
			message:
				"exec wants a session at its prompt here, and node1:console is running a program, node2:console is running a program and node3:console is running a program. Nothing was changed.",
			token: 1,
		});
	});

	it("reports a session the runtime finds busy as skipped, in the runtime's sentence", async () => {
		const { lab, calls } = await threeReady();
		const pending = lab.run("exec node1,node2 -- uname");
		calls[0].reject(new Error("node1:console is busy running top."));
		calls[1].resolve({ exitCode: null, output: "Linux", truncated: false, lastLine: "Linux", ms: 5 });
		const result = report(await pending);
		expect(result.header).toBe("ran in 1 console in 0.0 s");
		expect(result.blocks.map((b) => [b.machine, b.status])).toEqual([
			["node2", { kind: "unknown" }],
			["node1", { kind: "skipped", reason: "node1:console is busy running top." }],
		]);
	});

	it("fails in the runtime's sentence when the line was typed into no session", async () => {
		const { lab, calls } = await threeReady();
		const one = lab.run("exec node1 -- uname", "agent");
		calls[0].reject(new Error("node1:console has a half-typed line, so finish it there or use another session."));
		expect(await one).toEqual({
			kind: "failed",
			error: { message: "node1:console has a half-typed line, so finish it there or use another session." },
		});
		expect(lab.events.at(-1)).toMatchObject({ type: "cmd/logged", line: "exec node1 -- uname", outcome: "failed" });

		lab.runtime({ type: "vm/halted", machine: "node3", attempt: 1, next: "off", closed: [] });
		const two = lab.run("exec node1,node2,node3 -- uname");
		calls[1].reject(new Error("node1:console is not open, so use another session."));
		calls[2].reject(new Error("node2 stopped before the command returned."));
		expect(await two).toMatchObject({
			kind: "failed",
			error: {
				message:
					"node1:console is not open, so use another session; node2 stopped before the command returned; node3 is off.",
			},
		});
	});

	it("keeps the last whole lines of a long output and flags it, as it does one the terminal already cut", async () => {
		const { lab, calls } = await threeReady();
		const pending = lab.run("exec all -- seq 1 20000");
		const numbers = Array.from({ length: 20_000 }, (_, i) => String(i + 1));
		const long = numbers.join("\n");
		calls[0].resolve({ exitCode: 0, output: long, truncated: false, lastLine: "20000", ms: 1 });
		calls[1].resolve({ exitCode: 0, output: "last", truncated: true, lastLine: "last", ms: 1 });
		calls[2].resolve({ exitCode: 0, output: "y".repeat(16_000), truncated: false, lastLine: "y", ms: 1 });
		expect(report(await pending).data).toMatchObject({
			ran: [
				{ output: numbers.slice(-2666).join("\n"), truncated: true },
				{ output: "last", truncated: true },
				{ output: "y".repeat(16_000), truncated: false },
			],
		});
	});

	it("types into a named session, or a machine's active one", async () => {
		const { lab, calls } = await threeReady();
		await lab.run("sh node1");
		await lab.run("focus node1:console");
		expect(lab.parsed("exec node1:sh1,node2 -- id").preview(lab.store.state)).toMatchObject({
			will: "run `id` in node1:sh1 and node2",
		});
		void lab.run("exec node1:sh1,node2 -- id");
		expect(calls.map((c) => c.session)).toEqual(["node1:sh1", "node2:console"]);
	});

	it("stops waiting when the caller aborts, and logs the line as failed", async () => {
		const { lab } = await threeReady();
		const controller = new AbortController();
		const line = lab.parsed("exec node1 -- sleep 100");
		if (line.danger) throw new Error("exec is safe");
		const pending = line.run({ source: "agent", signal: controller.signal });
		controller.abort(new Error("The agent stopped waiting."));
		await expect(pending).rejects.toThrow("The agent stopped waiting.");
		expect(lab.events.at(-1)).toMatchObject({ type: "cmd/logged", outcome: "failed", source: "agent" });
	});

	it("wants a command after -- and machines that are there", async () => {
		const exec = manualExec();
		const lab = storeLab(exec.port);
		await lab.lab(1);
		expect(lab.parse("exec all")).toEqual({ message: "exec wants a command after --. Nothing was changed." });
		expect(lab.parse("exec nod1 -- ls")).toEqual({
			message: "No machine is called nod1, so use node1. Nothing was changed.",
			token: 1,
			fix: "exec node1 -- ls",
		});
		expect(lab.parse("exec node1:sh4 -- ls")).toEqual({
			message: "node1 has no session called sh4, so use console. Nothing was changed.",
			token: 1,
		});
	});

	it("completes machines, sessions after a colon, and the rest of a list", async () => {
		const { lab } = await threeReady();
		await lab.run("sh node1");
		const at = (line: string) => completeLine(lab.registry, line, line.length, lab.store.state);
		expect(at("exec ").suggestions.map((s) => s.insert)).toEqual(["node1", "node2", "node3", "all"]);
		expect(at("exec node1:").suggestions.map((s) => s.insert)).toEqual(["node1:console", "node1:sh1"]);
		expect(at("exec node2,node1:s").suggestions.map((s) => s.insert)).toEqual(["node2,node1:sh1"]);
		expect(at("exec node2,").suggestions.map((s) => s.insert)).toEqual(["node2,node1", "node2,node3"]);
	});

	it("is the shell_exec tool, marked untrusted", () => {
		const { tool } = storeLab().registry.find("exec") ?? {};
		expect(tool).toMatchObject({ name: "shell_exec", policy: "run", annotations: { untrustedContentHint: true } });
		expect(tool?.toLine({ targets: "node1", command: "uname -a" })).toBe("exec node1 -- uname -a");
	});
});
