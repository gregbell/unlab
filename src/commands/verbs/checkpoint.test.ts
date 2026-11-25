import { describe, expect, it } from "vitest";
import { port0 } from "../../../test/support/ports.ts";
import { storeLab } from "../testing/store.ts";
import { isLineError } from "../types.ts";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

type Lab = ReturnType<typeof storeLab>;

async function saved(lab: Lab, name: string, set: number, bytes = 12.5 * 2 ** 20): Promise<void> {
	await lab.run(`checkpoint node1 ${name}`);
	lab.runtime({ type: "checkpoint/saved", machine: "node1", attempt: 1, set, bytes });
}

async function oneMachine(): Promise<Lab> {
	const lab = storeLab();
	await lab.lab(1);
	return lab;
}

const message = (lab: Lab, line: string): unknown => {
	const read = lab.parse(line);
	if (isLineError(read)) return read.message;
	return read.validate(lab.store.state)?.message;
};

function confirm(lab: Lab, line: string) {
	const read = lab.parsed(line);
	if (!read.danger) throw new Error(`${line} is safe`);
	return read.confirm(lab.store.state);
}

describe("checkpoint", () => {
	it("says what it will save, and is done for a person when it starts and for an agent when it is saved", async () => {
		const lab = await oneMachine();
		expect(lab.parsed("checkpoint node1 before").preview(lab.store.state)).toMatchObject({
			will: "save node1's disk as checkpoint before",
			tone: "plain",
		});
		expect(await lab.run("checkpoint node1 before")).toMatchObject({ kind: "visible", text: "saving before of node1" });
		lab.runtime({ type: "checkpoint/saved", machine: "node1", attempt: 1, set: 1, bytes: 2 ** 20 });

		let answer: unknown;
		void lab.run("checkpoint node1 after", "agent").then((result) => {
			answer = result;
		});
		lab.runtime({ type: "checkpoint/progress", machine: "node1", attempt: 1, set: 2, percent: 50 });
		await turn();
		expect(answer).toBeUndefined();
		lab.runtime({ type: "checkpoint/saved", machine: "node1", attempt: 1, set: 2, bytes: 2 ** 21 });
		await turn();
		expect(answer).toEqual({
			kind: "visible",
			text: "saved after of node1 · 2.0 MiB",
			data: { machine: "node1", name: "after", bytes: 2 ** 21 },
		});
		expect(await lab.run("ls")).toMatchObject({
			blocks: [{ lastLine: expect.stringContaining("checkpoints before 1.0 MiB, after 2.0 MiB") }],
			data: [
				{
					checkpoints: [
						{ name: "before", bytes: 2 ** 20 },
						{ name: "after", bytes: 2 ** 21 },
					],
				},
			],
		});
	});

	it("answers an agent with why it could not be saved, or that the machine went", async () => {
		const lab = await oneMachine();
		const reason = "Browser storage is full, so checkpoint before of node1 could not be saved.";
		const full = lab.run("checkpoint node1 before", "agent");
		lab.runtime({ type: "checkpoint/unsaved", machine: "node1", attempt: 1, set: 1, reason });
		expect(await full).toMatchObject({ kind: "failed", error: { message: `${reason} Nothing was changed.` } });
		for (const go of [
			() => lab.runtime({ type: "vm/halted", machine: "node1", attempt: 1, next: "reboot", closed: [] }),
			() => lab.store.dispatchCommand({ type: "cmd/remove", machines: ["node1"], cause: "bar" }),
		]) {
			const cut = lab.run("checkpoint node1 cut", "agent");
			await turn();
			go();
			expect(await cut).toMatchObject({
				kind: "failed",
				error: { message: "node1 stopped before checkpoint cut was saved. Nothing was changed." },
			});
			lab.runtime({ type: "vm/ready", machine: "node1", attempt: 2, bootMs: 1 });
		}
	});

	it("refuses a name it cannot have, and a machine that is busy or not there to save", async () => {
		const lab = await oneMachine();
		await saved(lab, "before", 1);
		expect(message(lab, "checkpoint node1 before")).toBe(
			"node1 already has a checkpoint called before, so choose another name, or delete it with forget. Nothing was changed.",
		);
		expect(message(lab, "checkpoint node1 Before")).toBe(
			"A checkpoint's name is in lowercase letters, so use before. Nothing was changed.",
		);
		expect(message(lab, "checkpoint node1 be_fore")).toContain("checkpoint wants a name of lowercase letters");
		expect(message(lab, `checkpoint node1 ${"a".repeat(64)}`)).toContain("at most 63 characters, and that is 64");
		await lab.run("checkpoint node1 third");
		const busy = "node1 is saving checkpoint third, so wait until it is done. Nothing was changed.";
		for (const line of ["checkpoint node1 fourth", "restore node1 before", "poweroff node1", "reboot all"]) {
			expect(message(lab, line), line).toBe(busy);
		}
		expect(await lab.run("ls")).toMatchObject({ data: [{ saving: "third" }] });
		await lab.run("spawn 1 alpine");
		expect(message(lab, "checkpoint node2 a")).toBe(
			"checkpoint wants a ready or off machine here, and node2 is still booting. Nothing was changed.",
		);
	});
});

describe("restore", () => {
	it("asks what it discards, and an agent's is done when the machine is ready or has failed", async () => {
		const lab = await oneMachine();
		await saved(lab, "before", 1);
		await lab.run("sh node1");
		const checkpoints = [{ name: "before", set: 1, bytes: 12.5 * 2 ** 20 }];
		const machines = [{ n: 1, name: "node1" }];
		const gone = "Everything written to its disk since checkpoint before was saved is gone. There is no undo.";
		expect(confirm(lab, "restore node1 before")).toEqual({
			question: "Restore node1 to before?",
			detail: `node1 stops without shutting down, so what it runs is lost and 1 shell closes. ${gone}`,
			actionLabel: "Restore node1 to before",
			machines,
			checkpoints,
		});
		expect(lab.parsed("restore node1 before").preview(lab.store.state)).toMatchObject({
			will: "put node1's disk back to checkpoint before and boot it",
			tone: "warn",
		});
		await lab.run("poweroff node1");
		expect(confirm(lab, "restore node1 before")).toMatchObject({ detail: gone });
		expect(message(lab, "restore node1 after")).toBe(
			"node1 has no checkpoint called after, so use before. Nothing was changed.",
		);
	});
});

describe("forget", () => {
	it("asks, frees the checkpoint's storage, and leaves one that is being gone back to", async () => {
		const lab = await oneMachine();
		await saved(lab, "before", 1);
		expect(confirm(lab, "forget node1 before")).toMatchObject({
			question: "Delete checkpoint before of node1?",
			checkpoints: [{ set: 1 }],
		});
		expect(lab.parsed("forget node1 before").preview(lab.store.state)).toMatchObject({
			will: "delete checkpoint before of node1 · frees 12.5 MiB",
		});
		lab.store.dispatchCommand({ type: "cmd/restore", plan: { machine: "node1", set: 1, ports: [port0(1)] } });
		expect(message(lab, "forget node1 before")).toBe(
			"node1 is being restored to before, so wait until it has been. Nothing was changed.",
		);
	});
});

describe("rm", () => {
	it("says which checkpoints go with the machines", async () => {
		const lab = storeLab();
		await lab.lab(2);
		await saved(lab, "before", 1);
		expect(confirm(lab, "rm node1")).toMatchObject({
			detail: expect.stringContaining("disk is gone. Its checkpoint before is deleted too. There is no undo."),
		});
		await saved(lab, "after", 2);
		expect(confirm(lab, "rm all")).toMatchObject({
			detail: expect.stringContaining("node1's checkpoints before and after are deleted too. There is no undo."),
		});
	});
});
